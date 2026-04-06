// ═══════════════════════════════════════════════════════════════
// prisscanner-worker.js
// Cloudflare Worker
//
// Endepunkter:
//   GET  /lookup?ean=...   → KV-cache → OFF → svar
//   POST /identify         → Claude Haiku vision → KV-cache → svar
//   GET  /food?name=...    → Matvaretabell fuzzy-søk
//
// Miljøvariabler (Cloudflare secrets/bindings):
//   - ANTHROPIC_API_KEY   (secret)
//   - EAN_CACHE           (KV namespace binding)
//   - FOOD_DATA           (KV namespace binding — matvaretabell)
//
// Scheduled trigger: månedlig oppdatering av matvaretabell
// ═══════════════════════════════════════════════════════════════

const CORS_HEADERS = (origin) => ({
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": origin || "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
});

// ── Matvaretabell — månedlig oppdatering ─────────────────────
async function updateMatvaretabell(env) {
  try {
    const res = await fetch("https://www.matvaretabellen.no/alle-matvarer.xlsx", {
      headers: { "User-Agent": "forbruker.app/1.0" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);

    // Excel-parsing i Worker er ikke mulig direkte —
    // vi bruker JSON-API-en til matvaretabellen i stedet
    // Hent JSON-datasettet som Mattilsynet publiserer
    const jsonRes = await fetch("https://www.matvaretabellen.no/api/nb/foods.json", {
      headers: { "User-Agent": "forbruker.app/1.0" },
    });

    if (!jsonRes.ok) throw new Error("JSON API HTTP " + jsonRes.status);
    const foods = await jsonRes.json();

    // Lagre hele datasettet som én KV-verdi
    // foods er et array av matvare-objekter
    await env.FOOD_DATA.put("all_foods", JSON.stringify(foods), {
      expirationTtl: 60 * 60 * 24 * 40, // 40 dager
    });

    // Bygg også søkeindeks: navn (lowercase) → id
    const index = {};
    for (const food of foods) {
      const key = (food.name?.nb || food.name || "").toLowerCase().trim();
      if (key) index[key] = food.id || food.foodId;
    }
    await env.FOOD_DATA.put("search_index", JSON.stringify(index), {
      expirationTtl: 60 * 60 * 24 * 40,
    });

    return { updated: foods.length };
  } catch (e) {
    return { error: e.message };
  }
}

// ── Matvaretabell — fuzzy-søk på navn ────────────────────────
async function searchFoodData(name, env) {
  try {
    const indexRaw = await env.FOOD_DATA.get("search_index");
    if (!indexRaw) return null;
    const index = JSON.parse(indexRaw);

    const query = name.toLowerCase().trim();

    // 1. Eksakt treff
    if (index[query]) {
      return await getFoodById(index[query], env);
    }

    // 2. Starter med søkeord
    const startsWithKey = Object.keys(index).find(k => k.startsWith(query));
    if (startsWithKey) {
      return await getFoodById(index[startsWithKey], env);
    }

    // 3. Inneholder søkeord
    const containsKey = Object.keys(index).find(k => k.includes(query));
    if (containsKey) {
      return await getFoodById(index[containsKey], env);
    }

    return null;
  } catch {
    return null;
  }
}

async function getFoodById(id, env) {
  try {
    const allRaw = await env.FOOD_DATA.get("all_foods");
    if (!allRaw) return null;
    const all = JSON.parse(allRaw);
    const food = all.find(f => (f.id || f.foodId) === id);
    if (!food) return null;
    return formatFoodData(food);
  } catch {
    return null;
  }
}

function formatFoodData(food) {
  // Normaliser felt fra Matvaretabellen-formatet
  const name = food.name?.nb || food.name || null;
  const nutrients = food.nutrients || food.constituents || {};

  // Hent nøkkelnæringsstoffer per 100g
  const get = (keys) => {
    for (const k of keys) {
      const v = nutrients[k];
      if (v !== undefined && v !== null) return parseFloat(v) || null;
    }
    return null;
  };

  return {
    name,
    category: food.foodGroup?.name?.nb || food.category || null,
    per100g: {
      energyKcal: get(["Energi (kcal)", "energy_kcal", "energiKcal", "Kcal"]),
      protein:    get(["Protein", "protein"]),
      fat:        get(["Fett", "fat"]),
      carbs:      get(["Karbohydrat", "carbohydrates", "karbohydrater"]),
      fiber:      get(["Kostfiber", "fiber", "kostfiber"]),
      salt:       get(["Salt", "salt"]),
      sugar:      get(["Sukkerarter", "sugars", "sukker"]),
    },
    source: "Matvaretabellen / Helsedirektoratet & Mattilsynet",
    note: "Verdiene gjelder matvaregruppen, ikke nødvendigvis dette eksakte produktet.",
  };
}

// ── Scheduled: månedlig matvaretabell-oppdatering ────────────
export const scheduled = {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(updateMatvaretabell(env));
  },
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    // ── CORS preflight ──────────────────────────────────────
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS(origin) });
    }

    const url = new URL(request.url);

    // ── /identify — Claude vision på produktbilde ───────────
    if (request.method === "POST" && url.pathname.endsWith("/identify")) {
      return handleIdentify(request, env, origin);
    }

    // ── /food?name=... — matvaretabell-søk ──────────────────
    if (request.method === "GET" && url.pathname.endsWith("/food")) {
      const name = url.searchParams.get("name")?.trim();
      if (!name) {
        return new Response(JSON.stringify({ error: "Mangler name" }), {
          status: 400, headers: CORS_HEADERS(origin),
        });
      }
      // Sjekk om FOOD_DATA er satt opp
      if (!env.FOOD_DATA) {
        return new Response(JSON.stringify({ error: "FOOD_DATA KV ikke konfigurert" }), {
          status: 503, headers: CORS_HEADERS(origin),
        });
      }
      const food = await searchFoodData(name, env);
      return new Response(JSON.stringify(food || { found: false }), {
        headers: CORS_HEADERS(origin),
      });
    }

    // ── /admin/update-food — manuell trigger av matvaretabell ──
    if (request.method === "GET" && url.pathname.endsWith("/admin/update-food")) {
      const result = await updateMatvaretabell(env);
      return new Response(JSON.stringify(result), {
        headers: CORS_HEADERS(origin),
      });
    }

    // ── Kun GET for /lookup ──────────────────────────────────
    if (request.method !== "GET") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: CORS_HEADERS(origin),
      });
    }

    // ── Hent EAN fra URL: /lookup?ean=7038010009801 ─────────
    const ean = url.searchParams.get("ean")?.trim();

    if (!ean || !/^\d{6,14}$/.test(ean)) {
      return new Response(JSON.stringify({ error: "Ugyldig EAN" }), {
        status: 400,
        headers: CORS_HEADERS(origin),
      });
    }

    // ════════════════════════════════════════════════════════
    // STEG 1 — KV-cache
    // ════════════════════════════════════════════════════════
    try {
      const cached = await env.EAN_CACHE.get(ean);
      if (cached) {
        const data = JSON.parse(cached);
        data._source = "cache";
        return new Response(JSON.stringify(data), {
          headers: CORS_HEADERS(origin),
        });
      }
    } catch (e) {
      // KV utilgjengelig — fortsett
    }

    // ════════════════════════════════════════════════════════
    // STEG 2 — Open Food Facts (gratis, ingen nøkkel)
    // ════════════════════════════════════════════════════════
    let product = null;

    try {
      const offRes = await fetch(
        `https://world.openfoodfacts.org/api/v2/product/${ean}?fields=product_name,brands,categories_tags,nutriscore_grade,ecoscore_grade,quantity`,
        { headers: { "User-Agent": "prisscanner/1.0 (forbruker.app)" } }
      );
      const offData = await offRes.json();

      if (offData.status === 1 && offData.product?.product_name) {
        const p = offData.product;
        const category = (p.categories_tags || [])
          .map((c) => c.replace(/^[a-z]{2}:/, "").replace(/-/g, " "))
          .filter((c) => !c.includes(":"))
          .slice(0, 1)[0] || null;

        product = {
          ean,
          name: p.product_name,
          brand: p.brands || null,
          category,
          quantity: p.quantity || null,
          nutriscore: p.nutriscore_grade?.toUpperCase() || null,
          ecoscore: p.ecoscore_grade?.toUpperCase() || null,
          emoji: categoryEmoji(p.categories_tags || []),
          searchQuery: [p.brands, p.product_name].filter(Boolean).join(" "),
          description: null,
          confidence: "high",
          _source: "openfoodfacts",
        };
      }
    } catch (e) {
      // OFF utilgjengelig — fortsett til Claude
    }

    // ════════════════════════════════════════════════════════
    // STEG 3 — Claude (kun hvis OFF ikke fant noe)
    // ════════════════════════════════════════════════════════
    if (!product && env.ANTHROPIC_API_KEY) {
      try {
        const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001", // Haiku: billigst, rask nok for dette
            max_tokens: 300,
            system: `Produktekspert. Returner KUN gyldig JSON, ingen markdown:
{
  "name": "produktnavn",
  "brand": "merke eller null",
  "category": "kategori eller null",
  "emoji": "ett emoji",
  "searchQuery": "3-6 ord for norsk nettbutikksøk",
  "description": "1 setning på norsk eller null",
  "confidence": "high|medium|low"
}`,
            messages: [{ role: "user", content: `EAN: ${ean}` }],
          }),
        });

        const claudeData = await claudeRes.json();
        const text = claudeData.content?.[0]?.text || "{}";
        const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());

        product = {
          ean,
          ...parsed,
          nutriscore: null,
          ecoscore: null,
          quantity: null,
          _source: "claude",
        };
      } catch (e) {
        // Claude feilet
      }
    }

    // ════════════════════════════════════════════════════════
    // Fallback — returner bare EAN
    // ════════════════════════════════════════════════════════
    if (!product) {
      product = {
        ean,
        name: null,
        brand: null,
        category: null,
        emoji: "📦",
        searchQuery: ean,
        description: null,
        confidence: "low",
        nutriscore: null,
        ecoscore: null,
        quantity: null,
        _source: "unknown",
      };
    }

    // ════════════════════════════════════════════════════════
    // Lagre i KV (cache for alltid — produktdata endres ikke)
    // Ikke cache "unknown" — prøv igjen neste gang
    // ════════════════════════════════════════════════════════
    if (product._source !== "unknown") {
      try {
        await env.EAN_CACHE.put(ean, JSON.stringify(product));
      } catch (e) {
        // KV write feilet — ikke kritisk
      }
    }

    return new Response(JSON.stringify(product), {
      headers: CORS_HEADERS(origin),
    });
  },
};

