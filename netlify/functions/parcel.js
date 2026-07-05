// Regrid official-parcel proxy — token stays server-side (it's a PAID service;
// never expose it in the browser). Set REGRID_TOKEN in Netlify env vars.
const RATE_LIMIT = 20, WINDOW_MS = 3600000, hits = new Map();
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: JSON.stringify({ error: { message: "POST only" } }) };
  const token = process.env.REGRID_TOKEN;
  if (!token) return { statusCode: 500, body: JSON.stringify({ error: { message: "REGRID_TOKEN not set on server" } }) };
  const ip = (event.headers["x-forwarded-for"] || "?").split(",")[0].trim();
  const now = Date.now();
  const rec = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (rec.length >= RATE_LIMIT) return { statusCode: 429, body: JSON.stringify({ error: { message: "Rate limit" } }) };
  rec.push(now); hits.set(ip, rec); if (hits.size > 5000) hits.clear();
  try {
    const { lat, lon } = JSON.parse(event.body || "{}");
    const r = await fetch(`https://app.regrid.com/api/v2/parcels/point?lat=${Number(lat)}&lon=${Number(lon)}&token=${token}`);
    return { statusCode: r.status, headers: { "content-type": "application/json" }, body: await r.text() };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: { message: "Proxy error: " + e.message } }) };
  }
};
