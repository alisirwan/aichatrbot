// GORE Engineering — Gemini chatbot Edge function
// Deploy to Vercel. Route: /api/chat
// Env vars required: GEMINI_API_KEY, SHOPIFY_STORE_DOMAIN, SHOPIFY_STOREFRONT_TOKEN
// Optional env vars: CORS_ORIGIN (defaults to "*")

export const config = { runtime: 'edge' };

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent`;
const PRODUCT_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_WINDOW_MS = 60 * 1000;      // 60 seconds
const RATE_LIMIT_MAX = 10;                   // 10 requests per window
const PRODUCT_PAGE_SIZE = 100;               // GraphQL page size
const PRODUCT_HARD_CAP = 300;                // Safety cap on paginated fetch
const SUSPICIOUS_LOW_PRICE = 100;            // SEK — variants under this are suspect when max is above SUSPICIOUS_HIGH_PRICE
const SUSPICIOUS_HIGH_PRICE = 1000;          // SEK

// Module-scope cache (lives for the duration of the edge instance)
let productCache = { data: null, fetchedAt: 0 };
const rateBuckets = new Map(); // ip -> [timestamps]

const SYSTEM_PROMPT_BASE = `Du är en saklig och rak kundserviceassistent för GORE Engineering, en svensk leverantör av redskap och tillbehör till entreprenadmaskiner.

Regler:
- Svara på svenska som standard. Om användaren skriver på engelska, svara på engelska.
- Svara ENDAST på frågor om GORE-produkter, förbeställningar, erbjudanden, leverans, garanti och betalningssätt.
- Om frågan ligger utanför det området, svara ordagrant: "Jag kan bara svara på frågor om GORE-produkter. För andra frågor, prata med en av våra experter på +46 10 520 04 69."
- Röst: rak, operativ, utan reklamspråk. Inga tankstreck. Ingen "jag hjälper gärna till". Ingen marknadsföringsprosa.
- Om du är osäker på ett faktum, hänvisa till telefon: +46 10 520 04 69.
- Använd korta stycken. Punktlistor när det passar.
- Nämn aldrig att du är en AI eller hur du fungerar internt.
- När du anger priser från katalogen, säg alltid att de är startpris eller prisintervall ("från X kr" eller "X till Y kr"). Nämn aldrig ett enskilt pris som det enda priset utan kontext. Om priset i katalogen verkar misstänkt lågt för en yrkesmässig produkt, hänvisa kunden till produktsidan eller telefonsamtal istället för att läsa upp priset.
- När du nämner en specifik produkt från katalogen, skriv den alltid i formatet [Produktnamn](/products/handle) där handle är produktens exakta handle från katalogen. Widgeten renderar detta som en klickbar knapp som leder till produktsidan.
- When you mention a specific product from the catalogue, always write it in the format [Product Name](/products/handle) where handle is the product's exact handle. The widget renders this as a clickable button linking to the product page.`;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonError(status, message, origin) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

function getClientIp(req) {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-real-ip') || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const bucket = rateBuckets.get(ip) || [];
  const fresh = bucket.filter((t) => t > windowStart);
  if (fresh.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(ip, fresh);
    return false;
  }
  fresh.push(now);
  rateBuckets.set(ip, fresh);
  // Opportunistic cleanup to avoid unbounded growth
  if (rateBuckets.size > 5000) {
    for (const [key, stamps] of rateBuckets.entries()) {
      if (!stamps.some((t) => t > windowStart)) rateBuckets.delete(key);
    }
  }
  return true;
}