// ── /identify — Claude Haiku vision ─────────────────────────
async function handleIdentify(request, env, origin) {
  if (!env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: "Ingen API-nøkkel" }), {
      status: 500, headers: CORS_HEADERS(origin),
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Ugyldig JSON" }), {
      status: 400, headers: CORS_HEADERS(origin),
    });
  }

  const { ean, image } = body;
  if (!image) {
    return new Response(JSON.stringify({ error: "Mangler bilde" }), {
      status: 400, headers: CORS_HEADERS(origin),
    });
  }

  try {
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: `Du ser et produktbilde. Returner KUN gyldig JSON, ingen markdown:
{
  "name": "produktnavn",
  "brand": "merke eller null",
  "category": "kategori på norsk eller null",
  "searchQuery": "3-6 ord optimalt for norsk nettbutikksøk",
  "description": "1 setning på norsk eller null",
  "confidence": "high|medium|low"
}
Hvis du ikke kan identifisere produktet, returner { "confidence": "low", "name": null }.`,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: image,
              },
            },
            {
              type: "text",
              text: ean ? `EAN-kode: ${ean}. Hva er dette produktet?` : "Hva er dette produktet?",
            },
          ],
        }],
      }),
    });

    const claudeData = await claudeRes.json();
    const text = claudeData.content?.[0]?.text || "{}";
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());

    // Cache i KV hvis vi fikk et godt svar og har EAN
    if (ean && parsed.name && parsed.confidence !== "low") {
      const toCache = {
        ean,
        name: parsed.name,
        brand: parsed.brand || null,
        category: parsed.category || null,
        emoji: "📦",
        searchQuery: parsed.searchQuery || parsed.name,
        description: parsed.description || null,
        confidence: parsed.confidence,
        nutriscore: null, ecoscore: null, quantity: null,
        _source: "claude-vision",
      };
      try {
        await env.EAN_CACHE.put(ean, JSON.stringify(toCache));
      } catch {}
    }

    return new Response(JSON.stringify(parsed), {
      headers: CORS_HEADERS(origin),
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, name: null }), {
      status: 500, headers: CORS_HEADERS(origin),
    });
  }
}

