const RATE_LIMIT = 20, WINDOW_MS = 3600000, hits = new Map();
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: { message: "POST only" } });
  const token = process.env.REGRID_TOKEN;
  if (!token) return res.status(500).json({ error: { message: "REGRID_TOKEN not set on server" } });
  const ip = (req.headers["x-forwarded-for"] || "?").split(",")[0].trim();
  const now = Date.now();
  const rec = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (rec.length >= RATE_LIMIT) return res.status(429).json({ error: { message: "Rate limit" } });
  rec.push(now); hits.set(ip, rec); if (hits.size > 5000) hits.clear();
  try {
    const { lat, lon } = req.body || {};
    const r = await fetch(`https://app.regrid.com/api/v2/parcels/point?lat=${Number(lat)}&lon=${Number(lon)}&token=${token}`);
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(502).json({ error: { message: "Proxy error: " + e.message } }); }
}
