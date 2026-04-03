// ═══════════════════════════════════════════════════════════════
// prisscanner-worker.js
// Cloudflare Worker med KV-cache for EAN-oppslag
//
// Flyt:
//   1. Sjekk KV-cache → returner hvis treff
//   2. Spør Open Food Facts → lagre i KV hvis treff
//   3. Spør Claude som siste utvei → lagre permanent i KV
//
// Miljøvariabler som må settes i Cloudflare:
//   - ANTHROPIC_API_KEY  (secret)
//   - EAN_CACHE          (KV namespace binding)
// ═══════════════════════════════════════════════════════════════

const CORS_HEADERS = (origin) => ({
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": origin || "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
});

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    // ── CORS preflight ──────────────────────────────────────
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS(origin) });
    }

    // ── Kun GET tillatt ─────────────────────────────────────
    if (request.method !== "GET") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: CORS_HEADERS(origin),
      });
    }

    // ── Hent EAN fra URL: /lookup?ean=7038010009801 ─────────
    const url = new URL(request.url);
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