// ── Kategori → emoji ──────────────────────────────────────────
function categoryEmoji(tags) {
  const joined = tags.join(" ").toLowerCase();
  const map = [
    [/beverages|drinks|juice|water|soda|sodavann/, "🥤"],
    [/milk|dairy|cheese|yogurt|melk|ost|meieri/, "🥛"],
    [/bread|bakery|biscuit|cracker|brød|bakeri/, "🍞"],
    [/chocolate|candy|sweets|konfekt|sjokolade/, "🍫"],
    [/meat|poultry|chicken|beef|pork|kjøtt|kylling/, "🥩"],
    [/fish|seafood|salmon|tuna|fisk|sjømat/, "🐟"],
    [/fruit|apple|orange|berry|frukt/, "🍎"],
    [/vegetables|vegetable|salad|grønnsak/, "🥦"],
    [/snacks|chips|crisps|nuts|nøtter/, "🍟"],
    [/coffee|tea|cocoa|kaffe|te/, "☕"],
    [/pasta|noodles|rice|grains|ris/, "🍝"],
    [/sauce|condiment|ketchup|mustard|saus/, "🫙"],
    [/frozen|ice.cream|fryst|iskrem/, "🍦"],
    [/oil|fat|butter|olje|smør/, "🧈"],
    [/cleaning|detergent|vask|rengjøring/, "🧹"],
    [/personal.care|hygiene|hygiene|hår/, "🧴"],
  ];
  for (const [rx, em] of map) {
    if (rx.test(joined)) return em;
  }
  return "📦";
}
