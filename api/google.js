const RATE_LIMIT = 60, WINDOW_MS = 3600000, hits = new Map();
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: { message: "POST only" } });
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return res.status(500).json({ error: { message: "GOOGLE_API_KEY not set on server" } });
  const ip = (req.headers["x-forwarded-for"] || "?").split(",")[0].trim();
  const now = Date.now();
  const rec = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (rec.length >= RATE_LIMIT) return res.status(429).json({ error: { message: "Rate limit" } });
  rec.push(now); hits.set(ip, rec); if (hits.size > 5000) hits.clear();
  try {
    const { type, params } = req.body || {};
    const q = new URLSearchParams({ ...(params || {}), key }).toString();
    const urls = {
      elevation: `https://maps.googleapis.com/maps/api/elevation/json?${q}`,
      geocode: `https://maps.googleapis.com/maps/api/geocode/json?${q}`,
      places: `https://maps.googleapis.com/maps/api/place/nearbysearch/json?${q}`,
    };
    if (!urls[type]) return res.status(400).json({ error: { message: "bad type" } });
    const r = await fetch(urls[type]);
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(502).json({ error: { message: "Proxy error: " + e.message } }); }
}