// Decide whether a variant is obvious junk (deposit / down-payment / placeholder)
// that would artificially drag the displayed min price below the real selling price.
function isJunkVariant(variant, fallbackMaxAmount) {
  if (!variant) return true;
  const title = String(variant.title || '').toLowerCase();
  const sku = String(variant.sku || '').toUpperCase();
  if (title.includes('handpenning')) return true;
  if (sku.startsWith('HP-')) return true;
  const amount = Number(variant?.price?.amount);
  if (Number.isFinite(amount) && amount > 0 && amount < SUSPICIOUS_LOW_PRICE) {
    const maxAmount = Number(fallbackMaxAmount);
    if (Number.isFinite(maxAmount) && maxAmount > SUSPICIOUS_HIGH_PRICE) {
      return true;
    }
  }
  return false;
}

function formatPriceRange(minAmount, maxAmount, currencyCode) {
  if (!Number.isFinite(minAmount) || !Number.isFinite(maxAmount)) return '';
  const cc = currencyCode || 'SEK';
  // Normalise: drop trailing ".00" for cleaner output
  const fmt = (n) => {
    const rounded = Math.round(n * 100) / 100;
    return Number.isInteger(rounded) ? String(rounded) : String(rounded);
  };
  if (minAmount === maxAmount) {
    return `${fmt(minAmount)} ${cc}`;
  }
  return `från ${fmt(minAmount)} till ${fmt(maxAmount)} ${cc}`;
}

