// Vercel serverless proxy — keeps your Anthropic API key server-side.
// Set ANTHROPIC_API_KEY in Vercel: Project → Settings → Environment Variables.
// Includes a soft per-IP rate limit (default 40 req/hour).
const RATE_LIMIT = 40;
const WINDOW_MS = 60 * 60 * 1000;
const hits = new Map();

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: { message: "POST only" } });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: { message: "ANTHROPIC_API_KEY not set on server" } });

  const ip = (req.headers["x-forwarded-for"] || "?").split(",")[0].trim();
  const now = Date.now();
  const rec = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (rec.length >= RATE_LIMIT) return res.status(429).json({ error: { message: "Rate limit reached — try again in a bit." } });
  rec.push(now); hits.set(ip, rec);
  if (hits.size > 5000) hits.clear();

  try {
    const body = req.body || {};
    body.max_tokens = Math.min(Number(body.max_tokens) || 1000, 1500);
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    res.status(r.status).json(await r.json());
  } catch (e) {
    res.status(502).json({ error: { message: "Proxy error: " + e.message } });
  }
}
