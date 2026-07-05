// Google web-service proxy (Elevation / Geocoding / Places) — server key stays hidden.
// Set GOOGLE_API_KEY in Netlify env vars. Use a key WITHOUT website restriction
// (restrict it by API instead: Elevation, Geocoding, Places APIs only).
const RATE_LIMIT = 60, WINDOW_MS = 3600000, hits = new Map();
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: JSON.stringify({ error: { message: "POST only" } }) };
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return { statusCode: 500, body: JSON.stringify({ error: { message: "GOOGLE_API_KEY not set on server" } }) };
  const ip = (event.headers["x-forwarded-for"] || "?").split(",")[0].trim();
  const now = Date.now();
  const rec = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (rec.length >= RATE_LIMIT) return { statusCode: 429, body: JSON.stringify({ error: { message: "Rate limit" } }) };
  rec.push(now); hits.set(ip, rec); if (hits.size > 5000) hits.clear();
  try {
    const { type, params } = JSON.parse(event.body || "{}");
    const q = new URLSearchParams({ ...(params || {}), key }).toString();
    const urls = {
      elevation: `https://maps.googleapis.com/maps/api/elevation/json?${q}`,
      geocode: `https://maps.googleapis.com/maps/api/geocode/json?${q}`,
      places: `https://maps.googleapis.com/maps/api/place/nearbysearch/json?${q}`,
    };
    if (!urls[type]) return { statusCode: 400, body: JSON.stringify({ error: { message: "bad type" } }) };
    const r = await fetch(urls[type]);
    return { statusCode: r.status, headers: { "content-type": "application/json" }, body: await r.text() };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: { message: "Proxy error: " + e.message } }) };
  }
};
