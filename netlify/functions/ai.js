// Netlify serverless proxy — keeps your Anthropic API key server-side.
// Set ANTHROPIC_API_KEY in Netlify: Site settings → Environment variables.
// Includes a soft per-IP rate limit (default 40 req/hour) — adjust RATE_LIMIT below.
const RATE_LIMIT = 40;
const WINDOW_MS = 60 * 60 * 1000;
const hits = new Map(); // per warm instance; soft protection, good enough for v1

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: JSON.stringify({ error: { message: "POST only" } }) };
  if (!process.env.ANTHROPIC_API_KEY) return { statusCode: 500, body: JSON.stringify({ error: { message: "ANTHROPIC_API_KEY not set on server" } }) };

  const ip = (event.headers["x-forwarded-for"] || "?").split(",")[0].trim();
  const now = Date.now();
  const rec = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (rec.length >= RATE_LIMIT) return { statusCode: 429, body: JSON.stringify({ error: { message: "Rate limit reached — try again in a bit." } }) };
  rec.push(now); hits.set(ip, rec);
  if (hits.size > 5000) hits.clear();

  try {
    const body = JSON.parse(event.body || "{}");
    body.max_tokens = Math.min(Number(body.max_tokens) || 1000, 1500); // cost cap
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    const data = await r.text();
    return { statusCode: r.status, headers: { "content-type": "application/json" }, body: data };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: { message: "Proxy error: " + e.message } }) };
  }
};