async function fetchShopifyProducts() {
  const now = Date.now();
  if (productCache.data && now - productCache.fetchedAt < PRODUCT_CACHE_TTL_MS) {
    return productCache.data;
  }
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_STOREFRONT_TOKEN;
  if (!domain || !token) {
    return [];
  }

  const query = `query Products($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          title
          handle
          description
          productType
          tags
          priceRange {
            minVariantPrice { amount currencyCode }
            maxVariantPrice { amount currencyCode }
          }
          variants(first: 20) {
            nodes {
              sku
              title
              price { amount currencyCode }
            }
          }
        }
      }
    }
  }`;

  const collected = [];
  let cursor = null;
  let pageCount = 0;

  try {
    while (collected.length < PRODUCT_HARD_CAP) {
      const res = await fetch(`https://${domain}/api/2024-07/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Storefront-Access-Token': token,
        },
        body: JSON.stringify({
          query,
          variables: { first: PRODUCT_PAGE_SIZE, after: cursor },
        }),
      });
      if (!res.ok) {
        // Partial failure — return what we have, or fall back to the old cache.
        if (collected.length > 0) break;
        return productCache.data || [];
      }
      const json = await res.json();
      const page = json?.data?.products;
      if (!page) break;
      const edges = page.edges || [];
      for (const e of edges) {
        const n = e.node;
        if (!n) continue;

        // Use Shopify's computed priceRange as fallback and as a signal
        // for the suspicious-low filter.
        const shopifyMin = Number(n.priceRange?.minVariantPrice?.amount);
        const shopifyMax = Number(n.priceRange?.maxVariantPrice?.amount);
        const currencyCode = n.priceRange?.minVariantPrice?.currencyCode || 'SEK';

        // Filter out junk variants (handpenning/HP-/absurdly low) before computing min.
        const allVariants = n.variants?.nodes || [];
        const cleanVariants = allVariants.filter(
          (v) => !isJunkVariant(v, shopifyMax),
        );

        let effectiveMin;
        let effectiveMax;
        if (cleanVariants.length > 0) {
          const amounts = cleanVariants
            .map((v) => Number(v?.price?.amount))
            .filter((a) => Number.isFinite(a));
          if (amounts.length > 0) {
            effectiveMin = Math.min(...amounts);
            effectiveMax = Math.max(...amounts);
          }
        }
        // Fallback to Shopify-computed range if we filtered out everything.
        if (!Number.isFinite(effectiveMin) || !Number.isFinite(effectiveMax)) {
          effectiveMin = shopifyMin;
          effectiveMax = shopifyMax;
        }

        const price = formatPriceRange(effectiveMin, effectiveMax, currencyCode);
        const desc = (n.description || '').replace(/\s+/g, ' ').slice(0, 200);
        const productType = (n.productType || '').trim();
        const tags = Array.isArray(n.tags) ? n.tags.slice(0, 4).join(', ') : '';

        collected.push({
          title: n.title,
          handle: n.handle,
          price,
          desc,
          productType,
          tags,
        });
        if (collected.length >= PRODUCT_HARD_CAP) break;
      }
      pageCount++;
      if (!page.pageInfo?.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
      if (!cursor) break;
      // Safety: avoid runaway loop
      if (pageCount >= Math.ceil(PRODUCT_HARD_CAP / PRODUCT_PAGE_SIZE) + 1) break;
    }
    productCache = { data: collected, fetchedAt: now };
    return collected;
  } catch (err) {
    return productCache.data || [];
  }
}

function buildProductSummary(products) {
  if (!products || products.length === 0) {
    return 'Produktkatalog just nu ej tillgänglig. Hänvisa till +46 10 520 04 69 vid produktspecifika frågor.';
  }
  const lines = products.map((p) => {
    const priceTag = p.price ? ` — ${p.price}` : '';
    const typeTag = p.productType ? ` [${p.productType}]` : '';
    const tagsTag = p.tags ? ` (tags: ${p.tags})` : '';
    const descTag = p.desc ? ` — ${p.desc}` : '';
    return `- ${p.title} (/products/${p.handle})${typeTag}${priceTag}${tagsTag}${descTag}`;
  });
  return `Aktuell produktkatalog (${products.length} produkter). Handle efter "/products/" är produktens slug — använd alltid exakta handle-värden när du länkar till produktsidor:\n${lines.join('\n')}`;
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && typeof m === 'object' && typeof m.content === 'string')
    .slice(-12)
    .map((m) => ({
      role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user',
      parts: [{ text: String(m.content).slice(0, 4000) }],
    }));
}

export default async function handler(req) {
  const origin = process.env.CORS_ORIGIN || '*';

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== 'POST') {
    return jsonError(405, 'Method not allowed', origin);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return jsonError(500, 'Server not configured', origin);
  }

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return jsonError(429, 'Too many requests. Försök igen om en stund.', origin);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'Invalid JSON body', origin);
  }

  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return jsonError(400, 'Missing message', origin);
  }
  if (message.length > 2000) {
    return jsonError(400, 'Message too long', origin);
  }

  const history = sanitizeHistory(body.history);
  const products = await fetchShopifyProducts();
  const productSummary = buildProductSummary(products);
  const systemText = `${SYSTEM_PROMPT_BASE}\n\n${productSummary}`;

  const geminiPayload = {
    systemInstruction: { role: 'system', parts: [{ text: systemText }] },
    contents: [
      ...history,
      { role: 'user', parts: [{ text: message }] },
    ],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 400,
      topP: 0.9,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };

  let upstream;
  try {
    upstream = await fetch(`${GEMINI_ENDPOINT}?alt=sse&key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiPayload),
    });
  } catch (err) {
    return jsonError(502, 'Upstream unavailable', origin);
  }

  if (!upstream.ok || !upstream.body) {
    return jsonError(502, 'Upstream error', origin);
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      let buffer = '';
      const sendEvent = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const raw of lines) {
            const line = raw.trim();
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const parsed = JSON.parse(payload);
              const parts = parsed?.candidates?.[0]?.content?.parts || [];
              for (const part of parts) {
                if (typeof part.text === 'string' && part.text.length > 0) {
                  sendEvent('token', { text: part.text });
                }
              }
              const finishReason = parsed?.candidates?.[0]?.finishReason;
              if (finishReason && finishReason !== 'STOP' && finishReason !== 'FINISH_REASON_UNSPECIFIED') {
                sendEvent('meta', { finishReason });
              }
            } catch {
              // Ignore malformed SSE fragment; Gemini occasionally splits JSON
            }
          }
        }
        sendEvent('done', { ok: true });
      } catch (err) {
        sendEvent('error', { message: 'stream_interrupted' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...corsHeaders(origin),
    },
  });
}
