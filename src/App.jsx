import { useState, useMemo, useRef, useEffect, Component } from "react";

/* ═════════════════════════════════════════════
   DREAM PROPERTY STUDIO — v2
   A working design tool, not a toy:
   · Drag-and-place blueprint site plan
   · Full catalog incl. landscaping (trees→flowers)
   · Room assignment + style notes per item
   · AI Design Director: describe it, it's implemented
   · Realtor listing / walkthrough generator
   · Saved projects (persistent)
   ═════════════════════════════════════════════ */

const fmt = (n) => "$" + Math.round(n).toLocaleString("en-US");
const ACRE_SQFT = 43560;

/* Sandboxed environments often HANG blocked requests instead of rejecting them.
   fetchT fails fast so fallbacks can kick in. */
const fetchT = (url, opts = {}, ms = 8000) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
};

/* tolerant JSON: works even if the model adds preamble or fences */
const pickJSON = (t) => JSON.parse((String(t).match(/\{[\s\S]*\}/) || [t])[0]);

/* ── API key (deployed-site mode) ──
   On your own site, AI calls go straight to the Anthropic API with your key.
   The key is stored only in this browser (localStorage). For public/production
   sites, route calls through a tiny serverless proxy instead of exposing a key. */
const getApiKey = () => { try { return localStorage.getItem("tapacasa_api_key") || ""; } catch { return ""; } };
const setApiKey = (k) => { try { localStorage.setItem("tapacasa_api_key", k.trim()); } catch { /* no-op */ } };
/* ══════════ SITE OWNER CONFIG ══════════
   To make this site turnkey for EVERY visitor (no key-pasting for them):
   1. AI features: deploy with the included serverless proxy and set the
      ANTHROPIC_API_KEY environment variable on Netlify/Vercel. NEVER put an
      Anthropic key below — it would be visible to visitors.
   2. Photoreal + HD imagery: paste your Google Maps key and Mapbox token
      below. These are DESIGNED to be public — just restrict them to your
      site's domain in each provider's dashboard (Google: key → Application
      restrictions → Websites; Mapbox: token → URL restrictions). */
const SITE_KEYS = {
  google: "AIzaSyDiASNmASU6JBNUfhswoySYFgCwfxn9fFI",
  mapbox: "pk.eyJ1IjoicG9zZXk2MjgiLCJhIjoiY21yODBycmYzMWhwbDJ4cHc1M3NsdzcyNCJ9.UiRU2R-Kky2X5joV54Jrhg",
  /* Accounts & cloud saves (free): supabase.com → new project → run the SQL in
     README → paste Project URL + anon public key here. Anon keys are designed
     to be public; row-level security keeps each user's data private. */
  supabaseUrl: "",
  supabaseAnon: "",
};

/* ── Supabase cloud accounts (email + password) ── */
const sbOn = () => !!(SITE_KEYS.supabaseUrl && SITE_KEYS.supabaseAnon);
const sbSession = { get: () => { try { return JSON.parse(localStorage.getItem("tapacasa_sb") || "null"); } catch { return null; } }, set: (v) => { try { v ? localStorage.setItem("tapacasa_sb", JSON.stringify(v)) : localStorage.removeItem("tapacasa_sb"); } catch { /* ok */ } } };
async function sbAuth(mode, email, password) {
  const url = mode === "up" ? `${SITE_KEYS.supabaseUrl}/auth/v1/signup` : `${SITE_KEYS.supabaseUrl}/auth/v1/token?grant_type=password`;
  const r = await fetchT(url, { method: "POST", headers: { apikey: SITE_KEYS.supabaseAnon, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) }, 12000);
  const d = await r.json();
  if (d.error || d.error_description || d.msg) throw new Error(d.error_description || d.msg || d.error?.message || "auth failed");
  const tok = d.access_token || d.session?.access_token;
  const user = d.user || d.session?.user;
  if (!tok) { if (mode === "up") return { needsConfirm: true }; throw new Error("no session"); }
  sbSession.set({ token: tok, email: user?.email || email, uid: user?.id });
  return { ok: true };
}
async function sbRest(path, opts = {}) {
  const ses = sbSession.get();
  const r = await fetchT(`${SITE_KEYS.supabaseUrl}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SITE_KEYS.supabaseAnon, Authorization: `Bearer ${ses?.token || SITE_KEYS.supabaseAnon}`, "Content-Type": "application/json", Prefer: "return=representation,resolution=merge-duplicates", ...(opts.headers || {}) },
  }, 12000);
  if (r.status === 401) { sbSession.set(null); throw new Error("session expired — sign in again"); }
  return r.status === 204 ? [] : r.json();
}
const cloudList = () => sbRest("projects?select=id,name,updated_at,data&order=updated_at.desc");
const cloudSave = (name, data) => sbRest("projects?on_conflict=user_id,name", { method: "POST", body: JSON.stringify({ name, data, updated_at: new Date().toISOString() }) });
const cloudDelete = (id) => sbRest(`projects?id=eq.${id}`, { method: "DELETE" });
const getK = (n) => { try { return localStorage.getItem("tapacasa_" + n) || SITE_KEYS[n] || ""; } catch { return SITE_KEYS[n] || ""; } };
const setK = (n, v) => { try { localStorage.setItem("tapacasa_" + n, (v || "").trim()); } catch { /* no-op */ } };
/* satellite tiles: Mapbox HD when a key is saved, Esri otherwise */
const satTileURL = (z, x, y) => getK("mapbox")
  ? `https://api.mapbox.com/v4/mapbox.satellite/${z}/${x}/${y}@2x.jpg90?access_token=${getK("mapbox")}`
  : `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
/* same-origin serverless helper (Netlify or Vercel function) */
async function svcFetch(name, payload, ms = 12000) {
  let lastErr;
  for (const ep of [`/.netlify/functions/${name}`, `/api/${name}`]) {
    try {
      const r = await fetchT(ep, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, ms);
      const d = await r.json();
      if (d.error) { lastErr = new Error(d.error.message || "svc error"); continue; }
      return d;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("no service");
}

/* share links: whole design encoded in the URL — no server needed */
const encodeShare = (l, p) => btoa(unescape(encodeURIComponent(JSON.stringify({ l, p })))).replace(/=+$/, "");
const decodeShare = (h) => JSON.parse(decodeURIComponent(escape(atob(h))));

/* one call path for every AI request — probes multiple request styles because
   different artifact runtimes accept different formats. Caches the winner. */
const AI_STRATEGIES = [
  { id: "proxy", run: async (content, ms) => {
      /* same-origin serverless proxy (Vercel /api/ai or Netlify function) — key stays server-side */
      const body = JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, messages: [{ role: "user", content }] });
      let lastErr;
      for (const ep of ["/api/ai", "/.netlify/functions/ai"]) {
        try {
          const res = await fetchT(ep, { method: "POST", headers: { "Content-Type": "application/json" }, body }, Math.min(ms, 25000));
          const data = await res.json();
          if (data.error) { lastErr = new Error(`${res.status}: ${data.error.message || "proxy error"}`); continue; }
          const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
          if (text) return text;
          lastErr = new Error("empty proxy response");
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error("no proxy available");
    } },
  { id: "key", run: async (content, ms) => {
      const k = getApiKey();
      if (!k) throw new Error("no API key saved");
      const res = await fetchT("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": k,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, messages: [{ role: "user", content }] }),
      }, ms);
      const data = await res.json();
      if (data.error) throw new Error(`${res.status}: ${data.error.message || "API error"}`);
      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (!text) throw new Error("empty response");
      return text;
    } },
  { id: "std", run: async (content, ms) => {
      const res = await fetchT("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, messages: [{ role: "user", content }] }),
      }, ms);
      const data = await res.json();
      if (data.error) throw new Error(`${res.status}: ${data.error.message || "API error"}`);
      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (!text) throw new Error("empty response");
      return text;
    } },
  { id: "blocks", run: async (content, ms) => {
      const res = await fetchT("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, messages: [{ role: "user", content: [{ type: "text", text: content }] }] }),
      }, ms);
      const raw = await res.text();
      let data; try { data = JSON.parse(raw); } catch { throw new Error(`${res.status}: non-JSON reply "${raw.slice(0, 80)}"`); }
      if (data.error) throw new Error(`${res.status}: ${data.error.message || "API error"}`);
      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (!text) throw new Error("empty response");
      return text;
    } },
  { id: "bridge", run: async (content) => {
      if (!(typeof window !== "undefined" && window.claude?.complete)) throw new Error("no window.claude bridge");
      const t = await window.claude.complete(content);
      if (!t) throw new Error("bridge empty reply");
      return typeof t === "string" ? t : JSON.stringify(t);
    } },
];

async function askAI(content, ms = 30000) {
  const w = typeof window !== "undefined" ? window : {};
  const order = w.__aiChannel
    ? [AI_STRATEGIES.find((s) => s.id === w.__aiChannel), ...AI_STRATEGIES.filter((s) => s.id !== w.__aiChannel)]
    : AI_STRATEGIES;
  const errs = [];
  for (const strat of order) {
    try {
      const text = await strat.run(content, ms);
      w.__aiChannel = strat.id;
      w.__aiDiag = `OK via ${strat.id}`;
      return text;
    } catch (e) {
      errs.push(`${strat.id}→${e?.message || "failed"}`);
    }
  }
  w.__aiDiag = errs.join(" · ");
  throw new Error(errs.join(" · "));
}

/* ─────────── LAND LISTINGS ─────────── */
const LISTINGS = [
  { id: "mt", name: "Bitterroot Valley Ranch", region: "Montana", acres: 40, price: 850000, taxRate: 0.0074, vibe: "Snow-capped peaks, trout stream on the east line" },
  { id: "ca", name: "Malibu Bluff Parcel", region: "California", acres: 2.3, price: 6200000, taxRate: 0.011, vibe: "180° Pacific views, private beach stair easement" },
  { id: "tx", name: "Hill Country Parcel", region: "Texas", acres: 12, price: 720000, taxRate: 0.018, vibe: "Live oaks, limestone bluff, no HOA" },
  { id: "nh", name: "Winnipesaukee Waterfront", region: "New Hampshire", acres: 1.8, price: 1450000, taxRate: 0.016, vibe: "310 ft of lake frontage, sunset exposure" },
  { id: "az", name: "Red Rock Mesa Lot", region: "Sedona, Arizona", acres: 5, price: 980000, taxRate: 0.006, vibe: "Elevated mesa, dark-sky zoning, canyon views" },
  { id: "ny", name: "Hudson Valley Acreage", region: "Upstate New York", acres: 25, price: 640000, taxRate: 0.017, vibe: "Rolling meadow, stone walls, 2 hrs from NYC" },
  { id: "hi", name: "Kona Coast Estate Lot", region: "Big Island, Hawaii", acres: 3, price: 1900000, taxRate: 0.003, vibe: "Lava-rock coastline, year-round trade winds" },
  { id: "co", name: "Alpine Meadow Tract", region: "Colorado Rockies", acres: 6, price: 2800000, taxRate: 0.0055, vibe: "Ski-out ridgeline, aspen grove, gated road" },
];

const RAND_PLACES = [
  ["Fjordside Bench", "Pacific Northwest", 0.009],
  ["High Desert Plateau", "New Mexico", 0.008],
  ["Lowcountry Marsh Point", "South Carolina", 0.0057],
  ["Golden Vineyard Slope", "Sonoma, California", 0.011],
  ["Emerald Hollow", "Tennessee Smokies", 0.0066],
  ["Sawtooth Overlook", "Idaho", 0.0069],
  ["Barrier Island Dune Lot", "Outer Banks, NC", 0.0082],
  ["Painted Canyon Rim", "Utah", 0.0058],
];
const randomListing = () => {
  const [name, region, taxRate] = RAND_PLACES[Math.floor(Math.random() * RAND_PLACES.length)];
  return {
    id: "rand-" + Date.now(), name, region, taxRate,
    acres: +(Math.random() * 38 + 1.5).toFixed(1),
    price: Math.round((Math.random() * 2400000 + 350000) / 5000) * 5000,
    vibe: "Surveyor's pick — unlisted parcel, coordinates on request", random: true,
  };
};

/* ─────────── CATALOG ───────────
   variants: [label, price, optional [w ft, d ft]]
   footprint set → draggable on site plan
   footprint null → interior spec, gets room + notes */
const CATALOG = [
  { cat: "Structure", items: [
    { id: "house", name: "Main Residence", vendor: "Meridian Design-Build", desc: "Architect-designed custom home, turnkey shell + systems", footprint: [70, 55], variants: [
      ["3,000 sq ft · $350/sq ft", 1050000, [55, 45]],
      ["5,000 sq ft · $360/sq ft", 1800000, [70, 55]],
      ["8,000 sq ft modern · $400/sq ft", 3200000, [95, 65]],
      ["12,000 sq ft estate · $450/sq ft", 5400000, [120, 80]],
    ]},
    { id: "guest", name: "Guest House", vendor: "Meridian Design-Build", desc: "Detached cottage with kitchenette", footprint: [30, 26], variants: [["800 sq ft cottage", 280000], ["1,400 sq ft casita", 460000, [40, 32]]] },
    { id: "garage", name: "Underground Garage", vendor: "Vaultworks Subterranean", desc: "Excavated basement-level garage, car-lift access", footprint: [45, 40], variants: [["4-car bay", 220000, [35, 30]], ["8-car showroom", 420000, [45, 40]], ["12-car collector vault", 640000, [60, 45]]] },
    { id: "barn", name: "Barn / Workshop", vendor: "Meridian Design-Build", desc: "Timber-frame barn, slab floor, power", footprint: [36, 48], variants: [["36×48 barn", 190000]] },
    { id: "solar", name: "Solar + Battery Array", vendor: "Heliostat Energy", desc: "Roof PV with whole-home backup", footprint: null, variants: [["18 kW + 2 batteries", 58000], ["30 kW off-grid ready", 96000]] },
    { id: "geo", name: "Geothermal HVAC", vendor: "Deepwell Comfort", desc: "Closed-loop ground-source heat/cool", footprint: null, variants: [["Standard loop field", 48000]] },
    { id: "smart", name: "Whole-Home Automation", vendor: "Quiet Circuit", desc: "Lighting, shades, security, AV backbone", footprint: null, variants: [["Core package", 38000], ["Full estate package", 85000]] },
    { id: "elev", name: "Residential Elevator", vendor: "Ascent Lifts", desc: "3-stop panoramic cab", footprint: null, variants: [["Glass cab, 3 stops", 46000]] },
  ]},
  { cat: "Amenities", items: [
    { id: "pool", name: "Swimming Pool", vendor: "Meridian Pool Co.", desc: "Gunite shell, autocover, heat pump", footprint: [20, 40], variants: [["Classic 16×36", 92000, [16, 36]], ["Infinity-edge 20×44", 185000, [20, 44]], ["Indoor natatorium", 460000, [30, 55]]] },
    { id: "bowl", name: "Bowling Alley", vendor: "Kingpin Lane Systems", desc: "Regulation lanes, pinsetters, scoring", footprint: [16, 92], variants: [["2 lanes", 125000, [16, 92]], ["4 lanes + lounge", 215000, [28, 96]]] },
    { id: "theater", name: "Home Theater", vendor: "Cinemascape Interiors", desc: "Acoustic room, laser projection, tiered seats", footprint: null, variants: [["8-seat Dolby setup", 85000], ["14-seat Atmos screening room", 240000]] },
    { id: "golf", name: "Mini Golf Course", vendor: "GreensKeeper Custom Golf", desc: "Themed holes, synthetic greens, lighting", footprint: [45, 80], variants: [["9-hole backyard course", 48000, [45, 80]], ["18-hole championship putt", 96000, [60, 120]]] },
    { id: "golfsim", name: "Golf Simulator Bay", vendor: "GreensKeeper Custom Golf", desc: "Launch monitor, impact screen, turf bay", footprint: null, variants: [["Single bay", 52000]] },
    { id: "court", name: "Indoor Sport Court", vendor: "Baseline Athletic Builds", desc: "Cushioned hardwood, hoops, net posts", footprint: [40, 70], variants: [["Half court", 78000, [40, 45]], ["Full court barn", 210000, [55, 100]]] },
    { id: "tennis", name: "Tennis Court", vendor: "Baseline Athletic Builds", desc: "Post-tension concrete, fencing, LEDs", footprint: [60, 120], variants: [["Hard court", 62000], ["Clay court", 88000]] },
    { id: "pickle", name: "Pickleball Court", vendor: "Baseline Athletic Builds", desc: "Cushioned acrylic, nets, lighting", footprint: [30, 60], variants: [["Single court", 32000]] },
    { id: "gym", name: "Home Gym", vendor: "Ironline Fitness Design", desc: "Rubber floors, rig, cardio wall, mirrors", footprint: null, variants: [["600 sq ft studio", 42000], ["1,200 sq ft performance gym", 90000]] },
    { id: "spa", name: "Spa Suite", vendor: "Stillwater Wellness", desc: "Sauna, steam, cold plunge, treatment room", footprint: null, variants: [["Sauna + cold plunge", 24000], ["Full spa suite", 78000]] },
    { id: "wine", name: "Wine Cellar", vendor: "Cellarcraft", desc: "Climate-controlled, stone + walnut racking", footprint: null, variants: [["600-bottle wall", 28000], ["1,500-bottle tasting cellar", 64000]] },
    { id: "pub", name: "Pub / Bar Room", vendor: "Coppertap Interiors", desc: "Millwork bar, taps, lounge seating", footprint: null, variants: [["Speakeasy bar", 68000]] },
    { id: "arcade", name: "Arcade & Game Room", vendor: "Coin-Op Curators", desc: "Cabinets, pinball, billiards, neon", footprint: null, variants: [["10-cabinet arcade", 36000]] },
    { id: "studio", name: "Recording Studio", vendor: "Soundframe Acoustics", desc: "Floated floor, iso booth, control room", footprint: null, variants: [["Project studio", 55000], ["Pro tracking suite", 140000]] },
    { id: "climb", name: "Climbing Wall", vendor: "Vertical Habitat", desc: "20-ft wall, auto-belay, crash matting", footprint: null, variants: [["Two-lane wall", 26000]] },
    { id: "green", name: "Greenhouse", vendor: "Glasshouse & Grove", desc: "Aluminum-frame Victorian greenhouse", footprint: [18, 30], variants: [["18×30 growing house", 38000]] },
    { id: "koi", name: "Koi Pond & Waterfall", vendor: "Stillwater Landscapes", desc: "Filtered pond, boulder waterfall, lights", footprint: [20, 25], variants: [["Garden pond", 19000]] },
  ]},
  { cat: "Landscaping", items: [
    { id: "oak", name: "Live Oak Tree", vendor: "Canopy & Root Nursery", desc: "Field-grown, craned in and planted, 1-yr warranty", footprint: [35, 35], variants: [["Sapling (10′ canopy)", 480, [10, 10]], ["15-yr specimen (25′)", 1650, [25, 25]], ["Mature 20-yr (35′ canopy)", 2600, [35, 35]]] },
    { id: "maple", name: "Japanese Maple", vendor: "Canopy & Root Nursery", desc: "Laceleaf, burgundy foliage, planted", footprint: [15, 15], variants: [["Specimen tree", 950]] },
    { id: "palm", name: "Palm Tree", vendor: "Canopy & Root Nursery", desc: "20-ft Medjool date palm, craned in", footprint: [18, 18], variants: [["Single palm", 1900]] },
    { id: "cypress", name: "Italian Cypress Row", vendor: "Canopy & Root Nursery", desc: "Row of 10, 12-ft columnar trees", footprint: [8, 60], variants: [["Row of 10", 4800]] },
    { id: "arbor", name: "Privacy Screen Trees", vendor: "Canopy & Root Nursery", desc: "Arborvitae hedge row, 8-ft at install", footprint: [6, 100], variants: [["100-ft screen", 6500], ["50-ft screen", 3400, [6, 50]]] },
    { id: "fruit", name: "Fruit Tree", vendor: "Glasshouse & Grove", desc: "Apple, peach, fig, or citrus — semi-dwarf", footprint: [15, 15], variants: [["Single tree", 380]] },
    { id: "boxwood", name: "Boxwood Hedge", vendor: "Stillwater Landscapes", desc: "Clipped formal hedge, irrigated", footprint: [4, 50], variants: [["50 linear ft", 3900], ["100 linear ft", 7500, [4, 100]]] },
    { id: "hydrangea", name: "Hydrangea Border", vendor: "Stillwater Landscapes", desc: "Limelight hydrangeas, drip line, mulch", footprint: [5, 30], variants: [["30-ft border", 1600]] },
    { id: "lavender", name: "Lavender Walk", vendor: "Stillwater Landscapes", desc: "Double lavender border along a path", footprint: [8, 40], variants: [["40-ft walk", 2100]] },
    { id: "roses", name: "Rose Garden", vendor: "Stillwater Landscapes", desc: "24 David Austin roses, boxwood edge, arbor", footprint: [14, 14], variants: [["Formal rose garden", 2900]] },
    { id: "perennial", name: "Perennial Flower Bed", vendor: "Stillwater Landscapes", desc: "Layered four-season planting design", footprint: [8, 20], variants: [["8×20 bed", 1200], ["Double bed 8×40", 2300, [8, 40]]] },
    { id: "meadow", name: "Wildflower Meadow", vendor: "Glasshouse & Grove", desc: "Native seed mix, prepped and sown", footprint: [100, 100], variants: [["¼-acre meadow", 1800], ["1-acre meadow", 5600, [200, 200]]] },
    { id: "sod", name: "Sod Lawn", vendor: "Stillwater Landscapes", desc: "Graded, irrigated, premium fescue sod", footprint: [70, 70], variants: [["5,000 sq ft", 3900, [70, 70]], ["20,000 sq ft", 14500, [140, 140]]] },
    { id: "veg", name: "Vegetable Garden", vendor: "Glasshouse & Grove", desc: "Raised cedar beds, drip, deer fencing", footprint: [20, 30], variants: [["Kitchen garden", 2400]] },
    { id: "orchard", name: "Orchard", vendor: "Glasshouse & Grove", desc: "40 fruit trees, planted grid, fencing", footprint: [60, 60], variants: [["Planted orchard", 26000]] },
    { id: "land", name: "Full Landscaping Plan", vendor: "Stillwater Landscapes", desc: "Grading, irrigation, planting, lighting", footprint: null, variants: [["Estate landscape", 125000]] },
  ]},
  { cat: "Rooms", items: [
    { id: "kitchen", name: "Chef's Kitchen Package", vendor: "Rangeline Kitchens", desc: "Pro appliances, stone counters, pantry", footprint: null, variants: [["Premium package", 145000], ["Show + prep kitchen", 260000]] },
    { id: "bath", name: "Primary Spa Bath", vendor: "Stillwater Wellness", desc: "Wet room, soaking tub, heated floors", footprint: null, variants: [["Spa bath build-out", 82000]] },
    { id: "suite", name: "Extra Bedroom Suite", vendor: "Meridian Design-Build", desc: "Bedroom, walk-in closet, en-suite", footprint: null, variants: [["Per suite", 95000]] },
    { id: "office", name: "Home Office / Library", vendor: "Foliohaus Millwork", desc: "Built-ins, ladder rail, hidden door", footprint: null, variants: [["Executive office", 38000], ["Two-story library", 88000]] },
    { id: "mud", name: "Mudroom & Laundry", vendor: "Rangeline Kitchens", desc: "Lockers, dog wash, double laundry", footprint: null, variants: [["Full package", 32000]] },
    { id: "panic", name: "Safe Room", vendor: "Vaultworks Subterranean", desc: "Ballistic door, independent air + comms", footprint: null, variants: [["Concealed safe room", 60000]] },
  ]},
  { cat: "Finishes", items: [
    { id: "floor", name: "Flooring Throughout", vendor: "Terra & Timber", desc: "Whole-home flooring, installed", footprint: null, variants: [["Polished concrete", 52000], ["Wide-plank white oak", 98000], ["Italian marble", 265000]] },
    { id: "tile", name: "Tile Package", vendor: "Terra & Timber", desc: "Baths, backsplashes — hand-set", footprint: null, variants: [["Ceramic + porcelain", 24000], ["Zellige + natural stone", 68000]] },
    { id: "paint", name: "Paint & Plaster Palette", vendor: "Atelier Finish Co.", desc: "Designer color plan, lime-wash accents", footprint: null, variants: [["Whole-home palette", 19000], ["Venetian plaster feature walls", 46000]] },
    { id: "windows", name: "Floor-to-Ceiling Glazing", vendor: "Skyline Glassworks", desc: "Steel-frame window walls, sliders", footprint: null, variants: [["Great-room wall", 68000], ["Whole-home glass upgrade", 195000]] },
    { id: "doors", name: "Custom Doors", vendor: "Foliohaus Millwork", desc: "Pivot entry, solid-core interiors", footprint: null, variants: [["Door package", 42000]] },
    { id: "stairs", name: "Floating Glass Staircase", vendor: "Skyline Glassworks", desc: "Cantilevered treads, glass rail", footprint: null, variants: [["Signature stair", 88000]] },
    { id: "light", name: "Designer Lighting Plan", vendor: "Atelier Finish Co.", desc: "Layered lighting, statement fixtures", footprint: null, variants: [["Whole-home plan", 56000]] },
  ]},
  { cat: "Furniture & Decor", items: [
    { id: "sofa", name: "Italian Leather Sectional", vendor: "Casa Moderna Imports", desc: "10-seat modular, aniline leather", footprint: null, variants: [["Living room set", 18500]] },
    { id: "tv", name: "98\" Cinema TV + Sound", vendor: "Quiet Circuit", desc: "Flagship panel, reference sound system", footprint: null, variants: [["Great-room setup", 9200]] },
    { id: "bed", name: "Canopy Bed Suite", vendor: "Casa Moderna Imports", desc: "King canopy bed, linens, nightstands", footprint: null, variants: [["Primary suite set", 13500]] },
    { id: "rug", name: "Antique Rug Collection", vendor: "Silk Road Gallery", desc: "Hand-knotted heritage pieces", footprint: null, variants: [["3-rug collection", 11000]] },
    { id: "fire", name: "Fireplace", vendor: "Hearthstone Masonry", desc: "Installed and vented", footprint: null, variants: [["Gas insert", 8500], ["Double-sided stone hearth", 46000]] },
    { id: "dining", name: "12-Seat Dining Table", vendor: "Foliohaus Millwork", desc: "Live-edge walnut, matched chairs", footprint: null, variants: [["Dining set", 15500]] },
    { id: "desk", name: "Executive Desk Setup", vendor: "Foliohaus Millwork", desc: "Standing desk, task chair, cable-free", footprint: null, variants: [["Office set", 5200]] },
    { id: "chand", name: "Statement Chandelier", vendor: "Atelier Finish Co.", desc: "Hand-blown glass, double-height foyer", footprint: null, variants: [["Foyer piece", 23000]] },
    { id: "art", name: "Curated Art Collection", vendor: "Silk Road Gallery", desc: "Original works, framed + installed", footprint: null, variants: [["Starter collection", 48000], ["Gallery program", 180000]] },
  ]},
  { cat: "Outdoor", items: [
    { id: "patio", name: "Patio & Outdoor Kitchen", vendor: "Stillwater Landscapes", desc: "Stone terrace, grill island, pergola", footprint: [30, 24], variants: [["Terrace + kitchen", 88000]] },
    { id: "drive", name: "Gated Driveway", vendor: "Meridian Design-Build", desc: "Paver drive, stone piers, auto gate", footprint: [16, 200], variants: [["Gate + 200 ft drive", 64000], ["Gate + 400 ft drive", 98000, [16, 400]]] },
    { id: "dock", name: "Private Dock", vendor: "Bluewater Marine Builds", desc: "Boat lift, swim ladder, composite deck", footprint: [10, 60], variants: [["60-ft dock + lift", 78000]] },
    { id: "heli", name: "Helipad", vendor: "Skyline Glassworks", desc: "Lit concrete pad, windsock, markings", footprint: [50, 50], variants: [["Private helipad", 155000]] },
    { id: "firepit", name: "Sunken Fire Pit Lounge", vendor: "Hearthstone Masonry", desc: "Gas ring, curved stone seating", footprint: [18, 18], variants: [["Fire lounge", 21000]] },
    { id: "fence", name: "Perimeter Fencing", vendor: "Meridian Design-Build", desc: "Cedar or steel estate fencing", footprint: null, variants: [["1,000 linear ft", 48000]] },
    { id: "playset", name: "Playground Set", vendor: "Vertical Habitat", desc: "Cedar tower, swings, rubber mulch", footprint: [25, 25], variants: [["Estate playset", 14000]] },
    { id: "clearing", name: "Land Clearing & Grading", vendor: "Blacktop Civil Co.", desc: "Tree/brush removal, stump grinding, rough grade — drag over anything to clear it (removes real features in Photoreal)", footprint: [100, 100], variants: [["¼-acre clear & grade", 6500, [100, 100]], ["1-acre clear & grade", 18000, [210, 205]], ["2-acre clear & grade", 32000, [300, 290]]] },
  ]},
  { cat: "Commercial", items: [
    { id: "retail", name: "Retail Shell Building", vendor: "Meridian Commercial", desc: "Steel-frame shell, storefront glazing, vanilla box", footprint: [60, 85], variants: [["5,000 sq ft · $185/sq ft", 925000], ["10,000 sq ft strip", 1750000, [80, 125]]] },
    { id: "office", name: "Office Build-Out", vendor: "Meridian Commercial", desc: "Class-A TI: partitions, ceilings, MEP, finishes", footprint: null, variants: [["3,000 sq ft · $95/sq ft", 285000], ["8,000 sq ft · $110/sq ft", 880000]] },
    { id: "warehouse", name: "Warehouse / Flex", vendor: "Meridian Commercial", desc: "Clear-span metal building, 24-ft eaves, slab", footprint: [100, 100], variants: [["10,000 sq ft", 1150000], ["25,000 sq ft", 2600000, [125, 200]]] },
    { id: "parking", name: "Parking Lot", vendor: "Blacktop Civil Co.", desc: "Paved, striped, lit, storm drainage", footprint: [90, 120], variants: [["30 stalls", 135000], ["80 stalls", 320000, [140, 200]]] },
    { id: "ev", name: "EV Charging Station", vendor: "Heliostat Energy", desc: "Level-3 DC fast chargers, canopy, utility upgrade", footprint: [20, 40], variants: [["4-stall DC fast", 185000]] },
    { id: "drive", name: "Drive-Thru Lane", vendor: "Blacktop Civil Co.", desc: "Lane, canopy, menu boards, intercom", footprint: [14, 120], variants: [["Single lane", 85000]] },
    { id: "dock", name: "Loading Dock", vendor: "Meridian Commercial", desc: "Two positions, levelers, seals, bollards", footprint: [30, 40], variants: [["2-position dock", 68000]] },
    { id: "commkitchen", name: "Commercial Kitchen", vendor: "Rangeline Kitchens", desc: "Hood, line equipment, walk-in, health-code finish", footprint: null, variants: [["Restaurant kitchen", 240000], ["Ghost-kitchen bay", 120000]] },
    { id: "signage", name: "Pylon & Building Signage", vendor: "Atelier Finish Co.", desc: "Illuminated pylon + channel letters, permitted", footprint: null, variants: [["Sign package", 32000]] },
    { id: "ada", name: "Code & ADA Package", vendor: "Meridian Commercial", desc: "Accessibility, fire, egress compliance scope", footprint: null, variants: [["Compliance package", 48000]] },
    { id: "sitework", name: "Civil Sitework", vendor: "Blacktop Civil Co.", desc: "Grading, utilities, curbs, stormwater", footprint: null, variants: [["Per-acre sitework", 160000]] },
  ]},
];

const ALL_ITEMS = CATALOG.flatMap((c) => c.items);

/* ─────────── PERSISTENCE ─────────── */
const STORE_KEY = "tapacasa-projects-v3";
async function loadProjects() {
  try { const r = await window.storage.get(STORE_KEY); return r ? JSON.parse(r.value) : []; }
  catch { return []; }
}
async function saveProjects(list) {
  try { await window.storage.set(STORE_KEY, JSON.stringify(list)); return true; }
  catch { return false; }
}

/* ─────────── INTERACTIVE SITE PLAN ─────────── */
/* web-mercator helpers for the satellite underlay */
const TILE = 256;
const merc = (lat, lon, z) => {
  const n = TILE * 2 ** z;
  const rad = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n];
};

function SatTiles({ topLat, leftLon, winW, winD, lat0, VB_W }) {
  const ftPerDegLat = 110540 * 3.28084;
  const ftPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180) * 3.28084;
  const botLat = topLat - winD / ftPerDegLat;
  const rightLon = leftLon + winW / ftPerDegLon;
  let z = Math.min(19, Math.max(3, Math.round(Math.log2((156543.03392 * Math.cos((lat0 * Math.PI) / 180)) / ((winW * 0.3048) / VB_W)))));
  let p0, p1, txs, tys;
  do {
    p0 = merc(topLat, leftLon, z); p1 = merc(botLat, rightLon, z);
    txs = [Math.floor(p0[0] / TILE), Math.floor(p1[0] / TILE)];
    tys = [Math.floor(p0[1] / TILE), Math.floor(p1[1] / TILE)];
    if ((txs[1] - txs[0] + 1) * (tys[1] - tys[0] + 1) <= 48) break;
    z--;
  } while (z > 3);
  const s = VB_W / (p1[0] - p0[0]);
  const tiles = [];
  for (let tx = txs[0]; tx <= txs[1]; tx++)
    for (let ty = tys[0]; ty <= tys[1]; ty++)
      tiles.push([tx, ty]);
  return (
    <g pointerEvents="none">
      {tiles.map(([tx, ty]) => (
        <image key={`${z}-${tx}-${ty}`}
          href={satTileURL(z, tx, ty)}
          x={(tx * TILE - p0[0]) * s} y={(ty * TILE - p0[1]) * s}
          width={TILE * s} height={TILE * s} opacity="0.95" preserveAspectRatio="none" />
      ))}
      <rect x="0" y="0" width={VB_W} height={(p1[1] - p0[1]) * s} fill="rgba(10,31,56,0.18)" />
    </g>
  );
}


/* ─────────── 3D LAND VIEW ───────────
   Your real satellite imagery becomes the ground (tilted to measured slope),
   and every placed item rises out of it in 3D. Drag to orbit, pinch/scroll to zoom. */
let THREE_LOADER = null;
function loadThree() {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.THREE) return Promise.resolve(window.THREE);
  if (!THREE_LOADER) THREE_LOADER = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";
    s.onload = () => res(window.THREE);
    s.onerror = () => rej(new Error("three.js blocked"));
    document.head.appendChild(s);
  });
  return THREE_LOADER;
}

function buildSatCanvas(topLat, leftLon, winW, winD, lat0, done) {
  const CW = 1024;
  const CH = Math.max(256, Math.min(2048, Math.round((CW * winD) / winW)));
  const ftPerDegLat = 110540 * 3.28084;
  const ftPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180) * 3.28084;
  const botLat = topLat - winD / ftPerDegLat;
  const rightLon = leftLon + winW / ftPerDegLon;
  let z = Math.min(19, Math.max(3, Math.round(Math.log2((156543.03392 * Math.cos((lat0 * Math.PI) / 180)) / ((winW * 0.3048) / CW)))));
  let p0, p1, txs, tys;
  do {
    p0 = merc(topLat, leftLon, z); p1 = merc(botLat, rightLon, z);
    txs = [Math.floor(p0[0] / TILE), Math.floor(p1[0] / TILE)];
    tys = [Math.floor(p0[1] / TILE), Math.floor(p1[1] / TILE)];
    if ((txs[1] - txs[0] + 1) * (tys[1] - tys[0] + 1) <= 40) break;
    z--;
  } while (z > 3);
  const s = CW / (p1[0] - p0[0]);
  const canvas = document.createElement("canvas");
  canvas.width = CW; canvas.height = CH;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#6a8f5f"; ctx.fillRect(0, 0, CW, CH);
  let pending = 0, loaded = 0, finished = false;
  const finish = () => { if (!finished) { finished = true; done(loaded > 0 ? canvas : null); } };
  for (let tx = txs[0]; tx <= txs[1]; tx++)
    for (let ty = tys[0]; ty <= tys[1]; ty++) {
      pending++;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => { try { ctx.drawImage(img, (tx * TILE - p0[0]) * s, (ty * TILE - p0[1]) * s, TILE * s + 1, TILE * s + 1); loaded++; } catch { /* tainted */ } if (--pending === 0) finish(); };
      img.onerror = () => { if (--pending === 0) finish(); };
      img.src = satTileURL(z, tx, ty);
    }
  if (pending === 0) finish();
  setTimeout(finish, 9000);
}

const TREE_IDS = { oak: 1, maple: 1, palm: 2, fruit: 1 };
const HEDGE_IDS = { cypress: 1, arbor: 1, boxwood: 1, hydrangea: 1, lavender: 1 };
const WATER_IDS = { pool: 1, koi: 1 };
const SLAB_IDS = { tennis: "#7a9e6b", pickle: "#4f8f9e", parking: "#5a5f66", heli: "#6a6f76", patio: "#b9a184", drive: "#6a6f76", dock: "#8a6f4f", firepit: "#8f8578", golf: "#4d8f4a", sod: "#5f9e52", meadow: "#8fae5c", veg: "#7a6648", ev: "#5a5f66" };
const BLDG_H = { house: 24, guest: 13, barn: 22, retail: 18, warehouse: 28, bowl: 15, court: 26, green: 12, playset: 10, garage: 4 };

let CESIUM_LOADER = null;
function loadCesium() {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.Cesium) return Promise.resolve(window.Cesium);
  if (!CESIUM_LOADER) CESIUM_LOADER = new Promise((res, rej) => {
    window.CESIUM_BASE_URL = "https://cesium.com/downloads/cesiumjs/releases/1.115/Build/Cesium/";
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://cesium.com/downloads/cesiumjs/releases/1.115/Build/Cesium/Widgets/widgets.css";
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = "https://cesium.com/downloads/cesiumjs/releases/1.115/Build/Cesium/Cesium.js";
    js.onload = () => res(window.Cesium);
    js.onerror = () => rej(new Error("Cesium blocked"));
    document.head.appendChild(js);
  });
  return CESIUM_LOADER;
}

/* 🌍 PHOTOREAL — your design placed inside Google's photorealistic 3D scan of the real world */
function PhotorealView({ location, items }) {
  const holder = useRef(null);
  const [st, setSt] = useState("init");
  const [err, setErr] = useState("");
  const key = getK("google");

  useEffect(() => {
    if (!key || !location.coords) return;
    let viewer, dead = false;
    setSt("loading");
    loadCesium().then(async (Cesium) => {
      if (dead || !holder.current) return;
      try {
        Cesium.GoogleMaps.defaultApiKey = key;
        viewer = new Cesium.Viewer(holder.current, {
          baseLayerPicker: false, timeline: false, animation: false, geocoder: false,
          sceneModePicker: false, homeButton: false, navigationHelpButton: false,
          fullscreenButton: false, infoBox: false, selectionIndicator: false,
          imageryProvider: false, requestRenderMode: false,
        });
        viewer.scene.globe.show = false;
        const ts = await Cesium.createGooglePhotorealistic3DTileset();
        if (dead) return;
        viewer.scene.primitives.add(ts);

        const poly = location.polygon;
        const lotSqft = location.acres * ACRE_SQFT;
        const lotW = poly ? poly.w : Math.sqrt(lotSqft * 1.4);
        const lotD = poly ? poly.h : lotSqft / lotW;
        const ftLat = 110540 * 3.28084;
        const ftLon = 111320 * Math.cos((location.coords.lat * Math.PI) / 180) * 3.28084;
        const topLat = poly?.anchor ? poly.anchor.maxLat : location.coords.lat + lotD / 2 / ftLat;
        const leftLon = poly?.anchor ? poly.anchor.minLon : location.coords.lon - lotW / 2 / ftLon;
        const M = 0.3048;

        if (poly) {
          const ring = poly.pts.flatMap(([px, py]) => [leftLon + px / ftLon, topLat - py / ftLat]);
          viewer.entities.add({ polygon: { hierarchy: Cesium.Cartesian3.fromDegreesArray(ring), material: Cesium.Color.fromCssColorString("#FF7A29").withAlpha(0.12), outline: true, outlineColor: Cesium.Color.fromCssColorString("#FF7A29"), heightReference: Cesium.HeightReference.CLAMP_TO_GROUND } });
        }

        /* demolition / clearing: carve the REAL buildings & trees out of the photoreal mesh */
        try {
          const clears = items.filter((it) => it.fp && CLEAR_IDS[it.itemId]);
          if (clears.length && Cesium.ClippingPolygonCollection) {
            const polys = clears.map((it) => {
              const cw = it.rot ? it.fp[1] : it.fp[0];
              const cd = it.rot ? it.fp[0] : it.fp[1];
              const ring = [
                [it.x, it.y], [it.x + cw, it.y], [it.x + cw, it.y + cd], [it.x, it.y + cd],
              ].flatMap(([px, py]) => [leftLon + px / ftLon, topLat - py / ftLat]);
              return new Cesium.ClippingPolygon({ positions: Cesium.Cartesian3.fromDegreesArray(ring) });
            });
            ts.clippingPolygons = new Cesium.ClippingPolygonCollection({ polygons: polys });
            clears.forEach((it) => {
              const cw = it.rot ? it.fp[1] : it.fp[0];
              const cd = it.rot ? it.fp[0] : it.fp[1];
              const ring = [
                [it.x, it.y], [it.x + cw, it.y], [it.x + cw, it.y + cd], [it.x, it.y + cd],
              ].flatMap(([px, py]) => [leftLon + px / ftLon, topLat - py / ftLat]);
              viewer.entities.add({ polygon: { hierarchy: Cesium.Cartesian3.fromDegreesArray(ring), material: Cesium.Color.fromCssColorString("#a8906a"), heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, classificationType: Cesium.ClassificationType.TERRAIN } });
            });
          }
        } catch { /* clipping unsupported — pads below still render */ }

        items.forEach((it) => {
          if (!it.fp) return;
          if (CLEAR_IDS[it.itemId]) return; /* handled above */
          const w = (it.rot ? it.fp[1] : it.fp[0]) * M;
          const dep = (it.rot ? it.fp[0] : it.fp[1]) * M;
          const la = topLat - (it.y + (it.rot ? it.fp[0] : it.fp[1]) / 2) / ftLat;
          const lo = leftLon + (it.x + (it.rot ? it.fp[1] : it.fp[0]) / 2) / ftLon;
          const id = it.itemId || "";
          const RTG = Cesium.HeightReference.RELATIVE_TO_GROUND;
          if (TREE_IDS[id] || id === "cypress" || id === "arbor" || HEDGE_IDS[id]) {
            const h = (TREE_IDS[id] ? Math.min(w, dep) * 1.2 + 3 : 2.4);
            viewer.entities.add({ position: Cesium.Cartesian3.fromDegrees(lo, la, h / 2), ellipsoid: { radii: new Cesium.Cartesian3(w / 2, dep / 2, h / 2), material: Cesium.Color.fromCssColorString("#3e7d4f").withAlpha(0.95), heightReference: RTG } });
            return;
          }
          const sty = getStyle(it);
          let color = sty.wall, h = (BLDG_H[id] || 14) * M;
          let roofy = !SLAB_IDS[id] && !WATER_IDS[id];
          if (WATER_IDS[id]) { color = "#2f9fd4"; h = 0.5; roofy = false; }
          else if (SLAB_IDS[id]) { color = SLAB_IDS[id]; h = 0.35; }
          else if (it.existing) color = "#c9c2b4";
          viewer.entities.add({ position: Cesium.Cartesian3.fromDegrees(lo, la, h / 2), box: { dimensions: new Cesium.Cartesian3(w, dep, h), material: Cesium.Color.fromCssColorString(color).withAlpha(0.92), outline: true, outlineColor: Cesium.Color.fromCssColorString("#14243D").withAlpha(0.6), heightReference: RTG } });
          if (roofy && h > 2) {
            viewer.entities.add({ position: Cesium.Cartesian3.fromDegrees(lo, la, h + (sty.roofT === "flat" ? 0.2 : Math.min(w, dep) * 0.18)), cylinder: { length: sty.roofT === "flat" ? 0.4 : Math.min(w, dep) * 0.36, topRadius: 0.01, bottomRadius: Math.max(w, dep) * 0.62, material: Cesium.Color.fromCssColorString(sty.roofC).withAlpha(0.95), heightReference: RTG, numberOfVerticalLines: 0 } });
            viewer.entities.add({ position: Cesium.Cartesian3.fromDegrees(lo, la, h * 0.55), box: { dimensions: new Cesium.Cartesian3(w * 1.02, dep * 1.02, Math.min(1.4, h * 0.3)), material: Cesium.Color.fromCssColorString("#2e4757").withAlpha(0.9), heightReference: RTG } });
          }
        });

        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(location.coords.lon, location.coords.lat - Math.max(0.0009, lotD / ftLat), Math.max(90, lotW * M * 0.9)),
          orientation: { heading: 0, pitch: -0.55, roll: 0 },
          duration: 2.5,
        });
        setSt("ok");
      } catch (e) { setErr(e?.message || "photoreal init failed"); setSt("failed"); }
    }).catch((e) => { if (!dead) { setErr(e?.message || "engine blocked"); setSt("failed"); } });
    return () => { dead = true; try { viewer?.destroy(); } catch { /* ok */ } };
  }, [key, location, JSON.stringify(items.map((i) => [i.itemId, i.fp, i.rot, Math.round(i.x), Math.round(i.y)]))]);

  if (!location.coords) return <div className="empty-note">Photoreal mode needs a real map location — pick or trace a parcel on the world map (curated listings have no coordinates).</div>;
  if (!key) return (
    <div className="empty-note">🌍 Photoreal mode renders your design inside Google's photorealistic 3D scan of the real world — real buildings, real trees, your additions standing among them.
      <br /><br />To enable (free tier covers casual use): 1) console.cloud.google.com → create project → enable billing, 2) enable the <b>Map Tiles API</b>, 3) create an API key, 4) paste it under ⚙ Pro integrations on the front page.</div>
  );
  return (
    <div>
      <div className="threed-holder photo">
        <div ref={holder} className="threed-mount" />
        {st === "loading" && <div className="map-msg">Streaming the real world in 3D… (first load takes a moment)</div>}
        {st === "failed" && <div className="map-msg">Photoreal failed: {err}. Check the key has the Map Tiles API enabled and billing on.</div>}
      </div>
      <div className="orbit-hint">GOOGLE PHOTOREALISTIC 3D · DRAG TO ORBIT · TWO FINGERS TO TILT/ZOOM · YOUR DESIGN SHOWN AS COLORED VOLUMES ON THE REAL TERRAIN (BETA)</div>
    </div>
  );
}

const STYLE_DEFAULTS = {
  house: { wall: "#f2eee6", roofC: "#454e59", roofT: "gable" },
  guest: { wall: "#e7ddc9", roofC: "#5a4638", roofT: "gable" },
  barn: { wall: "#8f3b32", roofC: "#3c3f45", roofT: "gable" },
  retail: { wall: "#c9ced4", roofC: "#6a6f76", roofT: "flat" },
  warehouse: { wall: "#aeb4bb", roofC: "#7d838a", roofT: "flat" },
  bowl: { wall: "#d9d2c2", roofC: "#454e59", roofT: "flat" },
  court: { wall: "#c9c2ae", roofC: "#4a5560", roofT: "gable" },
  green: { wall: "#cfe3ea", roofC: "#cfe3ea", roofT: "gable" },
};
const getStyle = (it) => ({ ...(STYLE_DEFAULTS[it.itemId] || { wall: "#e9e2d3", roofC: "#4a525c", roofT: "gable" }), ...(it.style || {}) });
const WALL_SWATCHES = ["#f2eee6", "#dfd6c3", "#b9c4cc", "#8f3b32", "#3f4753", "#f7f7f2"];
const ROOF_SWATCHES = ["#454e59", "#7a4a35", "#2f4a3e", "#8a8f96"];
const BUILDABLE = { house: 1, guest: 1, barn: 1, retail: 1, warehouse: 1, bowl: 1, court: 1, green: 1 };

function ThreeDView({ location, items, viewFt, onSnapshot, selectedUid, onSelectItem, onStyle }) {
  const mountRef = useRef(null);
  const api = useRef({});
  const camModeRef = useRef("orbit");
  const satCache = useRef({});
  const [status3d, setStatus3d] = useState("loading");
  const [camMode, setCamMode] = useState("orbit");
  const [sunHour, setSunHour] = useState(14);
  const knobRef = useRef(null);
  const itemsKey = JSON.stringify(items.map((i) => [i.itemId, i.fp, i.rot, Math.round(i.x), Math.round(i.y), i.landscape ? 1 : 0, i.style || 0]));
  const selItem = items.find((i) => i.uid === selectedUid);

  const switchMode = (m) => { camModeRef.current = m; setCamMode(m); api.current.setMode?.(m); };
  const joyStart = useRef(null);
  const joyDown = (e) => { e.preventDefault(); joyStart.current = [e.clientX, e.clientY]; e.currentTarget.setPointerCapture?.(e.pointerId); };
  const joyMove = (e) => {
    if (!joyStart.current || !api.current.stick) return;
    const dx = e.clientX - joyStart.current[0], dy = e.clientY - joyStart.current[1];
    const m = Math.min(38, Math.hypot(dx, dy)) / 38;
    const a = Math.atan2(dy, dx);
    api.current.stick.x = Math.cos(a) * m;
    api.current.stick.y = Math.sin(a) * m;
    if (knobRef.current) knobRef.current.style.transform = `translate(${Math.cos(a) * m * 34}px, ${Math.sin(a) * m * 34}px)`;
  };
  const joyUp = () => {
    joyStart.current = null;
    if (api.current.stick) { api.current.stick.x = 0; api.current.stick.y = 0; }
    if (knobRef.current) knobRef.current.style.transform = "translate(0,0)";
  };

  useEffect(() => {
    let dead = false, raf = 0, renderer, cleanupEvents = () => {};
    const poly = location.polygon;
    const lotSqft = location.acres * ACRE_SQFT;
    const lotW = poly ? poly.w : Math.sqrt(lotSqft * 1.4);
    const lotD = poly ? poly.h : lotSqft / lotW;
    const winW = Math.min(viewFt, lotW);
    const winD = Math.min(viewFt * (lotD / lotW) * 0.75, lotD);

    loadThree().then((THREE) => {
      if (dead || !mountRef.current) return;
      setStatus3d("ok");
      const W = mountRef.current.clientWidth || 700;
      const H = Math.max(340, Math.round(W * 0.64));
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      renderer.setSize(W, H);
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      mountRef.current.innerHTML = "";
      mountRef.current.appendChild(renderer.domElement);

      const skyC = document.createElement("canvas");
      skyC.width = 8; skyC.height = 256;
      const sctx = skyC.getContext("2d");
      const sg = sctx.createLinearGradient(0, 0, 0, 256);
      sg.addColorStop(0, "#6ea7d6"); sg.addColorStop(0.6, "#bcd7ea"); sg.addColorStop(1, "#e8eff4");
      sctx.fillStyle = sg; sctx.fillRect(0, 0, 8, 256);
      const scene = new THREE.Scene();
      scene.background = new THREE.CanvasTexture(skyC);
      scene.fog = new THREE.Fog("#dfe9f0", winW * 1.8, winW * 5);
      scene.add(new THREE.HemisphereLight(0xe8f0f8, 0x5b7350, 0.75));
      const sun = new THREE.DirectionalLight(0xfff0d8, 1.35);
      const latSun = ((location.coords?.lat ?? location.polygon?.anchor?.lat0 ?? 40) * Math.PI) / 180;
      const dayN = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
      const decl = (23.44 * Math.PI / 180) * Math.sin((2 * Math.PI * (284 + dayN)) / 365);
      const updateSun = (h) => {
        const H = ((h - 12) * 15 * Math.PI) / 180;
        const alt = Math.asin(Math.sin(latSun) * Math.sin(decl) + Math.cos(latSun) * Math.cos(decl) * Math.cos(H));
        const azS = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(latSun) - Math.tan(decl) * Math.cos(latSun));
        const az = azS + Math.PI; /* from north */
        const R = winW * 1.2;
        const a2 = Math.max(alt, 0.06);
        sun.position.set(R * Math.cos(a2) * Math.sin(az), R * Math.sin(a2), -R * Math.cos(a2) * Math.cos(az));
        const day = Math.max(0, Math.sin(alt));
        sun.intensity = 0.25 + day * 1.25;
        sun.color.setHSL(0.09 + day * 0.045, 0.55 - day * 0.35, 0.62 + day * 0.16);
      };
      updateSun(14);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      const sc = Math.max(winW, winD) * 0.8;
      sun.shadow.camera.left = -sc; sun.shadow.camera.right = sc;
      sun.shadow.camera.top = sc; sun.shadow.camera.bottom = -sc;
      sun.shadow.camera.far = winW * 4;
      sun.shadow.bias = -0.0004;
      scene.add(sun);

      const ground = new THREE.Group();
      scene.add(ground);
      const t = location.terrain;
      if (t && t.slopePct > 0.5) {
        const dirMap = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0], NE: [0.707, -0.707], NW: [-0.707, -0.707], SE: [0.707, 0.707], SW: [-0.707, 0.707] };
        const d = dirMap[t.downhill] || [0, 0];
        if (d[0] || d[1]) ground.setRotationFromAxisAngle(new THREE.Vector3(d[1], 0, -d[0]).normalize(), Math.atan(Math.min(0.35, t.slopePct / 100)));
      }
      const pad = Math.max(winW, winD) * 0.6;
      let groundH = () => 0; /* real heights swap in when the grid arrives */
      const displace = (mesh, gw, gd) => {
        const pos = mesh.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) pos.setZ(i, groundH(pos.getX(i), -pos.getY(i)));
        pos.needsUpdate = true;
        mesh.geometry.computeVertexNormals();
      };
      const groundMesh = new THREE.Mesh(new THREE.PlaneGeometry(winW + pad * 2, winD + pad * 2, 40, 30), new THREE.MeshStandardMaterial({ color: "#67905c", roughness: 1 }));
      groundMesh.rotation.x = -Math.PI / 2;
      groundMesh.receiveShadow = true;
      ground.add(groundMesh);
      const liftAll = () => {
        displace(groundMesh);
        satMeshRef && displace(satMeshRef);
        items3d.forEach((g) => { if (g.userData.cx != null) g.position.y = groundH(g.userData.cx, g.userData.cz); });
        extras.children.forEach(() => {});
        extras.position.y = groundH(0, 0);
        postList.forEach((p) => { p.position.y = groundH(p.position.x, p.position.z) + 3; });
      };
      let satMeshRef = null;
      const postList = [];

      const lat0 = poly?.anchor?.lat0 ?? location.coords?.lat;
      const anchor = poly?.anchor
        ? { topLat: poly.anchor.maxLat, leftLon: poly.anchor.minLon }
        : location.coords
          ? { topLat: location.coords.lat + winD / 2 / (110540 * 3.28084), leftLon: location.coords.lon - winW / 2 / (111320 * Math.cos((location.coords.lat * Math.PI) / 180) * 3.28084) }
          : null;
      const applySat = (canvas) => {
        if (dead || !canvas) return;
        const tex = new THREE.CanvasTexture(canvas);
        const satMesh = new THREE.Mesh(new THREE.PlaneGeometry(winW, winD, 40, 30), new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
        satMesh.rotation.x = -Math.PI / 2;
        satMesh.position.y = 0.2;
        satMesh.receiveShadow = true;
        ground.add(satMesh);
        satMeshRef = satMesh;
        displace(satMesh);
      };
      if (anchor && lat0 != null) {
        const ck = `${anchor.topLat.toFixed(5)},${anchor.leftLon.toFixed(5)},${Math.round(winW)}`;
        if (satCache.current[ck]) applySat(satCache.current[ck]);
        else buildSatCanvas(anchor.topLat, anchor.leftLon, winW, winD, lat0, (c) => { if (c) satCache.current[ck] = c; applySat(c); });
      }

      if (anchor && lat0 != null) {
        fetchTerrainGrid(anchor.topLat, anchor.leftLon, winW, winD, lat0).then(({ grid, nx, nz }) => {
          if (dead) return;
          ground.rotation.set(0, 0, 0); /* real relief replaces the simple tilt */
          groundH = (x, z) => {
            const fx = Math.min(nx - 1.001, Math.max(0, ((x + winW / 2) / winW) * (nx - 1)));
            const fz = Math.min(nz - 1.001, Math.max(0, ((z + winD / 2) / winD) * (nz - 1)));
            const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
            return grid[j][i] * (1 - u) * (1 - v) + grid[j][i + 1] * u * (1 - v) + grid[j + 1][i] * (1 - u) * v + grid[j + 1][i + 1] * u * v;
          };
          liftAll();
        }).catch(() => { /* keep tilt fallback */ });
      }
      const boundary = poly ? poly.pts.map(([px, py]) => [px - winW / 2, py - winD / 2]) :
        [[-winW / 2, -winD / 2], [winW / 2, -winD / 2], [winW / 2, winD / 2], [-winW / 2, winD / 2]];
      const postMat = new THREE.MeshStandardMaterial({ color: "#e8eef5" });
      boundary.forEach(([bx, bz]) => {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 6, 8), postMat);
        post.position.set(bx, 3, bz); post.castShadow = true;
        ground.add(post); postList.push(post);
      });

      const jitter = (hex, amt = 0.05) => { const c = new THREE.Color(hex); c.offsetHSL((Math.random() - 0.5) * 0.02, (Math.random() - 0.5) * amt, (Math.random() - 0.5) * amt); return c; };
      const mat = (c, o) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, ...(o || {}) });
      const M = (grp, geo, m, x, y, z, noShadow) => { const mesh = new THREE.Mesh(geo, m); mesh.position.set(x, y, z); if (!noShadow) { mesh.castShadow = true; mesh.receiveShadow = true; } grp.add(mesh); return mesh; };

      const tree = (grp, x, z, r, h, kind) => {
        const s = 0.85 + Math.random() * 0.3; r *= s; h *= s;
        M(grp, new THREE.CylinderGeometry(r * 0.07, r * 0.11, h * 0.5, 6), mat("#6b4f35"), x, h * 0.25, z);
        if (kind === 2) { M(grp, new THREE.ConeGeometry(r * 0.5, h * 0.55, 8), mat(jitter("#4c8f52")), x, h * 0.68, z); return; }
        const cMat = mat(jitter("#3e7d4f", 0.09));
        M(grp, new THREE.SphereGeometry(r * 0.5, 8, 6), cMat, x, h * 0.62, z);
        M(grp, new THREE.SphereGeometry(r * 0.36, 8, 6), cMat, x + r * 0.28, h * 0.52, z + r * 0.15);
        M(grp, new THREE.SphereGeometry(r * 0.32, 8, 6), cMat, x - r * 0.25, h * 0.55, z - r * 0.18);
      };
      const conifer = (grp, x, z, h) => {
        M(grp, new THREE.CylinderGeometry(0.5, 0.7, h * 0.25, 5), mat("#5d4630"), x, h * 0.12, z);
        M(grp, new THREE.ConeGeometry(h * 0.16, h * 0.85, 7), mat(jitter("#2f6e42")), x, h * 0.55, z);
      };
      const person = (grp, x, z) => {
        M(grp, new THREE.CylinderGeometry(0.7, 0.85, 4.2, 8), mat("#b4574a"), x, 2.1, z);
        M(grp, new THREE.SphereGeometry(0.62, 8, 8), mat("#e3b18f"), x, 4.8, z);
      };
      const car = (grp, x, z) => {
        M(grp, new THREE.BoxGeometry(15, 3, 6.2), mat("#8fa3b8", { roughness: 0.35 }), x, 2.6, z);
        M(grp, new THREE.BoxGeometry(8, 2.4, 5.6), mat("#7d90a5", { roughness: 0.3 }), x - 0.5, 5.1, z);
        [[-5, -3.1], [5, -3.1], [-5, 3.1], [5, 3.1]].forEach(([wx, wz]) => {
          const wheel = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 0.9, 12), mat("#22262b"));
          wheel.rotation.x = Math.PI / 2; wheel.position.set(x + wx, 1.3, z + wz); wheel.castShadow = true; grp.add(wheel);
        });
      };

      /* ── ARCHITECTURAL BUILDER: real roofs, framed windows, doors, porches, chimneys ── */
      const roofOn = (grp, cx, cz, w, dep, hgt, style) => {
        const rc = mat(style.roofC, { roughness: 0.7 });
        const ov = 1.6; /* eave overhang */
        if (style.roofT === "flat") {
          M(grp, new THREE.BoxGeometry(w + 1, 1.2, dep + 1), rc, cx, hgt + 0.6, cz);
          M(grp, new THREE.BoxGeometry(w + 1, 2.4, 1), rc, cx, hgt + 1.2, cz - dep / 2);
          M(grp, new THREE.BoxGeometry(w + 1, 2.4, 1), rc, cx, hgt + 1.2, cz + dep / 2);
          return;
        }
        if (style.roofT === "modern") {
          const slab = M(grp, new THREE.BoxGeometry(w + ov * 2, 1.1, dep + ov * 2 + 3), rc, cx, hgt + Math.min(w, dep) * 0.09, cz);
          slab.rotation.x = 0.12;
          return;
        }
        if (style.roofT === "hip") {
          const roofH = Math.min(w, dep) * 0.3;
          const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.001, Math.sqrt(2) * Math.min(w, dep) / 2, roofH, 4, 1), rc);
          roof.rotation.y = Math.PI / 4;
          roof.scale.set((w + ov * 2) / Math.min(w, dep), 1, (dep + ov * 2) / Math.min(w, dep));
          roof.position.set(cx, hgt + roofH / 2, cz);
          roof.castShadow = true; grp.add(roof);
          return;
        }
        /* gable: two pitched slabs + ridge, gable-end infill */
        const span = dep + ov * 2;
        const roofH = dep * 0.32;
        const slope = Math.hypot(span / 2, roofH) + 0.6;
        const ang = Math.atan2(roofH, span / 2);
        [-1, 1].forEach((side) => {
          const slab = new THREE.Mesh(new THREE.BoxGeometry(w + ov * 2, 0.9, slope), rc);
          slab.position.set(cx, hgt + roofH / 2, cz + side * span / 4);
          slab.rotation.x = -side * ang;
          slab.castShadow = true; slab.receiveShadow = true; grp.add(slab);
        });
        M(grp, new THREE.BoxGeometry(w + ov * 2, 1, 1.4), rc, cx, hgt + roofH, cz);
        const gableMat = mat(style.wall);
        [-1, 1].forEach((side) => {
          const g = new THREE.Mesh(new THREE.CylinderGeometry(0.01, dep / 2, roofH - 0.4, 4, 1), gableMat);
          g.rotation.y = Math.PI / 4;
          g.scale.set(0.06, 1, 1);
          g.position.set(cx + side * (w / 2 - 0.3), hgt + (roofH - 0.4) / 2, cz);
          grp.add(g);
        });
      };

      const windowsOn = (grp, cx, cz, w, dep, hgt, stories) => {
        const frame = mat("#f7f7f2", { roughness: 0.5 });
        const glass = mat("#2e4757", { roughness: 0.12, metalness: 0.45 });
        const put = (x, y, z, horiz) => {
          M(grp, new THREE.BoxGeometry(horiz ? 4.4 : 0.7, 5, horiz ? 0.7 : 4.4), frame, x, y, z, true);
          M(grp, new THREE.BoxGeometry(horiz ? 3.6 : 0.9, 4.2, horiz ? 0.9 : 3.6), glass, x, y, z, true);
        };
        for (let st = 0; st < stories; st++) {
          const wy = (st + 0.55) * (hgt / stories);
          const nx = Math.max(2, Math.floor(w / 13));
          for (let i = 0; i < nx; i++) {
            const wx = cx - w / 2 + (i + 0.5) * (w / nx);
            put(wx, wy, cz - dep / 2, true);
            put(wx, wy, cz + dep / 2, true);
          }
          const nz = Math.max(1, Math.floor(dep / 15));
          for (let i = 0; i < nz; i++) {
            const wz = cz - dep / 2 + (i + 0.5) * (dep / nz);
            put(cx - w / 2, wy, wz, false);
            put(cx + w / 2, wy, wz, false);
          }
        }
      };

      const building = (grp, it, cx, cz, w, dep, hgt) => {
        const style = getStyle(it);
        const wall = it.existing ? mat("#c6bfb1") : mat(style.wall);
        M(grp, new THREE.BoxGeometry(w + 1.2, 1.6, dep + 1.2), mat("#7d7468"), cx, 0.8, cz); /* foundation */
        M(grp, new THREE.BoxGeometry(w, hgt, dep), wall, cx, hgt / 2 + 1, cz);
        const stories = Math.max(1, Math.round(hgt / 11));
        if (it.itemId === "green") {
          M(grp, new THREE.BoxGeometry(w, hgt, dep), mat("#bcd9e2", { transparent: true, opacity: 0.45, roughness: 0.1 }), cx, hgt / 2 + 1, cz, true);
        } else if (it.itemId === "warehouse" || it.itemId === "retail") {
          for (let i = 0; i < Math.floor(w / 10); i++)
            M(grp, new THREE.BoxGeometry(0.5, hgt - 2, dep + 0.4), mat(style.wall === "#aeb4bb" ? "#9aa1a8" : style.wall), cx - w / 2 + (i + 0.5) * (w / Math.floor(w / 10)), hgt / 2 + 1, cz, true);
          if (it.itemId === "retail") M(grp, new THREE.BoxGeometry(w * 0.8, hgt * 0.5, 0.8), mat("#2e4757", { roughness: 0.1, metalness: 0.4 }), cx, hgt * 0.3 + 1, cz + dep / 2, true);
          else windowsOn(grp, cx, cz, w, dep, hgt * 0.9, 1);
        } else {
          windowsOn(grp, cx, cz, w, dep, hgt, stories);
        }
        /* door + porch on homes */
        if (it.itemId === "house" || it.itemId === "guest" || !BUILDABLE[it.itemId]) {
          const doorZ = cz + dep / 2;
          M(grp, new THREE.BoxGeometry(5, 8.4, 0.8), mat("#f7f7f2"), cx, 5.2, doorZ, true);
          M(grp, new THREE.BoxGeometry(3.8, 7.4, 1), mat("#5d4630", { roughness: 0.6 }), cx, 4.7, doorZ, true);
          M(grp, new THREE.BoxGeometry(9, 0.9, 6), mat("#b8b0a2"), cx, 1.4, doorZ + 3);
          M(grp, new THREE.BoxGeometry(10, 0.8, 7), mat(style.roofC), cx, 10.5, doorZ + 3.5);
          [-3.8, 3.8].forEach((dx) => M(grp, new THREE.CylinderGeometry(0.45, 0.45, 8.6, 8), mat("#f7f7f2"), cx + dx, 5.8, doorZ + 6));
        }
        if (it.itemId === "house") {
          M(grp, new THREE.BoxGeometry(4, hgt + dep * 0.32 + 5, 4), mat("#8a7466"), cx + w / 2 - 6, (hgt + dep * 0.32 + 5) / 2 + 1, cz - dep / 4);
        }
        if (it.itemId === "garage") return;
        roofOn(grp, cx, cz, w, dep, hgt + 1, it.existing ? { ...style, roofC: "#8f887a" } : style);
      };

      const items3d = [];
      let mainHouse = null;
      items.forEach((it) => {
        if (!it.fp) return;
        const grp = new THREE.Group();
        grp.userData.uid = it.uid;
        ground.add(grp);
        items3d.push(grp);
        const w = it.rot ? it.fp[1] : it.fp[0];
        const dep = it.rot ? it.fp[0] : it.fp[1];
        const cx = it.x + w / 2 - winW / 2;
        const cz = it.y + dep / 2 - winD / 2;
        grp.userData.cx = cx; grp.userData.cz = cz;
        const id = it.itemId || "";
        if (id === "house") mainHouse = [cx, cz, w, dep];
        if (CLEAR_IDS[id]) { M(grp, new THREE.BoxGeometry(w, 0.8, dep), mat("#a8906a", { roughness: 1 }), cx, 0.5, cz); return; }
        if (TREE_IDS[id]) { tree(grp, cx, cz, Math.min(w, dep), Math.min(w, dep) * 1.15 + 8, TREE_IDS[id]); return; }
        if (id === "cypress" || id === "arbor") {
          const n = Math.max(3, Math.round(Math.max(w, dep) / 9));
          for (let i = 0; i < n; i++) {
            const f = (i + 0.5) / n;
            conifer(grp, w > dep ? cx - w / 2 + f * w : cx, w > dep ? cz : cz - dep / 2 + f * dep, 13 + Math.random() * 3);
          }
          return;
        }
        if (HEDGE_IDS[id]) { M(grp, new THREE.BoxGeometry(w, 6.5, dep), mat(jitter("#3a7549")), cx, 3.25, cz); return; }
        if (id === "roses" || id === "perennial") {
          M(grp, new THREE.BoxGeometry(w, 1.2, dep), mat("#5f8f4e"), cx, 0.7, cz);
          for (let i = 0; i < 8; i++)
            M(grp, new THREE.SphereGeometry(0.9, 6, 5), mat(jitter(i % 2 ? "#c46a8e" : "#d8a15c", 0.12)), cx - w / 2 + Math.random() * w, 1.8, cz - dep / 2 + Math.random() * dep, true);
          return;
        }
        if (id === "orchard") {
          M(grp, new THREE.BoxGeometry(w, 0.4, dep), mat("#5f9e52"), cx, 0.3, cz);
          for (let gx = 0; gx < 4; gx++) for (let gz = 0; gz < 4; gz++)
            tree(grp, cx - w / 2 + (gx + 0.5) * (w / 4), cz - dep / 2 + (gz + 0.5) * (dep / 4), 12, 14, 1);
          return;
        }
        if (WATER_IDS[id]) {
          M(grp, new THREE.BoxGeometry(w + 6, 1.1, dep + 6), mat("#ddd5c6"), cx, 0.55, cz);
          M(grp, new THREE.BoxGeometry(w + 1.4, 1.5, dep + 1.4), mat("#f0ece2"), cx, 0.9, cz); /* coping */
          M(grp, new THREE.BoxGeometry(w, 1.2, dep), mat("#33b1e0", { transparent: true, opacity: 0.82, roughness: 0.08, metalness: 0.25 }), cx, 1.35, cz);
          M(grp, new THREE.BoxGeometry(3, 0.4, 6), mat("#e8eef5"), cx + w / 2 - 2, 1.7, cz, true); /* ledge */
          return;
        }
        if (id === "tennis" || id === "pickle") {
          M(grp, new THREE.BoxGeometry(w, 1, dep), mat(id === "tennis" ? "#2e6b4f" : "#3f7f8e"), cx, 0.6, cz);
          const line = mat("#f5f5f0");
          M(grp, new THREE.BoxGeometry(w * 0.82, 0.15, 0.7), line, cx, 1.15, cz - dep * 0.38, true);
          M(grp, new THREE.BoxGeometry(w * 0.82, 0.15, 0.7), line, cx, 1.15, cz + dep * 0.38, true);
          M(grp, new THREE.BoxGeometry(w * 0.82, 0.15, 0.7), line, cx, 1.15, cz, true);
          M(grp, new THREE.BoxGeometry(0.7, 0.15, dep * 0.76), line, cx - w * 0.4, 1.15, cz, true);
          M(grp, new THREE.BoxGeometry(0.7, 0.15, dep * 0.76), line, cx + w * 0.4, 1.15, cz, true);
          M(grp, new THREE.BoxGeometry(w * 0.8, 3.4, 0.25), mat("#1e2b33", { transparent: true, opacity: 0.7 }), cx, 2.8, cz, true);
          for (let i = 0; i <= 6; i++) {
            M(grp, new THREE.CylinderGeometry(0.25, 0.25, 10, 6), mat("#3a4149"), cx - w / 2 + (i / 6) * w, 5.6, cz - dep / 2, true);
            M(grp, new THREE.CylinderGeometry(0.25, 0.25, 10, 6), mat("#3a4149"), cx - w / 2 + (i / 6) * w, 5.6, cz + dep / 2, true);
          }
          return;
        }
        if (id === "patio") {
          M(grp, new THREE.BoxGeometry(w, 1, dep), mat("#b9a184"), cx, 0.6, cz);
          const beam = mat("#6e5a44");
          [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sz]) => M(grp, new THREE.BoxGeometry(0.9, 9.5, 0.9), beam, cx + sx * (w / 2 - 1.5), 5.5, cz + sz * (dep / 2 - 1.5)));
          for (let i = 0; i < 6; i++) M(grp, new THREE.BoxGeometry(w, 0.5, 0.9), beam, cx, 10.3, cz - dep / 2 + 1.5 + (i * (dep - 3)) / 5, true);
          M(grp, new THREE.BoxGeometry(8, 3.4, 3.5), mat("#8a8f96"), cx - w / 4, 2.7, cz - dep / 4); /* grill island */
          return;
        }
        if (id === "firepit") {
          M(grp, new THREE.CylinderGeometry(w / 2, w / 2, 1, 16), mat("#b9a184"), cx, 0.5, cz);
          M(grp, new THREE.CylinderGeometry(2.4, 2.8, 1.6, 12), mat("#6f6a61"), cx, 1.6, cz);
          M(grp, new THREE.ConeGeometry(1.3, 3.2, 7), mat("#ff8c3a", { emissive: 0xff7a29, emissiveIntensity: 0.9 }), cx, 3.4, cz, true);
          M(grp, new THREE.CylinderGeometry(w / 2 - 1, w / 2 - 1, 1.6, 16, 1, true), mat("#8f8578"), cx, 1.3, cz, true);
          return;
        }
        if (id === "playset") {
          M(grp, new THREE.BoxGeometry(8, 8, 8), mat("#a3703f"), cx - w / 4, 6.5, cz);
          M(grp, new THREE.ConeGeometry(6.4, 4.5, 4), mat("#2f6e42"), cx - w / 4, 12.7, cz);
          const slide = M(grp, new THREE.BoxGeometry(3, 0.6, 12), mat("#d8a15c"), cx - w / 4 + 5, 4.2, cz + 6);
          slide.rotation.x = 0.5;
          M(grp, new THREE.BoxGeometry(0.7, 9, 0.7), mat("#a3703f"), cx + w / 4, 4.5, cz - 3);
          M(grp, new THREE.BoxGeometry(0.7, 9, 0.7), mat("#a3703f"), cx + w / 4, 4.5, cz + 3);
          M(grp, new THREE.BoxGeometry(0.5, 0.5, 7), mat("#6e5a44"), cx + w / 4, 9, cz, true);
          return;
        }
        if (id === "heli") {
          M(grp, new THREE.CylinderGeometry(w / 2, w / 2, 1, 24), mat("#6a6f76"), cx, 0.6, cz);
          M(grp, new THREE.CylinderGeometry(w / 2 - 1.5, w / 2 - 1.5, 0.2, 24, 1, true), mat("#f5f5f0"), cx, 1.15, cz, true);
          M(grp, new THREE.BoxGeometry(2, 0.2, 12), mat("#f5f5f0"), cx - 4, 1.15, cz, true);
          M(grp, new THREE.BoxGeometry(2, 0.2, 12), mat("#f5f5f0"), cx + 4, 1.15, cz, true);
          M(grp, new THREE.BoxGeometry(10, 0.2, 2), mat("#f5f5f0"), cx, 1.15, cz, true);
          return;
        }
        if (SLAB_IDS[id]) { M(grp, new THREE.BoxGeometry(w, 1, dep), mat(SLAB_IDS[id]), cx, 0.6, cz); return; }
        const hgt = BLDG_H[id] || (it.landscape ? 8 : 14);
        if (id === "garage") {
          M(grp, new THREE.BoxGeometry(w, 4.5, dep), mat("#8f97a1"), cx, 2.25, cz);
          for (let i = 0; i < Math.max(1, Math.floor(w / 14)); i++)
            M(grp, new THREE.BoxGeometry(10, 3.4, 0.5), mat("#d9dde2"), cx - w / 2 + 7 + i * 14, 2.2, cz + dep / 2, true);
          return;
        }
        building(grp, it, cx, cz, w, dep, hgt);
      });

      const extras = new THREE.Group();
      ground.add(extras);
      if (mainHouse) {
        person(extras, mainHouse[0] + mainHouse[2] / 2 + 6, mainHouse[1] + mainHouse[3] / 2 + 6);
        car(extras, mainHouse[0] - mainHouse[2] / 2 - 14, mainHouse[1] + mainHouse[3] / 2 + 8);
      } else if (items.some((i) => i.fp)) person(extras, 6, winD * 0.3);

      /* cameras + controls (orbit inertia, walk joystick) */
      const cam = new THREE.PerspectiveCamera(58, W / H, 0.5, winW * 8);
      const orbit = { az: 0.85, el: 0.5, dist: Math.max(winW, winD) * 1.15, vaz: 0, vel: 0 };
      const walk = { yaw: Math.PI, pitch: -0.03, pos: new THREE.Vector3(0, 5.8, winD * 0.48) };
      let mode = camModeRef.current;
      let dragging = false, downAt = null;
      const applyCam = () => {
        if (mode === "walk") {
          cam.position.copy(walk.pos);
          cam.lookAt(walk.pos.x + Math.sin(walk.yaw) * Math.cos(walk.pitch), walk.pos.y + Math.sin(walk.pitch), walk.pos.z + Math.cos(walk.yaw) * Math.cos(walk.pitch));
        } else {
          cam.position.set(orbit.dist * Math.cos(orbit.el) * Math.sin(orbit.az), orbit.dist * Math.sin(orbit.el), orbit.dist * Math.cos(orbit.el) * Math.cos(orbit.az));
          cam.lookAt(0, 4, 0);
        }
      };
      applyCam();

      const ray = new THREE.Raycaster();
      const el = renderer.domElement;
      el.style.touchAction = "none";
      const ptrs = new Map();
      let lastPinch = 0;
      const onDown = (e) => { dragging = true; downAt = [e.clientX, e.clientY]; ptrs.set(e.pointerId, [e.clientX, e.clientY]); el.setPointerCapture?.(e.pointerId); };
      const onMove = (e) => {
        if (!ptrs.has(e.pointerId)) return;
        const prev = ptrs.get(e.pointerId);
        ptrs.set(e.pointerId, [e.clientX, e.clientY]);
        const dx = e.clientX - prev[0], dy = e.clientY - prev[1];
        if (ptrs.size === 1) {
          if (mode === "walk") {
            walk.yaw -= dx * 0.006;
            walk.pitch = Math.min(0.55, Math.max(-0.6, walk.pitch - dy * 0.004));
          } else {
            orbit.vaz = -dx * 0.005; orbit.vel = dy * 0.004;
            orbit.az += orbit.vaz;
            orbit.el = Math.min(1.45, Math.max(0.1, orbit.el + orbit.vel));
          }
          applyCam();
        } else if (ptrs.size === 2 && mode !== "walk") {
          const [a, b] = [...ptrs.values()];
          const pinch = Math.hypot(a[0] - b[0], a[1] - b[1]);
          if (lastPinch) { orbit.dist = Math.min(winW * 4, Math.max(40, orbit.dist * (lastPinch / pinch))); applyCam(); }
          lastPinch = pinch;
        }
      };
      const onUp = (e) => {
        ptrs.delete(e.pointerId);
        if (!ptrs.size) dragging = false;
        if (ptrs.size < 2) lastPinch = 0;
        /* tap (not drag) = select item to restyle */
        if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 7) {
          const rect = el.getBoundingClientRect();
          ray.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), cam);
          const hits = ray.intersectObjects(items3d, true);
          let uid = null, o = hits[0]?.object;
          while (o) { if (o.userData?.uid) { uid = o.userData.uid; break; } o = o.parent; }
          onSelectItem?.(uid);
        }
        downAt = null;
      };
      const onWheel = (e) => { e.preventDefault(); if (mode === "walk") return; orbit.dist = Math.min(winW * 4, Math.max(40, orbit.dist * (1 + Math.sign(e.deltaY) * 0.1))); applyCam(); };
      const mv = { f: 0, b: 0, l: 0, r: 0 };
      const stick = { x: 0, y: 0 };
      const keyMap = { w: "f", W: "f", ArrowUp: "f", s: "b", S: "b", ArrowDown: "b", a: "l", A: "l", ArrowLeft: "l", d: "r", D: "r", ArrowRight: "r" };
      const onKeyDown = (e) => { const k = keyMap[e.key]; if (k) { mv[k] = 1; e.preventDefault(); } };
      const onKeyUp = (e) => { const k = keyMap[e.key]; if (k) mv[k] = 0; };
      el.addEventListener("pointerdown", onDown);
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
      el.addEventListener("wheel", onWheel, { passive: false });
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("keyup", onKeyUp);
      cleanupEvents = () => {
        el.removeEventListener("pointerdown", onDown);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("pointercancel", onUp);
        el.removeEventListener("wheel", onWheel);
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup", onKeyUp);
      };

      api.current = {
        mv, stick,
        setSun: (h) => updateSun(h),
        setMode: (m) => { mode = m; applyCam(); },
        reset: () => { orbit.az = 0.85; orbit.el = 0.5; orbit.dist = Math.max(winW, winD) * 1.15; orbit.vaz = 0; orbit.vel = 0; walk.yaw = Math.PI; walk.pitch = -0.03; walk.pos.set(0, 5.8, winD * 0.48); applyCam(); },
        snap: () => {
          try {
            const url0 = renderer.domElement.toDataURL("image/png");
            onSnapshot?.(url0);
            const a = document.createElement("a");
            a.href = url0; a.download = "tapacasa-3d.png"; a.click();
          } catch { /* blocked */ }
        },
      };

      const SPEED = Math.max(1.0, winW / 620);
      const lim = { x: winW * 0.75 + pad * 0.5, z: winD * 0.75 + pad * 0.5 };
      const loop = () => {
        if (dead) return;
        raf = requestAnimationFrame(loop);
        if (!dragging && mode === "orbit" && (Math.abs(orbit.vaz) > 0.0004 || Math.abs(orbit.vel) > 0.0004)) {
          orbit.az += orbit.vaz; orbit.el = Math.min(1.45, Math.max(0.1, orbit.el + orbit.vel));
          orbit.vaz *= 0.92; orbit.vel *= 0.92;
          applyCam();
        }
        if (mode === "walk") {
          const fwd = (mv.f - mv.b) + (-stick.y);
          const strafe = (mv.r - mv.l) + (stick.x);
          if (fwd || strafe) {
            const fx = Math.sin(walk.yaw), fz = Math.cos(walk.yaw);
            walk.pos.x = Math.max(-lim.x, Math.min(lim.x, walk.pos.x + fwd * fx * SPEED + strafe * fz * SPEED));
            walk.pos.z = Math.max(-lim.z, Math.min(lim.z, walk.pos.z + fwd * fz * SPEED - strafe * fx * SPEED));
            walk.pos.y = groundH(walk.pos.x, walk.pos.z) + 5.8;
            applyCam();
          }
        }
        renderer.render(scene, cam);
      };
      loop();
    }).catch(() => !dead && setStatus3d("failed"));

    return () => { dead = true; cancelAnimationFrame(raf); cleanupEvents(); if (renderer) renderer.dispose(); };
  }, [itemsKey, location, viewFt]);

  const styleOf = selItem ? getStyle(selItem) : null;
  const canStyle = selItem && (BUILDABLE[selItem.itemId] || (!SLAB_IDS[selItem.itemId] && !TREE_IDS[selItem.itemId] && !HEDGE_IDS[selItem.itemId] && !WATER_IDS[selItem.itemId] && !CLEAR_IDS[selItem.itemId] && !selItem.landscape));

  return (
    <div>
      <div className="cam-bar">
        <button className={camMode === "orbit" ? "ctab on" : "ctab"} onClick={() => switchMode("orbit")}>🛸 Orbit</button>
        <button className={camMode === "walk" ? "ctab on" : "ctab"} onClick={() => switchMode("walk")}>🚶 Walk the land</button>
        <button className="btn-ghost xs" onClick={() => api.current.reset?.()}>Reset view</button>
        <button className="btn-ghost xs" onClick={() => api.current.snap?.()}>📸 Snapshot</button>
        <label className="sun-lab" title="Drag to move the sun through the day — real shadows for this latitude">
          ☀ {String(Math.floor(sunHour)).padStart(2, "0")}:{sunHour % 1 ? "30" : "00"}
          <input type="range" min="5.5" max="20.5" step="0.5" value={sunHour}
            onChange={(e) => { const h = +e.target.value; setSunHour(h); api.current.setSun?.(h); }} />
        </label>
      </div>
      {canStyle && (
        <div className="style-bar">
          <span className="style-name">🎨 {selItem.name}</span>
          <span className="style-lab">Walls</span>
          {WALL_SWATCHES.map((c) => (
            <button key={c} className={`swatch ${styleOf.wall === c ? "on" : ""}`} style={{ background: c }} onClick={() => onStyle?.(selItem.uid, { ...styleOf, wall: c })} aria-label={`Wall color ${c}`} />
          ))}
          <span className="style-lab">Roof</span>
          {ROOF_SWATCHES.map((c) => (
            <button key={c} className={`swatch ${styleOf.roofC === c ? "on" : ""}`} style={{ background: c }} onClick={() => onStyle?.(selItem.uid, { ...styleOf, roofC: c })} aria-label={`Roof color ${c}`} />
          ))}
          {["gable", "hip", "flat", "modern"].map((rt) => (
            <button key={rt} className={styleOf.roofT === rt ? "ctab on" : "ctab"} onClick={() => onStyle?.(selItem.uid, { ...styleOf, roofT: rt })}>{rt}</button>
          ))}
        </div>
      )}
      <div className="threed-holder">
        <div ref={mountRef} className="threed-mount" />
        {status3d === "loading" && <div className="map-msg">Building your land in 3D…</div>}
        {status3d === "failed" && <div className="map-msg">3D engine couldn't load in this environment — Site plan and Floor plan still work.</div>}
        {camMode === "walk" && status3d === "ok" && (
          <div className="joy" onPointerDown={joyDown} onPointerMove={joyMove} onPointerUp={joyUp} onPointerCancel={joyUp}>
            <div ref={knobRef} className="joy-knob" />
          </div>
        )}
      </div>
      <div className="orbit-hint">
        {camMode === "walk" ? "DRAG SCENE TO LOOK · JOYSTICK (OR WASD) TO WALK" : "TAP A BUILDING TO RESTYLE IT · DRAG TO ORBIT · PINCH/SCROLL TO ZOOM"}
        {" · REAL SLOPE "}{location.terrain ? `(${location.terrain.slopePct}% ${location.terrain.downhill})` : "(FLAT)"}
      </div>
    </div>
  );
}

function SitePlan({ location, items, selected, onSelect, onMove, viewFt, satOn, print, onDragStart }) {
  const svgRef = useRef(null);
  const drag = useRef(null);
  const sfx = print ? "-p" : "";
  const poly = location.polygon;
  const lotSqft = location.acres * ACRE_SQFT;
  const lotW = poly ? poly.w : Math.sqrt(lotSqft * 1.4);
  const lotD = poly ? poly.h : lotSqft / lotW;
  const winW = Math.min(viewFt, lotW);
  const winD = Math.min(viewFt * (lotD / lotW) * 0.75, lotD);
  const VB_W = 720;
  const scale = VB_W / winW;
  const VB_H = winD * scale;

  const toFt = (e) => {
    const rect = svgRef.current.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * winW,
      y: ((e.clientY - rect.top) / (rect.height * (VB_H / (VB_H + 30)))) * winD,
    };
  };

  const down = (e, it) => {
    e.preventDefault();
    onSelect(it.uid);
    onDragStart?.();
    const p = toFt(e);
    drag.current = { uid: it.uid, dx: p.x - it.x, dy: p.y - it.y };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const move = (e) => {
    if (!drag.current) return;
    const p = toFt(e);
    const it = items.find((i) => i.uid === drag.current.uid);
    if (!it) return;
    const w = it.rot ? it.fp[1] : it.fp[0];
    const d = it.rot ? it.fp[0] : it.fp[1];
    onMove(it.uid,
      Math.max(0, Math.min(winW - w, p.x - drag.current.dx)),
      Math.max(0, Math.min(winD - d, p.y - drag.current.dy)));
  };
  const up = () => { drag.current = null; };

  const lat0 = poly?.anchor?.lat0 ?? location.coords?.lat;
  const geoAnchor = poly?.anchor
    ? { topLat: poly.anchor.maxLat, leftLon: poly.anchor.minLon }
    : location.coords
      ? {
          topLat: location.coords.lat + winD / 2 / (110540 * 3.28084),
          leftLon: location.coords.lon - winW / 2 / (111320 * Math.cos((location.coords.lat * Math.PI) / 180) * 3.28084),
        }
      : null;

  return (
    <svg ref={svgRef} viewBox={`0 0 ${VB_W} ${VB_H + 30}`} className={`plan-svg ${print ? "printmode" : ""}`}
      onPointerMove={move} onPointerUp={up} onPointerLeave={up}
      onPointerDown={(e) => { if (e.target === svgRef.current) onSelect(null); }}
      role="img" aria-label="Interactive site plan — drag items to place them">
      <defs>
        <pattern id={`grid${sfx}`} width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M 24 0 L 0 0 0 24" fill="none" stroke={print ? "rgba(20,50,90,0.18)" : "rgba(180,214,245,0.10)"} strokeWidth="1" />
        </pattern>
        <pattern id={`hatch${sfx}`} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="7" stroke={print ? "rgba(18,58,94,0.5)" : "rgba(180,214,245,0.28)"} strokeWidth="1.2" />
        </pattern>
        <pattern id={`leaf${sfx}`} width="10" height="10" patternUnits="userSpaceOnUse">
          <circle cx="5" cy="5" r="1.4" fill={print ? "rgba(30,120,70,0.55)" : "rgba(140,220,170,0.45)"} />
        </pattern>
      </defs>
      <rect width={VB_W} height={VB_H + 30} fill={print ? "#FFFFFF" : "#0A1F38"} pointerEvents="none" />
      {satOn && geoAnchor && lat0 != null && (
        <SatTiles topLat={geoAnchor.topLat} leftLon={geoAnchor.leftLon} winW={winW} winD={winD} lat0={lat0} VB_W={VB_W} />
      )}
      <rect width={VB_W} height={VB_H} fill={`url(#grid${sfx})`} style={{ pointerEvents: "none" }} />
      {poly ? (
        <polygon points={poly.pts.map(([px, py]) => `${px * scale},${py * scale}`).join(" ")}
          fill={satOn ? "none" : "rgba(120,180,235,0.04)"} stroke={print ? "#123A5E" : "#BFDCF5"} strokeWidth="2.5" strokeDasharray="14 6" pointerEvents="none" />
      ) : (
        <rect x="1.5" y="1.5" width={VB_W - 3} height={VB_H - 3} fill="none" stroke={print ? "#123A5E" : "#BFDCF5"} strokeWidth="2" strokeDasharray="14 6" pointerEvents="none" />
      )}
      <g pointerEvents="none" transform={`translate(${VB_W - 26}, 26)`}>
        <circle r="14" fill="rgba(10,31,56,0.6)" stroke="#7FA8CC" strokeWidth="1" />
        <path d="M0,-9 L4,5 L0,2 L-4,5 Z" fill="#FF9A52" />
        <text y="-16" textAnchor="middle" className="plan-sub">N</text>
      </g>
      <text x={VB_W / 2} y={VB_H + 20} textAnchor="middle" className="plan-dim" pointerEvents="none">
        {poly ? "TRACED BOUNDARY · " : ""}
        {winW < lotW ? `SHOWING ${Math.round(winW)} × ${Math.round(winD)} FT ENVELOPE OF ` : ""}
        {Math.round(lotW).toLocaleString()} × {Math.round(lotD).toLocaleString()} FT · {location.acres} ACRES
      </text>
      {items.map((it) => {
        const cleared = CLEAR_IDS[it.itemId];
        const green = it.landscape && !cleared;
        const w = (it.rot ? it.fp[1] : it.fp[0]) * scale;
        const d = (it.rot ? it.fp[0] : it.fp[1]) * scale;
        const x = it.x * scale, y = it.y * scale;
        const sel = selected === it.uid;
        return (
          <g key={it.uid} onPointerDown={(e) => down(e, it)} style={{ cursor: "grab" }}>
            {cleared && <rect x={x} y={y} width={Math.max(w, 6)} height={Math.max(d, 6)} fill="#b09a72" opacity="0.92" />}
            <rect x={x} y={y} width={Math.max(w, 6)} height={Math.max(d, 6)}
              fill={cleared ? "none" : green ? `url(#leaf${sfx})` : `url(#hatch${sfx})`}
              stroke={sel ? "#FF9A52" : green ? (print ? "#1E7846" : "#8CDCAA") : (print ? "#123A5E" : "#EAF4FF")}
              strokeWidth={sel ? 2.6 : 1.6}
              strokeDasharray={it.existing ? "7 4" : undefined}
              rx={green ? Math.min(w, d) / 3 : 0} />
            <rect x={x} y={y} width={Math.max(w, 6)} height={Math.max(d, 6)}
              fill={green ? "rgba(120,220,160,0.07)" : (satOn ? "rgba(12,35,64,0.35)" : "rgba(120,180,235,0.08)")}
              rx={green ? Math.min(w, d) / 3 : 0} />
            {w > 58 && d > 24 ? (
              <>
                <text x={x + w / 2} y={y + d / 2 - 2} textAnchor="middle" className="plan-label" pointerEvents="none">{it.name.toUpperCase()}</text>
                <text x={x + w / 2} y={y + d / 2 + 12} textAnchor="middle" className="plan-sub" pointerEvents="none">{Math.round(it.fp[0])}′ × {Math.round(it.fp[1])}′</text>
              </>
            ) : (
              <text x={x + w / 2} y={Math.max(10, y - 4)} textAnchor="middle" className="plan-sub" pointerEvents="none">{it.name.toUpperCase()}</text>
            )}
          </g>
        );
      })}
      {items.length === 0 && (
        <text x={VB_W / 2} y={VB_H / 2} textAnchor="middle" className="plan-empty" pointerEvents="none">
          VACANT PARCEL — ADD FROM THE CATALOG, THEN DRAG TO PLACE
        </text>
      )}
    </svg>
  );
}

/* ─────────── REAL-WORLD MAP PICKER ───────────
   Leaflet (cdnjs) + OpenStreetMap / Esri satellite tiles
   + Nominatim geocoding. No API key required. */
const DEMO_ITEM = { id: "demolition", name: "Demolition & Site Clearing", vendor: "Meridian Design-Build", desc: "Permits, tear-down, haul-away, grading to buildable pad", footprint: null, variants: [["Full tear-down + clearing", 35000]] };
const CLEAR_IDS = { demolition: 1, clearing: 1 };
const HILLSIDE_ITEM = { id: "hillside", name: "Hillside Foundation & Retaining", vendor: "Deepwell Comfort", desc: "Engineered stepped foundation, retaining walls, drainage for sloped sites", footprint: null, variants: [["Moderate slope package", 65000], ["Steep slope package", 145000], ["Very steep / bench-cut package", 260000]] };

/* Real terrain from the free Open-Elevation API: sample center + N/S/E/W,
   derive elevation, average slope %, and downhill aspect. */
/* dense elevation grid for true 3D relief (Google via proxy, free fallback) */
async function fetchTerrainGrid(topLat, leftLon, winW, winD, lat0, nx = 8, nz = 6) {
  const ftLat = 110540 * 3.28084;
  const ftLon = 111320 * Math.cos((lat0 * Math.PI) / 180) * 3.28084;
  const pts = [];
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++)
    pts.push([topLat - ((j + 0.5) / nz) * (winD / ftLat), leftLon + ((i + 0.5) / nx) * (winW / ftLon)]);
  const locs = pts.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join("|");
  let d;
  try { d = await svcFetch("google", { type: "elevation", params: { locations: locs } }, 9000); if (!d?.results?.length) throw new Error("empty"); }
  catch { const r = await fetchT("https://api.open-elevation.com/api/v1/lookup?locations=" + locs, {}, 10000); d = await r.json(); }
  const el = d.results.map((x) => x.elevation * 3.28084);
  const min = Math.min(...el);
  const grid = [];
  for (let j = 0; j < nz; j++) grid.push(el.slice(j * nx, (j + 1) * nx).map((v) => v - min));
  return { grid, nx, nz };
}

async function fetchTerrain(lat, lon, acres) {
  const rM = Math.max(60, Math.sqrt(acres * 4046.86) / 2); // half-parcel radius, meters
  const dLat = rM / 111320;
  const dLon = rM / (111320 * Math.cos((lat * Math.PI) / 180));
  const pts = [[lat, lon], [lat + dLat, lon], [lat - dLat, lon], [lat, lon + dLon], [lat, lon - dLon]];
  const locs = pts.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join("|");
  let d;
  try { d = await svcFetch("google", { type: "elevation", params: { locations: locs } }, 9000); if (!d?.results?.length) throw new Error("empty"); }
  catch {
    const r = await fetchT("https://api.open-elevation.com/api/v1/lookup?locations=" + locs, {}, 10000);
    d = await r.json();
  }
  const el = d.results.map((x) => x.elevation);
  const [c, n, s, e, w] = el;
  const riseNS = (n - s) / 2, riseEW = (e - w) / 2;
  const slopePct = (Math.sqrt(riseNS ** 2 + riseEW ** 2) / rM) * 100;
  const dirs = [["N", s - c], ["S", n - c], ["E", w - c], ["W", e - c]];
  const downhill = riseNS === 0 && riseEW === 0 ? "—"
    : `${riseNS > 0 ? "S" : "N"}${Math.abs(riseEW) > Math.abs(riseNS) / 2 ? (riseEW > 0 ? "W" : "E") : ""}`;
  const grade = slopePct < 5 ? "GENTLE" : slopePct < 12 ? "MODERATE" : slopePct < 20 ? "STEEP" : "VERY STEEP";
  return { elevFt: Math.round(c * 3.28084), slopePct: +slopePct.toFixed(1), downhill, grade, reliefFt: Math.round((Math.max(...el) - Math.min(...el)) * 3.28084) };
}

/* land-biased boxes for the "drop me anywhere" explorer */
const LAND_BOXES = [
  [25, 49, -124, -70, 5], [36, 60, -9, 30, 4], [-35, 5, -73, -40, 3],
  [-30, 14, 12, 40, 2], [12, 55, 70, 135, 4], [-38, -16, 116, 150, 2], [50, 62, -125, -95, 1],
];
function randomLandPoint() {
  const total = LAND_BOXES.reduce((s, b) => s + b[4], 0);
  let r = Math.random() * total;
  const box = LAND_BOXES.find((b) => (r -= b[4]) <= 0) || LAND_BOXES[0];
  return [box[0] + Math.random() * (box[1] - box[0]), box[2] + Math.random() * (box[3] - box[2])];
}

function listingLinks(label) {
  const q = encodeURIComponent((label || "").split(",").slice(0, 3).join(",").trim());
  return [
    ["Zillow", `https://www.zillow.com/homes/${q}_rb/`],
    ["Realtor", `https://www.realtor.com/realestateandhomes-search/${q}`],
    ["LandWatch", `https://www.landwatch.com/land-for-sale/${q}`],
  ];
}

/* one-tap retail price checks for any item */
function shopLinks(name) {
  const q = encodeURIComponent(name);
  return [
    ["Amazon", `https://www.amazon.com/s?k=${q}`],
    ["eBay", `https://www.ebay.com/sch/i.html?_nkw=${q}`],
    ["Home Depot", `https://www.homedepot.com/s/${q}`],
    ["Lowe's", `https://www.lowes.com/search?searchTerm=${q}`],
    ["Wayfair", `https://www.wayfair.com/keyword.php?keyword=${q}`],
  ];
}

const CAT_OF = {};
CATALOG.forEach((c) => c.items.forEach((i) => (CAT_OF[i.id] = c.cat)));
const catOf = (p) => CAT_OF[p.itemId] || (p.existing ? "Structure" : "Custom ✦");

/* ─────────── PER-ROOM FLOOR PLAN ─────────── */
const ROOM_SQFT = [
  [/great|living|family/i, 450], [/theater|cinema/i, 500], [/gym|fitness/i, 550],
  [/kitchen/i, 320], [/primary|master/i, 380], [/bed/i, 300], [/bath/i, 170],
  [/office|library|study/i, 260], [/dining/i, 280], [/foyer|entry|hall/i, 150],
  [/laundry|mud/i, 140], [/bar|pub|game|arcade/i, 340], [/cellar|wine/i, 200],
];
const roomSqft = (name) => (ROOM_SQFT.find(([re]) => re.test(name)) || [null, 260])[1];

function FloorPlan({ houseSqft, rooms, selectedRoom, onSelectRoom, floorLabel = "LEVEL 1", print }) {
  const names = Object.keys(rooms);
  const houseW = Math.sqrt(houseSqft * 1.5);
  const houseD = houseSqft / houseW;
  const VB_W = 720, scale = VB_W / houseW, VB_H = houseD * scale;

  // scale room sizes to fit ~85% of the house, shelf-pack them
  let sizes = names.map((n) => ({ n, sq: roomSqft(n) }));
  const sum = sizes.reduce((s, r) => s + r.sq, 0) || 1;
  const k = Math.min(1, (houseSqft * 0.85) / sum);
  sizes = sizes.map((r) => ({ ...r, sq: r.sq * k }));
  const gap = 4;
  let x = gap, y = gap, rowH = 0;
  const packed = sizes.map((r) => {
    const w = Math.sqrt(r.sq * 1.3), d = r.sq / w;
    let W = w, D = d;
    if (x + W + gap > houseW) { x = gap; y += rowH + gap; rowH = 0; }
    const rect = { ...r, x, y, w: W, d: D };
    x += W + gap; rowH = Math.max(rowH, D);
    return rect;
  });

  return (
    <div>
      <svg viewBox={`0 0 ${VB_W} ${VB_H + 30}`} className={`plan-svg ${print ? "printmode" : ""}`} role="img" aria-label="Interior floor plan by room">
        <rect width={VB_W} height={VB_H + 30} fill={print ? "#FFFFFF" : "#0A1F38"} />
        <rect x="2" y="2" width={VB_W - 4} height={VB_H - 4} fill={print ? "rgba(20,50,90,0.04)" : "rgba(120,180,235,0.05)"} stroke={print ? "#123A5E" : "#EAF4FF"} strokeWidth="2.5" />
        <text x={VB_W / 2} y={VB_H + 20} textAnchor="middle" className="plan-dim">
          {floorLabel} · {Math.round(houseSqft).toLocaleString()} SQ FT · {Math.round(houseW)}′ × {Math.round(houseD)}′
        </text>
        {packed.map((r) => {
          const sel = r.n === selectedRoom;
          const total = rooms[r.n].reduce((s, i) => s + i.price, 0);
          return (
            <g key={r.n} onClick={() => onSelectRoom(sel ? null : r.n)} style={{ cursor: "pointer" }}>
              <rect x={r.x * scale} y={r.y * scale} width={r.w * scale} height={r.d * scale}
                fill={sel ? "rgba(255,122,41,0.16)" : "rgba(120,180,235,0.09)"}
                stroke={sel ? "#FF9A52" : "#7FA8CC"} strokeWidth={sel ? 2.4 : 1.4} />
              <text x={(r.x + r.w / 2) * scale} y={(r.y + r.d / 2) * scale - 4} textAnchor="middle" className="plan-label">{r.n.toUpperCase()}</text>
              <text x={(r.x + r.w / 2) * scale} y={(r.y + r.d / 2) * scale + 11} textAnchor="middle" className="plan-sub">
                {rooms[r.n].length} ITEM{rooms[r.n].length !== 1 ? "S" : ""} · {fmt(total)}
              </text>
            </g>
          );
        })}
        {names.length === 0 && (
          <text x={VB_W / 2} y={VB_H / 2} textAnchor="middle" className="plan-empty">
            ASSIGN ROOMS TO INTERIOR ITEMS IN THE COST PANEL TO BUILD THE FLOOR PLAN
          </text>
        )}
      </svg>
      {selectedRoom && rooms[selectedRoom] && (
        <div className="roomdetail">
          <div className="panel-head">{selectedRoom.toUpperCase()} — SPEC</div>
          {rooms[selectedRoom].map((p) => (
            <div key={p.uid} className="room-item">
              <span>{p.name}{p.notes ? <em> — {p.notes}</em> : null}</span><b>{fmt(p.price)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─────────── PROJECT COMPARISON ─────────── */
function projectStats(p) {
  const build = (p.placed || []).reduce((s, i) => s + i.price, 0);
  const total = p.location.price + build;
  const byCat = {};
  (p.placed || []).forEach((i) => { const c = catOf(i); byCat[c] = (byCat[c] || 0) + i.price; });
  return { build, total, tax: total * p.location.taxRate, byCat, count: (p.placed || []).length };
}

function CompareView({ a, b, onClose, onOpen }) {
  const sa = projectStats(a), sb = projectStats(b);
  const cats = [...new Set([...Object.keys(sa.byCat), ...Object.keys(sb.byCat)])];
  const Row = ({ label, va, vb, money = true }) => (
    <div className="cmp-row">
      <span className={money && va > vb ? "hi" : ""}>{money ? fmt(va) : va}</span>
      <span className="cmp-label">{label}</span>
      <span className={money && vb > va ? "hi" : ""}>{money ? fmt(vb) : vb}</span>
    </div>
  );
  return (
    <div className="app"><Style />
      <header className="hdr">
        <div className="hdr-mark">⌂</div>
        <div className="hdr-title"><h1>TapaCasa</h1><p className="hdr-sub">COMPARISON — TWO DESIGNS SIDE BY SIDE</p></div>
        <button className="btn-ghost" onClick={onClose}>← Back</button>
      </header>
      <div className="loc-wrap">
        <div className="cmp-heads">
          <button className="cmp-head" onClick={() => onOpen(a)}><b>{a.name}</b><span>{a.location.name} · {a.location.region} · {a.location.acres} ac</span><em>Open ↗</em></button>
          <button className="cmp-head" onClick={() => onOpen(b)}><b>{b.name}</b><span>{b.location.name} · {b.location.region} · {b.location.acres} ac</span><em>Open ↗</em></button>
        </div>
        <Row label="Land" va={a.location.price} vb={b.location.price} />
        <Row label="Build & contents" va={sa.build} vb={sb.build} />
        <Row label="PROJECT TOTAL" va={sa.total} vb={sb.total} />
        <Row label="Property tax / yr" va={sa.tax} vb={sb.tax} />
        <Row label="Items" va={sa.count} vb={sb.count} money={false} />
        <div className="panel-head" style={{ marginTop: 18 }}>BY CATEGORY</div>
        {cats.map((c) => <Row key={c} label={c} va={sa.byCat[c] || 0} vb={sb.byCat[c] || 0} />)}
      </div>
    </div>
  );
}

function AccountBar({ onSession }) {
  const [ses, setSes] = useState(sbSession.get());
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  if (!sbOn()) return null;
  const go = async (mode) => {
    setBusy(true); setMsg("");
    try {
      const r = await sbAuth(mode, email.trim(), pass);
      if (r.needsConfirm) setMsg("Check your email to confirm the account, then sign in.");
      else { setSes(sbSession.get()); onSession?.(); }
    } catch (e) { setMsg(e.message || "failed"); }
    setBusy(false);
  };
  if (ses) return (
    <div className="keybar ok">☁ {ses.email} — projects sync to your account on every device.
      <button className="ci-remove" onClick={() => { sbSession.set(null); setSes(null); onSession?.(); }}>Sign out</button>
    </div>
  );
  return (
    <div className="keybar">
      <span>☁ <b>Free account</b> — save designs to the cloud and open them on any device:</span>
      <div className="ai-row">
        <input className="ai-input" type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="ai-input" type="password" placeholder="password" value={pass} onChange={(e) => setPass(e.target.value)} />
      </div>
      <div className="ai-row">
        <button className="btn-orange sm" disabled={busy} onClick={() => go("in")}>Sign in</button>
        <button className="btn-ghost xs" disabled={busy} onClick={() => go("up")}>Create account</button>
      </div>
      {msg && <div className="ai-err">{msg}</div>}
    </div>
  );
}

function IntegrationsBar() {
  const [open, setOpen] = useState(false);
  const [vals, setVals] = useState({ mapbox: getK("mapbox"), regrid: getK("regrid"), google: getK("google") });
  const save = (n) => { setK(n, vals[n]); setOpen(open); };
  const Row = ({ n, label, hint }) => (
    <div className="int-row">
      <span>{label}</span>
      <input className="ai-input" type="password" placeholder={hint} value={vals[n]}
        onChange={(e) => setVals((v) => ({ ...v, [n]: e.target.value }))} onBlur={() => save(n)} />
      {getK(n) && <span className="int-ok">✓</span>}
    </div>
  );
  return (
    <div className="keybar">
      <button className="int-toggle" onClick={() => setOpen(!open)}>⚙ Pro integrations (optional) — HD imagery, official parcels, photoreal 3D {open ? "▴" : "▾"}</button>
      {open && (
        <div>
          <Row n="mapbox" label="Mapbox token — HD satellite (free tier: mapbox.com)" hint="pk.…" />
          <Row n="regrid" label="Regrid token — official parcel boundaries (paid: regrid.com)" hint="token" />
          <Row n="google" label="Google Maps key — 🌍 Photoreal 3D (enable 'Map Tiles API': console.cloud.google.com)" hint="AIza…" />
          <div className="fine">Keys are stored only in this browser. Leave blank to keep free defaults.</div>
        </div>
      )}
    </div>
  );
}

function ApiKeyBar({ onSaved }) {
  const [val, setVal] = useState("");
  const [has, setHas] = useState(!!getApiKey());
  if (has) return (
    <div className="keybar ok">🔑 API key saved on this device — AI appraisal, Design Director & locate are live.
      <button className="ci-remove" onClick={() => { setApiKey(""); setHas(false); }}>Remove key</button>
    </div>
  );
  return (
    <div className="keybar">
      <span>🔑 Enable AI features — paste your Anthropic API key (stored only in this browser). Skip this if your deployment uses the built-in serverless proxy with a server-side key.</span>
      <div className="ai-row">
        <input className="ai-input" type="password" placeholder="sk-ant-…" value={val} onChange={(e) => setVal(e.target.value)} />
        <button className="btn-orange sm" onClick={() => { if (val.trim()) { setApiKey(val); setHas(true); onSaved?.(); } }}>Save</button>
      </div>
    </div>
  );
}

function MapPicker({ onParcel }) {
  const divRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const satLayer = useRef(null);
  const streetLayer = useRef(null);
  const [status, setStatus] = useState("loading"); // loading | ready | failed
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [pin, setPin] = useState(null); // {lat, lon, label}
  const [acres, setAcres] = useState(2);
  const [sat, setSat] = useState(true);
  const [appraising, setAppraising] = useState(false);
  const [apprErr, setApprErr] = useState(null);
  const [tracing, setTracing] = useState(false);
  const [tracePts, setTracePts] = useState([]);
  const [tracedPoly, setTracedPoly] = useState(null); // {pts:[[xft,yft]], w, h, acres}
  const traceRef = useRef(false);
  const ptsRef = useRef([]);
  const polyLayerRef = useRef(null);

  /* lat/lon ring → feet-coordinate polygon + acreage (shoelace) */
  const polyFromLatLng = (ring) => {
    const lat0 = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    const ftLon = 111320 * Math.cos((lat0 * Math.PI) / 180) * 3.28084;
    const ftLat = 110540 * 3.28084;
    const minLon = Math.min(...ring.map((p) => p[1]));
    const maxLat = Math.max(...ring.map((p) => p[0]));
    const pts = ring.map(([lat, lon]) => [(lon - minLon) * ftLon, (maxLat - lat) * ftLat]);
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
      area += x1 * y2 - x2 * y1;
    }
    area = Math.abs(area) / 2;
    return {
      pts, w: Math.max(...pts.map((p) => p[0])), h: Math.max(...pts.map((p) => p[1])),
      acres: +(area / ACRE_SQFT).toFixed(2),
      anchor: { maxLat, minLon, lat0 },
    };
  };

  useEffect(() => {
    let cancelled = false;
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
    js.onload = () => {
      if (cancelled || !divRef.current || mapRef.current) return;
      try {
        const L = window.L;
        const map = L.map(divRef.current, { zoomControl: true, attributionControl: true }).setView([39.5, -98.35], 4);
        streetLayer.current = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" });
        satLayer.current = getK("mapbox")
          ? L.tileLayer(`https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token=${getK("mapbox")}`, { maxZoom: 21, attribution: "Imagery © Mapbox" })
          : L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Imagery © Esri" });
        satLayer.current.addTo(map);
        /* detect sandboxed environments that silently block tile servers */
        let okTiles = 0, badTiles = 0;
        const onTileLoad = () => { okTiles++; };
        const onTileErr = () => { badTiles++; if (okTiles === 0 && badTiles >= 6) setStatus("tiles-blocked"); };
        satLayer.current.on("tileload", onTileLoad).on("tileerror", onTileErr);
        streetLayer.current.on("tileload", onTileLoad).on("tileerror", onTileErr);
        map.on("click", async (e) => {
          const { lat, lng } = e.latlng;
          if (traceRef.current) {
            ptsRef.current = [...ptsRef.current, [lat, lng]];
            setTracePts([...ptsRef.current]);
            if (polyLayerRef.current) polyLayerRef.current.setLatLngs(ptsRef.current);
            else polyLayerRef.current = L.polygon(ptsRef.current, { color: "#FF7A29", weight: 2.5, fillOpacity: 0.12 }).addTo(map);
            return;
          }
          placePin(lat, lng, "Locating…");
          try {
            const r = await fetchT(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=14`, {}, 6000);
            const d = await r.json();
            placePin(lat, lng, d.display_name || `${lat.toFixed(4)}, ${lng.toFixed(4)}`);
          } catch {
            placePin(lat, lng, `${lat.toFixed(4)}, ${lng.toFixed(4)}`);
          }
        });
        mapRef.current = map;
        setStatus("ready");
      } catch { setStatus("failed"); }
    };
    js.onerror = () => !cancelled && setStatus("failed");
    document.head.appendChild(js);
    const t = setTimeout(() => { if (!mapRef.current) setStatus((s) => (s === "loading" ? "failed" : s)); }, 9000);
    return () => { cancelled = true; clearTimeout(t); if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } };
  }, []);

  const placePin = (lat, lon, label) => {
    setPin({ lat, lon, label });
    if (label && !/Locating|Mystery/.test(label)) remember(lat, lon, label);
    const L = window.L;
    if (!L || !mapRef.current) return;
    if (markerRef.current) markerRef.current.setLatLng([lat, lon]);
    else markerRef.current = L.marker([lat, lon]).addTo(mapRef.current);
  };

  const toggleSat = () => {
    if (!mapRef.current) return;
    if (sat) { mapRef.current.removeLayer(satLayer.current); streetLayer.current.addTo(mapRef.current); }
    else { mapRef.current.removeLayer(streetLayer.current); satLayer.current.addTo(mapRef.current); }
    setSat(!sat);
  };

  const runSearch = async () => {
    if (!query.trim()) return;
    setResults([{ loading: true, msg: "Searching map registry…" }]);
    try {
      const r = await fetchT(`https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(query)}`, {}, 6000);
      const d = await r.json();
      if (d.length) { setResults(d); return; }
      await googleLocate() || await aiLocate();
    } catch { (await googleLocate()) || (await aiLocate()); }
  };

  const googleLocate = async () => {
    try {
      const d = await svcFetch("google", { type: "geocode", params: { address: query } }, 9000);
      const g = d?.results?.[0];
      if (!g) return false;
      setResults([]);
      placePin(g.geometry.location.lat, g.geometry.location.lng, g.formatted_address || query);
      mapRef.current?.setView([g.geometry.location.lat, g.geometry.location.lng], 16);
      return true;
    } catch { return false; }
  };

  /* Fallback geocoder via the Anthropic API — always reachable from artifacts,
     so location search works even when outside map services are blocked. */
  const aiLocate = async () => {
    if (!query.trim()) { setResults([{ error: "Type a place first, then hit ⚡ AI locate." }]); return; }
    setResults([{ loading: true, msg: "Locating by AI…" }]);
    try {
      const text = await askAI(`Give approximate coordinates for this place: "${query}". Respond ONLY with JSON, no fences: {"lat":number,"lon":number,"label":"Place, Region, Country"}. If it is not a findable place, use your best guess for the nearest named place.`);
      const p = pickJSON(text);
      if (isNaN(+p.lat) || isNaN(+p.lon)) throw new Error("no coordinates in reply");
      setResults([]);
      setDiag((x) => ({ ...x, ai: "OK" }));
      placePin(Number(p.lat), Number(p.lon), p.label || query);
      mapRef.current?.setView([Number(p.lat), Number(p.lon)], 15);
    } catch (e) {
      setDiag((x) => ({ ...x, ai: "BLOCKED" }));
      setResults([{ error: getApiKey()
        ? `AI locate failed: ${e?.message || "request blocked"}.`
        : "AI features need a key on your own site: paste your Anthropic API key in the 🔑 bar below (get one at console.anthropic.com), then try again." }]);
    }
  };

  const pickResult = (res) => {
    setResults([]);
    const lat = +res.lat, lon = +res.lon;
    placePin(lat, lon, res.display_name);
    mapRef.current?.setView([lat, lon], 16);
  };

  const appraise = async () => {
    if (!pin) return;
    setAppraising(true); setApprErr(null);
    let terrain = null;
    try { terrain = await fetchTerrain(pin.lat, pin.lon, acres); } catch { /* elevation service unavailable */ }
    try {
      const text = await askAI(
`You are a land appraiser inside a property-design app. Appraise this parcel using your knowledge of regional real-estate markets.

Location: ${pin.label} (lat ${pin.lat.toFixed(4)}, lon ${pin.lon.toFixed(4)})
Parcel size: ${acres} acres.
${terrain ? `Measured terrain: elevation ${terrain.elevFt} ft, average slope ${terrain.slopePct}% falling ${terrain.downhill} (${terrain.grade}), ${terrain.reliefFt} ft relief across the parcel. Factor slope into land value and buildability.` : ""}

Respond with ONLY JSON, no fences:
{"shortName":"concise parcel name like 'Maple St Parcel' or 'Coastal Bluff Lot'","region":"City/area, State or Country","landPrice":realistic total USD for the ${acres}-acre lot alone,"taxRate":effective annual property tax rate as decimal (e.g. 0.011),"vibe":"one evocative line about the terrain/setting","likelyDeveloped":true or false based on whether this spot is probably built-up,"existingHomeValue":if likelyDeveloped a realistic USD value for a typical existing house there else 0,"existingHomeSqft":if likelyDeveloped a typical sqft number else 0}

Be realistic: urban/suburban land is far pricier per acre than rural; use the actual local market level and actual local effective tax rates.`);
      const p = pickJSON(text);
      onParcel({
        id: "map-" + Date.now(),
        name: p.shortName || "Selected Parcel",
        region: p.region || pin.label.split(",").slice(-3).join(",").trim(),
        acres, price: Number(p.landPrice) || 250000,
        taxRate: Number(p.taxRate) || 0.01,
        vibe: p.vibe || "Hand-picked on the map",
        coords: { lat: pin.lat, lon: pin.lon }, mapLabel: pin.label,
        polygon: tracedPoly || null, terrain,
        existingHome: p.likelyDeveloped ? { value: Number(p.existingHomeValue) || 0, sqft: Number(p.existingHomeSqft) || 2000 } : null,
      });
    } catch {
      setApprErr("Appraisal failed — try again or pick a curated listing below.");
    }
    setAppraising(false);
  };

  const startTrace = () => {
    traceRef.current = true; ptsRef.current = [];
    setTracing(true); setTracePts([]); setTracedPoly(null);
    if (polyLayerRef.current) { mapRef.current?.removeLayer(polyLayerRef.current); polyLayerRef.current = null; }
  };
  const finishTrace = async () => {
    traceRef.current = false; setTracing(false);
    if (ptsRef.current.length < 3) { clearTrace(); return; }
    const poly = polyFromLatLng(ptsRef.current);
    setTracedPoly(poly);
    setAcres(Math.max(0.05, poly.acres));
    const cLat = ptsRef.current.reduce((s, p) => s + p[0], 0) / ptsRef.current.length;
    const cLon = ptsRef.current.reduce((s, p) => s + p[1], 0) / ptsRef.current.length;
    placePin(cLat, cLon, "Locating traced parcel…");
    try {
      const r = await fetchT(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${cLat}&lon=${cLon}&zoom=16`, {}, 6000);
      const d = await r.json();
      placePin(cLat, cLon, d.display_name || `${cLat.toFixed(4)}, ${cLon.toFixed(4)}`);
    } catch { placePin(cLat, cLon, `${cLat.toFixed(4)}, ${cLon.toFixed(4)}`); }
  };
  const clearTrace = () => {
    traceRef.current = false; ptsRef.current = [];
    setTracing(false); setTracePts([]); setTracedPoly(null);
    if (polyLayerRef.current) { mapRef.current?.removeLayer(polyLayerRef.current); polyLayerRef.current = null; }
  };

  /* 🎲 drop anywhere on Earth (land-biased, GeoGuessr-style — but for building) */
  const [rolling, setRolling] = useState(false);
  const [scout, setScout] = useState(null);
  const [recent, setRecent] = useState(() => { try { return JSON.parse(localStorage.getItem("tapacasa_recent") || "[]"); } catch { return []; } });
  const remember = (lat, lon, label) => {
    const short = (label || "").split(",").slice(0, 3).join(",");
    setRecent((r) => {
      const next = [{ lat, lon, label: short }, ...r.filter((x) => x.label !== short)].slice(0, 5);
      try { localStorage.setItem("tapacasa_recent", JSON.stringify(next)); } catch { /* ok */ }
      return next;
    });
  };
  const scoutMarket = async () => {
    if (!pin) return;
    setScout({ busy: true });
    try {
      const text = await askAI(`You are a real-estate market analyst. For the area around "${pin.label}", produce a realistic snapshot of 4 representative properties currently typical of that market (mix of land and homes for sale). Respond ONLY with JSON, no fences: {"listings":[{"title":"short evocative title","kind":"land" or "home","acres":number,"beds":number or 0,"sqft":number or 0,"price":realistic USD number,"taxRate":local effective rate as decimal,"blurb":"one line"}]} — use the actual local market price level.`);
      const d = pickJSON(text);
      setScout({ items: (d.listings || []).slice(0, 5) });
    } catch (e) { setScout({ err: "Market scout failed: " + (e.message || "?") }); }
  };
  const designListing = (l) => {
    onParcel({
      id: "mkt-" + Date.now(), name: l.title || "Market Listing", region: pin.label.split(",").slice(-3).join(",").trim(),
      acres: l.acres || 0.5, price: l.price || 400000, taxRate: l.taxRate || 0.011,
      vibe: (l.blurb || "AI market snapshot") + " · representative listing — verify via Zillow/Realtor",
      coords: { lat: pin.lat, lon: pin.lon }, mapLabel: pin.label,
      existingHome: l.kind === "home" ? { value: Math.round((l.price || 400000) * 0.72), sqft: l.sqft || 2200 } : null,
    });
  };
  const randomSpot = async () => {
    setRolling(true);
    let placedOk = false;
    for (let i = 0; i < 3 && !placedOk; i++) {
      const [lat, lon] = randomLandPoint();
      try {
        const r = await fetchT(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10`, {}, 5000);
        const d = await r.json();
        if (d && d.display_name && !/ocean|sea$/i.test(d.display_name)) {
          placePin(lat, lon, d.display_name);
          mapRef.current?.setView([lat, lon], 15);
          placedOk = true;
        }
      } catch { break; /* geocoder blocked — go straight to AI naming */ }
    }
    if (!placedOk) {
      const [lat, lon] = randomLandPoint();
      let label = `Mystery parcel · ${lat.toFixed(3)}, ${lon.toFixed(3)}`;
      try {
        const text = await askAI(`What named place is at or nearest to latitude ${lat.toFixed(3)}, longitude ${lon.toFixed(3)}? Respond ONLY with JSON, no fences: {"label":"Place/area, Region, Country"}`, 25000);
        const p = pickJSON(text);
        if (p.label) label = p.label;
      } catch { /* keep coordinates label */ }
      placePin(lat, lon, label);
      mapRef.current?.setView([lat, lon], 14);
    }
    setRolling(false);
  };

  /* connection diagnostics — geo tested on load; AI tested only when used,
     because auto-firing AI calls crashes some mobile runtimes */
  const [diag, setDiag] = useState({ geo: "…", ai: "UNTESTED" });
  useEffect(() => {
    (async () => {
      try {
        const r = await fetchT("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=paris", {}, 6000);
        const d = await r.json();
        setDiag((x) => ({ ...x, geo: Array.isArray(d) && d.length ? "OK" : "BLOCKED" }));
      } catch { setDiag((x) => ({ ...x, geo: "BLOCKED" })); }
    })();
  }, []);

  return (
    <div className="map-block">
      <div className="map-toolbar">
        <input className="search sm" placeholder="Search any address, city, or place on Earth…"
          value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && runSearch()} />
        <button className="btn-orange sm" onClick={runSearch}>Search</button>
        <button className="btn-ghost xs" onClick={aiLocate}>⚡ AI locate</button>
        <button className="btn-ghost xs" onClick={toggleSat} disabled={status !== "ready"}>{sat ? "Street view" : "Satellite"}</button>
        <button className="btn-ghost xs" onClick={randomSpot} disabled={rolling} title="Drop somewhere random on the planet and build there">{rolling ? "Rolling…" : "🎲 Anywhere on Earth"}</button>
        {!tracing
          ? <button className="btn-ghost xs" onClick={startTrace} disabled={status !== "ready"} title="Tap the corners of the real lot on satellite — acreage is computed for you">✏ Trace parcel</button>
          : <>
              <button className="btn-orange sm" onClick={finishTrace} disabled={tracePts.length < 3}>✓ Finish ({tracePts.length} pts)</button>
              <button className="btn-ghost xs" onClick={clearTrace}>Cancel</button>
            </>}
        {tracedPoly && !tracing && <button className="btn-ghost xs" onClick={clearTrace}>Clear trace</button>}
      </div>
      {recent.length > 0 && (
        <div className="recent-row">
          <span className="ai-label" style={{ margin: 0 }}>RECENT:</span>
          {recent.map((r) => (
            <button key={r.label} className="ctab" onClick={() => { placePin(r.lat, r.lon, r.label); mapRef.current?.setView([r.lat, r.lon], 15); }}>{r.label.split(",")[0]}</button>
          ))}
        </div>
      )}
      {tracing && <div className="trace-hint">Zoom into your lot on satellite, then tap each corner of the real boundary. Finish with 3+ points — acreage is computed from your trace.</div>}
      <div className="diag-strip">
        CONNECTIONS — MAP TILES: {status === "ready" ? "OK" : status === "tiles-blocked" ? "BLOCKED" : status.toUpperCase()} · GEO SEARCH: {diag.geo} · AI LINK: {diag.ai}
        {typeof window !== "undefined" && window.__aiDiag ? ` [${window.__aiDiag}]` : ""}
        {diag.geo === "BLOCKED" && diag.ai === "OK" && " — use ⚡ AI locate or 🎲; everything else works."}
        {diag.ai === "BLOCKED" && !getApiKey() && " — paste an Anthropic API key below to enable AI features on this site."}
      </div>
      <ApiKeyBar onSaved={() => setDiag((x) => ({ ...x, ai: "UNTESTED" }))} />
      <AccountBar onSession={() => refreshProjects()} />
      <IntegrationsBar />
      {results.length > 0 && (
        <div className="geo-results">
          {results.map((r, i) => r.loading ? <div key={i} className="geo-row muted">{r.msg || "Searching…"}</div>
            : r.error ? <div key={i} className="geo-row errrow">{r.error}</div>
            : r.empty ? <div key={i} className="geo-row muted">No places found — try a broader search.</div>
            : <button key={i} className="geo-row" onClick={() => pickResult(r)}>{r.display_name}</button>)}
        </div>
      )}
      <div ref={divRef} className="map-canvas">
        {status === "loading" && <div className="map-msg">Loading world map…</div>}
        {status === "failed" && <div className="map-msg">Map couldn't load in this environment — type any address or place above and hit Search: TapaCasa will locate it by AI and you can appraise & design as normal.</div>}
        {status === "tiles-blocked" && <div className="map-msg blocked">Satellite tiles are blocked in this sandbox, so the map looks blank — but everything still works. Search any address or place above (AI-located), then appraise & design. Terrain and pricing don't need the tiles.</div>}
      </div>
      {pin && (
        <div className="pin-bar">
          <div className="pin-label">📍 {pin.label}</div>
          <div className="pin-controls">
            <label className="pin-acres">Parcel size
              <input type="number" min="0.05" max="500" step="0.1" value={acres} disabled={!!tracedPoly}
                onChange={(e) => setAcres(Math.max(0.05, +e.target.value || 0.05))} /> acres
              {tracedPoly && <span className="trace-badge">✏ from trace · {Math.round(tracedPoly.w)}′×{Math.round(tracedPoly.h)}′</span>}
            </label>
            <button className="btn-orange sm" onClick={appraise} disabled={appraising}>
              {appraising ? "Appraising…" : "✦ Appraise & design this parcel"}
            </button>
            {(
              <button className="btn-ghost xs" onClick={async () => {
                try {
                  let d;
                  try { d = await svcFetch("parcel", { lat: pin.lat, lon: pin.lon }, 12000); }
                  catch (e1) {
                    if (!getK("regrid")) throw new Error("needs a Regrid subscription (server REGRID_TOKEN or ⚙ token)");
                    const r = await fetchT(`https://app.regrid.com/api/v2/parcels/point?lat=${pin.lat}&lon=${pin.lon}&token=${getK("regrid")}`, {}, 12000);
                    d = await r.json();
                  }
                  const geom = d?.parcels?.features?.[0]?.geometry;
                  const ring = geom?.type === "Polygon" ? geom.coordinates[0] : geom?.type === "MultiPolygon" ? geom.coordinates[0][0] : null;
                  if (!ring) throw new Error("no parcel here");
                  const poly = polyFromLatLng(ring.map(([lo, la]) => [la, lo]));
                  setTracedPoly(poly);
                  setAcres(Math.max(0.02, poly.acres));
                  if (window.L && mapRef.current) {
                    if (polyLayerRef.current) mapRef.current.removeLayer(polyLayerRef.current);
                    polyLayerRef.current = window.L.polygon(ring.map(([lo, la]) => [la, lo]), { color: "#FF7A29", weight: 2.5, fillOpacity: 0.12 }).addTo(mapRef.current);
                  }
                } catch (e) { setApprErr("Official parcel lookup failed: " + (e?.message || "no data")); }
              }}>▦ Load official parcel</button>
            )}
          </div>
          <div className="ext-links">
            Browse real listings nearby:&nbsp;
            {listingLinks(pin.label).map(([n, url]) => (
              <a key={n} href={url} target="_blank" rel="noopener noreferrer">{n} ↗</a>
            ))}
          </div>
          {getK("google") && (
            <img className="sv-img" alt="Street view near this pin"
              src={`https://maps.googleapis.com/maps/api/streetview?size=640x300&location=${pin.lat},${pin.lon}&key=${getK("google")}`}
              onError={(e) => { e.currentTarget.style.display = "none"; }} />
          )}
          <div className="ext-links">
            Official parcel boundaries & owners:&nbsp;
            <a href={`https://www.google.com/search?q=${encodeURIComponent(pin.label.split(",").slice(1, 4).join(" ") + " county parcel viewer GIS map")}`} target="_blank" rel="noopener noreferrer">County GIS ↗</a>
            <a href="https://app.regrid.com/map" target="_blank" rel="noopener noreferrer">Regrid ↗</a>
            <span className="muted-note">— check the recorded plat, then trace it here for an exact match</span>
          </div>
          {apprErr && <div className="ai-err">{apprErr}</div>}
          <button className="btn-ghost wide" onClick={scoutMarket} disabled={scout?.busy}>
            {scout?.busy ? "Scouting the market…" : "🔎 Scout the market here — real-style listings to design"}
          </button>
          {scout?.err && <div className="ai-err">{scout.err}</div>}
          {scout?.items && (
            <div className="scout-list">
              <div className="ai-label">AI MARKET SNAPSHOT — REPRESENTATIVE OF THIS AREA · VERIFY REAL LISTINGS VIA THE LINKS ABOVE</div>
              {scout.items.map((l, i) => (
                <div key={i} className="scout-card">
                  <div className="ic-top">
                    <div>
                      <div className="ic-name">{l.kind === "home" ? "🏠" : "🌲"} {l.title}</div>
                      <div className="ic-vendor">{l.acres} AC{l.beds ? ` · ${l.beds} BD · ${(l.sqft || 0).toLocaleString()} SQFT` : ""} · TAX {((l.taxRate || 0.01) * 100).toFixed(2)}%</div>
                    </div>
                    <div className="ic-price">{fmt(l.price)}</div>
                  </div>
                  <div className="ic-desc">{l.blurb}</div>
                  <button className="btn-orange sm" onClick={() => designListing(l)}>🏗 Design this property</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────── PRINT / PDF SHEET ─────────── */
function PrintSheet({ location, placed, totals, roomsByFloor, floorTabs, perFloorSqft, snapUrl }) {
  return (
    <div className="print-sheet">
      <div className="ps-head">
        <div>
          <div className="ps-brand">⌂ TAPACASA</div>
          <h1>{location.name}</h1>
          <div className="ps-sub">{location.region} · {location.acres} acres · {location.vibe}</div>
          {location.terrain && (
            <div className="ps-sub">Terrain: elev {location.terrain.elevFt.toLocaleString()} ft · {location.terrain.slopePct}% slope falling {location.terrain.downhill} ({location.terrain.grade})</div>
          )}
        </div>
        <div className="ps-totals">
          <div><span>PROJECT TOTAL</span><b>{fmt(totals.total)}</b></div>
          <div><span>Land</span><b>{fmt(totals.land)}</b></div>
          <div><span>Build & contents</span><b>{fmt(totals.build)}</b></div>
          <div><span>Property tax / yr</span><b>{fmt(totals.tax)}</b></div>
        </div>
      </div>
      <div className="ps-cap">SITE PLAN</div>
      <SitePlan location={location} items={placed.filter((p) => p.fp)} selected={null}
        onSelect={() => {}} onMove={() => {}} viewFt={99999} satOn={!!location.coords} print />
      {floorTabs.map((f) => (
        <div key={f}>
          <div className="ps-cap">{f === "B" ? "BASEMENT" : `LEVEL ${f}`} FLOOR PLAN</div>
          <FloorPlan houseSqft={perFloorSqft} floorLabel={f === "B" ? "BASEMENT" : `LEVEL ${f}`}
            rooms={roomsByFloor[f] || {}} selectedRoom={null} onSelectRoom={() => {}} print />
        </div>
      ))}
      {snapUrl && (<div><div className="ps-cap">3D VIEW</div><img src={snapUrl} style={{ width: "100%", border: "1px solid #B9CBDD" }} alt="3D view of the design" /></div>)}
      <div className="ps-cap">COST SCHEDULE</div>
      <table className="ps-table">
        <thead><tr><th>Item</th><th>Vendor</th><th>Room / Floor</th><th>Notes</th><th>Price</th></tr></thead>
        <tbody>
          <tr><td>Land — {location.name}</td><td>{location.region}</td><td></td><td></td><td>{fmt(location.price)}</td></tr>
          {placed.map((p) => (
            <tr key={p.uid}>
              <td>{p.name}</td><td>{p.vendor}</td>
              <td>{p.fp ? "Site" : `${p.room || "—"}${p.floor && p.floor !== "1" ? ` · ${p.floor === "B" ? "Bsmt" : "L" + p.floor}` : ""}`}</td>
              <td>{p.notes || ""}</td><td>{fmt(p.price)}</td>
            </tr>
          ))}
          <tr className="ps-total"><td colSpan="4">PROJECT TOTAL</td><td>{fmt(totals.total)}</td></tr>
          <tr><td colSpan="4">Est. property tax / yr ({(location.taxRate * 100).toFixed(2)}%)</td><td>{fmt(totals.tax)}</td></tr>
        </tbody>
      </table>
      <p className="ps-fine">Generated by TapaCasa · {new Date().toLocaleDateString()} · Values are illustrative estimates; vendors are fictional; verify locally.</p>
    </div>
  );
}

/* ═══════════════ MAIN APP ═══════════════ */
class ErrorShield extends Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (this.state.err) {
      return (
        <div style={{ minHeight: "100vh", background: "#0C2340", color: "#DCEBFA", fontFamily: "system-ui", padding: 24 }}>
          <h2 style={{ color: "#FF9A52" }}>⌂ TapaCasa hit a snag in this environment</h2>
          <p style={{ lineHeight: 1.6, maxWidth: 560 }}>Something this preview sandbox blocked caused a crash: <code>{String(this.state.err?.message || this.state.err)}</code></p>
          <button style={{ background: "#FF7A29", border: "none", padding: "12px 18px", fontWeight: 700, cursor: "pointer" }}
            onClick={() => this.setState({ err: null })}>Reload TapaCasa</button>
        </div>
      );
    }
    return this.props.children;
  }
}

const IN_SANDBOX = (() => {
  try {
    if (typeof window === "undefined") return false;
    if (window.claude && typeof window.claude.complete === "function") return true;
    return window.top !== window.self; // iframed = embedded preview
  } catch { return true; } // cross-origin iframe check throws → definitely embedded
})();

function SandboxBanner() {
  if (!IN_SANDBOX) return null;
  return (
    <div style={{ background: "#FF7A29", color: "#14243D", padding: "12px 16px", fontFamily: "system-ui", fontSize: 13.5, lineHeight: 1.5, fontWeight: 600 }}>
      ⚠ You're viewing TapaCasa inside an app preview that blocks maps &amp; AI.
      To run the real thing from your phone: share this file → Save to Files →
      then in Safari/Chrome go to tiiny.host, upload it, and open your new link.
      When this banner is gone, you're running for real.
    </div>
  );
}

function LegendRows() {
  const Row = ({ chip, label }) => (
    <div className="lg-row">{chip}<span>{label}</span></div>
  );
  return (
    <div>
      <Row chip={<span className="lg-chip" style={{ border: "2px dashed #BFDCF5" }} />} label="Parcel boundary (dashed) — traced or estimated lot line" />
      <Row chip={<span className="lg-chip" style={{ background: "repeating-linear-gradient(45deg,#2A4A72 0 3px,#102C4E 3px 6px)", border: "1.5px solid #EAF4FF" }} />} label="Structure — buildings & built amenities (drag to place, tap in 3D to restyle)" />
      <Row chip={<span className="lg-chip" style={{ background: "radial-gradient(circle,#8CDCAA 1.5px,transparent 2px) 0 0/7px 7px #102C4E", border: "1.5px solid #8CDCAA", borderRadius: 8 }} />} label="Landscaping — trees, gardens, lawns (rounded green)" />
      <Row chip={<span className="lg-chip" style={{ background: "#b09a72" }} />} label="Cleared/graded ground — demolition pads & land clearing" />
      <Row chip={<span className="lg-chip" style={{ border: "2px dashed #c9c2b4" }} />} label="Existing as-built home — demolish it to redesign from bare land" />
      <Row chip={<span className="lg-chip" style={{ background: "#FF7A29" }} />} label="Selected item — rotate, remove, or restyle" />
    </div>
  );
}

function WelcomeGuide({ open, onClose }) {
  const [tab, setTab] = useState("start");
  if (!open) return null;
  const GLOSSARY = [
    ["Appraisal", "An estimate of what land or property is worth on the market. TapaCasa's AI appraises from real regional price levels."],
    ["Effective tax rate", "The % of a property's value paid in property tax each year. Varies hugely by region — TapaCasa uses the local rate."],
    ["Footprint", "The ground area a structure covers, width × depth in feet. Everything here is true to real-world size."],
    ["Building envelope", "The zoomed-in area of your lot where you're actively placing things."],
    ["Clearing & grading", "Removing trees/structures and leveling the ground so it's buildable."],
    ["Soft costs", "Real-project costs beyond construction: architect & engineering fees, permits, and contingency."],
    ["Contingency", "Budget reserve (typically ~10%) for the unexpected — every real build needs it."],
    ["Plat / parcel", "The official recorded map and boundary of a piece of land, held by the county."],
    ["Turnkey", "Finished and ready to move in — nothing left for the buyer to build."],
    ["$/sq ft", "Construction cost per square foot — the standard way builders compare projects."],
  ];
  return (
    <div className="guide-scrim" onClick={onClose}>
      <div className="guide" onClick={(e) => e.stopPropagation()}>
        <div className="cat-tabs">
          {[["start", "Quick start"], ["legend", "Map legend"], ["gloss", "Glossary"], ["tips", "Pro tips"]].map(([k, l]) => (
            <button key={k} className={tab === k ? "ctab on" : "ctab"} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        {tab === "start" && (<div>
          <h3>⌂ Welcome to TapaCasa</h3>
          <p><b>1 · Claim your ground.</b> Search any address, tap the satellite map, 🎲 roll a random spot on Earth, or grab a curated listing. ✏ Trace the real boundary for an exact lot.</p>
          <p><b>2 · Dream it in.</b> Add anything from the catalog — or tell the ✦ Design Director in plain words: "infinity pool behind the house, cypress along the drive." Or hit ✨ Surprise me and let it design the whole property.</p>
          <p><b>3 · Live in it.</b> 🚶 Walk your land in 3D, tap buildings to restyle them, carve real structures away in 🌍 Photoreal, arrange rooms floor by floor — then 🔗 share the link or print the blueprint.</p>
        </div>)}
        {tab === "legend" && (<div><h3>Reading the site plan</h3><LegendRows /></div>)}
        {tab === "gloss" && (<div className="gloss">
          <h3>Plain-English glossary</h3>
          {GLOSSARY.map(([t, d]) => <p key={t}><b>{t}</b> — {d}</p>)}
        </div>)}
        {tab === "tips" && (<div>
          <h3>Pro tips</h3>
          <p><b>🎨 Tap any building in 3D</b> to change wall color, roof color, and roof shape.</p>
          <p><b>🏗 Demolish & clear:</b> demolishing an existing home (or dragging "Land Clearing" over anything) carves it out of the real world in 🌍 Photoreal.</p>
          <p><b>🔗 Share links</b> carry your entire design — send one to a client or partner.</p>
          <p><b>Budget field</b> shows live over/under. <b>⬇ CSV</b> exports a contractor-ready schedule. <b>⎙ Print</b> makes a blueprint pack (with your last 📸 snapshot).</p>
          <p><b>Rooms:</b> adding a house auto-fills a realistic floor plan — add rooms per level and give every item a home.</p>
        </div>)}
        <button className="btn-orange" onClick={onClose}>Let's build →</button>
      </div>
    </div>
  );
}

export default function TapaCasa() {
  return <ErrorShield><SandboxBanner /><TapaCasaApp /></ErrorShield>;
}

function TapaCasaApp() {
  const [location, setLocation] = useState(null);
  const [placed, setPlaced] = useState([]);
  const [activeCat, setActiveCat] = useState("Structure");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const [viewFt, setViewFt] = useState(450);
  const [mobileTab, setMobileTab] = useState("plan");
  const [director, setDirector] = useState("");
  const [ai, setAi] = useState({ busy: false, err: null, note: null });
  const [customItems, setCustomItems] = useState([]);
  const [listing, setListing] = useState(null); // {busy, text}
  const [projects, setProjects] = useState([]);
  const [projName, setProjName] = useState("");
  const [saveMsg, setSaveMsg] = useState("");
  const [planView, setPlanView] = useState("site");
  const [selectedRoom, setSelectedRoom] = useState(null);
  const [budget, setBudget] = useState("");
  const [softCosts, setSoftCosts] = useState(true);
  const [compareSel, setCompareSel] = useState([]);
  const [compare, setCompare] = useState(null);
  const [satOn, setSatOn] = useState(true);
  const [floorSel, setFloorSel] = useState("1");
  const [newRoom, setNewRoom] = useState("");
  const [snapUrl, setSnapUrl] = useState(null);
  const [nearby, setNearby] = useState(null);
  const [customRooms, setCustomRooms] = useState([]);
  const seedRooms = (label) => {
    const m = label.match(/([\d,]+)/);
    const sq = m ? +m[1].replace(/,/g, "") : 3000;
    const base = ["Foyer", "Great Room", "Kitchen", "Dining Room", "Primary Suite", "Bedroom 2", "Laundry"];
    if (sq >= 5000) base.push("Bedroom 3", "Home Office", "Media Room");
    if (sq >= 8000) base.push("Gym", "Guest Suite", "Library");
    if (sq >= 12000) base.push("Bedroom 4", "Conservatory", "Staff Suite");
    setCustomRooms((r) => {
      const have = new Set(r.map((x) => x.name));
      return [...r, ...base.filter((n) => !have.has(n)).map((n) => ({ name: n, floor: "1" }))];
    });
  };
  const scoutNearby = async () => {
    if (!location.coords) return;
    setNearby({ busy: true });
    const types = [["school", "🏫 Schools"], ["supermarket", "🛒 Groceries"], ["restaurant", "🍽 Restaurants"], ["hospital", "🏥 Medical"]];
    const out = [];
    for (const [type, label] of types) {
      try {
        const d = await svcFetch("google", { type: "places", params: { location: `${location.coords.lat},${location.coords.lon}`, radius: 4000, type } }, 9000);
        const names = (d.results || []).slice(0, 3).map((p) => p.name);
        if (names.length) out.push([label, names.join(" · ")]);
      } catch { /* skip type */ }
    }
    setNearby(out.length ? { rows: out } : { err: "Nearby lookup needs the server GOOGLE_API_KEY with Places API enabled." });
  };
  const [showGuide, setShowGuide] = useState(() => { try { return !localStorage.getItem("tapacasa_seen"); } catch { return true; } });
  const closeGuide = () => { setShowGuide(false); try { localStorage.setItem("tapacasa_seen", "1"); } catch { /* ok */ } };
  const dropSpot = useRef(0);

  /* undo / redo */
  const placedRef = useRef(placed);
  useEffect(() => { placedRef.current = placed; }, [placed]);
  const past = useRef([]);
  const future = useRef([]);
  const snap = () => { past.current = [...past.current.slice(-49), JSON.stringify(placedRef.current)]; future.current = []; };
  const undo = () => { if (!past.current.length) return; future.current.push(JSON.stringify(placedRef.current)); setPlaced(JSON.parse(past.current.pop())); };
  const redo = () => { if (!future.current.length) return; past.current.push(JSON.stringify(placedRef.current)); setPlaced(JSON.parse(future.current.pop())); };
  const resetHistory = () => { past.current = []; future.current = []; };

  const refreshProjects = async () => {
    if (sbOn() && sbSession.get()) {
      try {
        const rows = await cloudList();
        setProjects(rows.map((r) => ({ id: r.id, cloud: true, name: r.name, savedAt: +new Date(r.updated_at), ...(r.data || {}) })));
        return;
      } catch { /* fall back to local */ }
    }
    loadProjects().then(setProjects);
  };
  useEffect(() => {
    refreshProjects();
    try {
      const h = window.location.hash;
      if (h && h.startsWith("#d=")) {
        const d = decodeShare(h.slice(3));
        if (d && d.l) { setLocation(d.l); setPlaced(d.p || []); setCustomRooms(d.r || []); setSatOn(!!d.l.coords); }
      }
    } catch { /* bad link */ }
  }, []);

  const houseSqft = useMemo(() => {
    const h = placed.find((p) => p.itemId === "house");
    if (h) { const m = h.variants[h.variantIdx][0].match(/([\d,]+)\s*sq ft/i); if (m) return +m[1].replace(/,/g, ""); }
    const ex = placed.find((p) => p.existing);
    if (ex) { const m = ex.variants[0][0].match(/([\d,]+)/); if (m) return +m[1].replace(/,/g, ""); }
    return 3000;
  }, [placed]);

  const exportCSV = () => {
    const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    const rows = [
      ["Item", "Vendor", "Category", "Room", "Notes", "Price USD"],
      [`Land — ${location.name}`, location.region, "Land", "", location.vibe, location.price],
      ...placed.map((p) => [p.name, p.vendor, catOf(p), p.room || "", p.notes || "", p.price]),
      [], ["PROJECT TOTAL", "", "", "", "", totals.total],
      [`Property tax / yr (${(location.taxRate * 100).toFixed(2)}%)`, "", "", "", "", Math.round(totals.tax)],
    ];
    const csv = rows.map((r) => r.map(esc).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = "tapacasa-spec.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  const lotSqft = location ? location.acres * ACRE_SQFT : 0;
  const lotW = location ? Math.sqrt(lotSqft * 1.4) : 0;

  const nextSpot = (w, d) => {
    const win = Math.min(viewFt, lotW || 450);
    const n = dropSpot.current++;
    return {
      x: Math.min(win - w - 5, 15 + (n % 4) * (win / 4.5)),
      y: Math.min(win * 0.6, 15 + Math.floor(n / 4) * 45) ,
    };
  };

  const addItem = (item, variantIdx = 0, extra = {}, skipSnap = false) => {
    if (!skipSnap) snap();
    const v = item.variants[variantIdx];
    const fp = extra.fp || v[2] || item.footprint;
    const spot = fp ? nextSpot(fp[0], fp[1]) : { x: 0, y: 0 };
    const uid = Date.now() + Math.random();
    setPlaced((p) => [...p, {
      uid, itemId: item.id, name: item.name, vendor: item.vendor,
      variantIdx, price: v[1], baseFp: item.footprint, fp, rot: !!extra.rot,
      variants: item.variants, landscape: item.landscape || CATALOG[2].items.some((i) => i.id === item.id),
      room: extra.room || "", notes: extra.notes || "", floor: extra.floor || "1",
      x: extra.x ?? spot.x, y: extra.y ?? spot.y,
    }]);
    if (item.id === "house") seedRooms(v[0]);
    return uid;
  };

  const patch = (uid, fields) => setPlaced((p) => p.map((i) => (i.uid === uid ? { ...i, ...fields } : i)));
  const changeVariant = (uid, idx) => { snap(); setPlaced((p) => p.map((i) => i.uid === uid ? { ...i, variantIdx: idx, price: i.variants[idx][1], fp: i.variants[idx][2] || i.baseFp } : i)); };
  const removeItem = (uid, skipSnap = false) => { if (!skipSnap) snap(); setPlaced((p) => p.filter((i) => i.uid !== uid)); if (selected === uid) setSelected(null); };

  const totals = useMemo(() => {
    const build = placed.reduce((s, i) => s + i.price, 0);
    const land = location ? location.price : 0;
    const soft = softCosts ? Math.round(build * 0.195) : 0;
    const total = land + build + soft;
    const months = build > 0 ? Math.min(36, Math.round(6 + (build / 1000000) * 2.2)) : 0;
    const tax = location ? total * location.taxRate : 0;
    const monthly = (total * 0.8 * (0.065 / 12)) / (1 - Math.pow(1 + 0.065 / 12, -360));
    return { build, land, soft, months, total, tax, monthly };
  }, [placed, location, softCosts]);

  /* ── AI DESIGN DIRECTOR: natural language → implemented items ── */
  const AUTO_PROMPT = "Design this entire property tastefully for its location: a fitting main residence sized for the lot, a driveway, a pool or water feature if the climate suits, a patio/outdoor living area, and regional landscaping (trees, hedges, gardens). Fill the lot sensibly with 5-6 items.";
  const runDirector = async (override) => {
    const req = (typeof override === "string" ? override : director).trim();
    if (!req || !location) return;
    setAi({ busy: true, err: null, note: null });
    const win = Math.min(viewFt, lotW);
    const existing = placed.map((p) => `${p.name}${p.fp ? ` at (${Math.round(p.x)},${Math.round(p.y)}) ft, ${p.fp[0]}×${p.fp[1]}` : p.room ? ` in ${p.room}` : ""}`).join("; ") || "nothing yet";
    try {
      const text = await askAI(
`You are the design director inside a property-design app. The property is located in ${location.region}${location.mapLabel ? " (" + location.mapLabel + ")" : ""} — use vendor names that sound like plausible LOCAL specialty companies for that region, and price at that region's actual market level (shown in USD). The visible site plan is a ${Math.round(win)}×${Math.round(win * 0.75)} ft area (origin top-left, x→right, y→down). Already on the plan/spec: ${existing}.

The user requests: "${req}"

Implement it. Respond with ONLY JSON, no fences, no preamble:
{"summary":"one sentence describing what you did","items":[{"name":"Title Case name","vendorType":"plausible fictional specialty company","price":realistic installed USD number,"footprintW":feet number or null if interior/furniture/finish,"footprintD":feet or null,"x":feet from left or null,"y":feet from top or null,"room":"room name if interior, else empty string","notes":"how it should look, per the user's description","desc":"one-line spec"}]}

Rules: realistic market pricing; place footprint items sensibly relative to existing items and the user's wording (e.g. 'next to the pool', 'along the north edge' = small y, 'front' = large y); split a request into multiple items when natural (max 6); keep footprints true to real-world size.`);
      const parsed = pickJSON(text);
      const list = Array.isArray(parsed.items) ? parsed.items : [];
      if (!list.length) throw new Error("empty");
      snap();
      const added = [];
      list.forEach((p) => {
        const fp = p.footprintW && p.footprintD ? [Number(p.footprintW), Number(p.footprintD)] : null;
        const item = {
          id: "custom-" + Date.now() + Math.random(),
          name: p.name || "Custom Feature",
          vendor: p.vendorType || "Specialty Contractor",
          desc: p.desc || "Custom-quoted feature",
          footprint: fp, landscape: /tree|hedge|garden|flower|meadow|lawn|shrub|planting|orchard/i.test(p.name || ""),
          variants: [["As quoted", Number(p.price) || 25000, fp || undefined]],
          custom: true,
        };
        setCustomItems((c) => [item, ...c]);
        addItem(item, 0, {
          room: p.room || "", notes: p.notes || "",
          x: fp && p.x != null ? Math.max(0, Math.min(win - fp[0], Number(p.x))) : undefined,
          y: fp && p.y != null ? Math.max(0, Math.min(win * 0.75 - fp[1], Number(p.y))) : undefined,
        }, true);
        added.push(item.name);
      });
      setAi({ busy: false, err: null, note: parsed.summary || `Added: ${added.join(", ")}` });
      setDirector("");
    } catch {
      setAi({ busy: false, err: "Couldn't implement that — try rephrasing or being more specific.", note: null });
    }
  };

  /* ── LISTING / WALKTHROUGH GENERATOR ── */
  const generateListing = async () => {
    setListing({ busy: true, text: "" });
    const spec = placed.map((p) => `${p.name} (${fmt(p.price)})${p.room ? ` — ${p.room}` : ""}${p.notes ? ` — ${p.notes}` : ""}`).join("\n");
    try {
      const text = await askAI(
`Write a polished real-estate listing description (150-220 words) followed by a short bulleted feature sheet for this property. Warm but professional realtor voice, no headers other than a listing title line.

Location: ${location.name}, ${location.region} — ${location.acres} acres. ${location.vibe}.
Total project value: ${fmt(totals.total)}. Annual property tax est: ${fmt(totals.tax)}.
Features:\n${spec || "Vacant land only."}`);
      setListing({ busy: false, text });
    } catch {
      setListing({ busy: false, text: "Couldn't generate the listing — try again in a moment." });
    }
  };

  /* ── SAVE / LOAD ── */
  const saveProject = async () => {
    const name = projName.trim() || `${location.name} — ${new Date().toLocaleDateString()}`;
    if (sbOn() && sbSession.get()) {
      try {
        await cloudSave(name, { location, placed, customItems, customRooms });
        await refreshProjects();
        setSaveMsg(`☁ Saved "${name}" to your account`);
        setProjName("");
        setTimeout(() => setSaveMsg(""), 3500);
        return;
      } catch (e) { setSaveMsg("Cloud save failed (" + (e.message || "?") + ") — saved locally instead."); }
    }
    const next = [{ id: Date.now(), name, savedAt: Date.now(), location, placed, customItems, customRooms }, ...projects.filter((p) => p.name !== name)].slice(0, 12);
    setProjects(next);
    const ok = await saveProjects(next);
    setSaveMsg(ok ? `Saved "${name}"` : "Saved for this session (storage unavailable)");
    setProjName("");
    setTimeout(() => setSaveMsg(""), 3500);
  };
  const openProject = (p) => {
    setLocation(p.location); setPlaced(p.placed || []); setCustomItems(p.customItems || []); setCustomRooms(p.customRooms || []);
    setSelected(null); setMobileTab("plan");
  };
  const deleteProject = async (id) => {
    const proj = projects.find((p) => p.id === id);
    if (proj?.cloud) { try { await cloudDelete(id); } catch { /* ok */ } await refreshProjects(); return; }
    const next = projects.filter((p) => p.id !== id);
    setProjects(next); await saveProjects(next);
  };

  const selItem = placed.find((p) => p.uid === selected);

  /* ── open a parcel; seed an existing house if the lot is developed ── */
  const openParcel = (loc) => {
    setPlaced([]); setSelected(null); dropSpot.current = 0; resetHistory();
    setSatOn(!!loc.coords); setFloorSel("1");
    setLocation(loc);
    if (loc.existingHome && loc.existingHome.value > 0) {
      const side = Math.sqrt((loc.existingHome.sqft || 2000) / 0.75);
      const fp = [Math.round(side * 1.2), Math.round(side * 0.9)];
      setPlaced([{
        uid: Date.now(), itemId: "existing", name: "Existing Residence",
        vendor: "As-built · included in parcel price", variantIdx: 0,
        price: 0, baseFp: fp, fp, rot: false,
        variants: [[`${(loc.existingHome.sqft || 2000).toLocaleString()} sq ft as-built`, 0]],
        landscape: false, existing: true, room: "", notes: `Existing home valued ≈ ${fmt(loc.existingHome.value)} (in land price). Demolish to redesign from scratch.`,
        x: 30, y: 30,
      }]);
    }
  };

  const demolish = (uid) => {
    snap();
    const old = placed.find((p) => p.uid === uid);
    removeItem(uid, true);
    addItem(DEMO_ITEM, 0, old && old.fp ? { x: old.x, y: old.y, fp: old.fp, rot: old.rot } : {}, true);
  };

  /* ─────────── COMPARISON SCREEN ─────────── */
  if (compare) {
    return <CompareView a={compare[0]} b={compare[1]}
      onClose={() => setCompare(null)}
      onOpen={(p) => { setCompare(null); setCompareSel([]); openProject(p); }} />;
  }

  const toggleCompare = (id) => setCompareSel((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s.slice(-1), id]);

  /* ─────────── LOCATION SCREEN ─────────── */
  if (!location) {
    return (
      <div className="app"><Style />
        <WelcomeGuide open={showGuide} onClose={closeGuide} />
        <header className="hdr">
          <div className="hdr-mark">⌂</div>
          <div style={{ flex: 1 }}><h1>TapaCasa</h1><p className="hdr-sub">SHEET 1 — SITE SELECTION · ANYWHERE ON EARTH · v17-HORIZON</p></div>
          <button className="btn-ghost xs" onClick={() => setShowGuide(true)}>? How it works</button>
        </header>
        <div className="loc-wrap">
          <div className="loc-intro">
            <h2>Choose your ground. Anywhere.</h2>
            <p>Search a real address or tap the map — satellite view included. TapaCasa appraises the parcel (land value, taxes, and whether there's a house to tear down), then you design. Or pick a curated listing, reopen a saved project, or roll a random lot.</p>
          </div>
          <MapPicker onParcel={openParcel} />
          {projects.length > 0 && (
            <div className="saved-block">
              <div className="curated-head">
                <div className="panel-head nb">SAVED PROJECTS — TICK TWO TO COMPARE</div>
                {compareSel.length === 2 && (
                  <button className="btn-orange sm" onClick={() => setCompare(compareSel.map((id) => projects.find((p) => p.id === id)))}>
                    ⇄ Compare designs
                  </button>
                )}
              </div>
              <div className="saved-list">
                {projects.map((p) => (
                  <div key={p.id} className="saved-row">
                    <input type="checkbox" className="cmp-check" checked={compareSel.includes(p.id)}
                      onChange={() => toggleCompare(p.id)} aria-label={`Compare ${p.name}`} />
                    <button className="saved-open" onClick={() => openProject(p)}>
                      <b>{p.name}</b>
                      <span>{p.location.region} · {(p.placed || []).length} items · {new Date(p.savedAt).toLocaleDateString()}</span>
                    </button>
                    <button className="chip-x" onClick={() => deleteProject(p.id)} aria-label={`Delete ${p.name}`}>×</button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="curated-head">
            <div className="panel-head nb">CURATED LISTINGS</div>
            <button className="btn-ghost xs" onClick={() => openParcel(randomListing())}>⌖ Random parcel</button>
          </div>
          <div className="loc-grid">
            {LISTINGS.map((l) => (
              <button key={l.id} className="loc-card" onClick={() => openParcel(l)}>
                <div className="loc-region">{l.region.toUpperCase()}</div>
                <div className="loc-name">{l.name}</div>
                <div className="loc-vibe">{l.vibe}</div>
                <div className="loc-meta"><span>{l.acres} AC</span><span className="loc-price">{fmt(l.price)}</span><span>{(l.taxRate * 100).toFixed(2)}% TAX</span></div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  /* ─────────── BUILD SCREEN ─────────── */
  const cats = [...CATALOG.map((c) => c.cat), ...(customItems.length ? ["Custom"] : [])];
  const q = search.trim().toLowerCase();
  const visibleItems = q
    ? [...ALL_ITEMS, ...customItems].filter((i) => (i.name + i.desc + i.vendor).toLowerCase().includes(q))
    : activeCat === "Custom" ? customItems : CATALOG.find((c) => c.cat === activeCat)?.items || [];

  const rooms = {};
  const roomsByFloor = {};
  placed.filter((p) => !p.fp).forEach((p) => {
    const r = p.room || "Unassigned";
    (rooms[r] = rooms[r] || []).push(p);
    const f = p.floor || "1";
    roomsByFloor[f] = roomsByFloor[f] || {};
    (roomsByFloor[f][r] = roomsByFloor[f][r] || []).push(p);
  });
  customRooms.forEach(({ name, floor }) => {
    rooms[name] = rooms[name] || [];
    roomsByFloor[floor] = roomsByFloor[floor] || {};
    roomsByFloor[floor][name] = roomsByFloor[floor][name] || [];
  });
  const floorOrder = ["B", "1", "2", "3"];
  const floorsUsed = floorOrder.filter((f) => roomsByFloor[f]);
  const floorTabs = floorsUsed.length ? floorsUsed : ["1"];
  const perFloorSqft = houseSqft / Math.max(1, floorsUsed.length || 1);

  return (
    <div className="app"><Style />
      <WelcomeGuide open={showGuide} onClose={closeGuide} />
      <header className="hdr no-print">
        <div className="hdr-mark">⌂</div>
        <div className="hdr-title">
          <h1>TapaCasa</h1>
          <p className="hdr-sub">SHEET 2 — {location.name.toUpperCase()}, {location.region.toUpperCase()}</p>
        </div>
        <div className="hdr-total">
          <span className="hdr-total-label">PROJECT TOTAL</span>
          <span className="hdr-total-num">{fmt(totals.total)}</span>
        </div>
        <button className="btn-ghost" onClick={() => { setLocation(null); setPlaced([]); setSelected(null); }}>← Change lot</button>
      </header>

      <div className="mobile-tabs no-print">
        {["catalog", "plan", "costs"].map((t) => (
          <button key={t} className={mobileTab === t ? "mtab on" : "mtab"} onClick={() => setMobileTab(t)}>{t.toUpperCase()}</button>
        ))}
      </div>

      <PrintSheet location={location} placed={placed} totals={totals}
        roomsByFloor={roomsByFloor} floorTabs={floorTabs} perFloorSqft={perFloorSqft} snapUrl={snapUrl} />

      <div className="cols no-print">
        {/* ── CATALOG ── */}
        <section className={`panel catalog ${mobileTab === "catalog" ? "show" : ""}`}>
          <div className="ai-box">
            <div className="ai-label">DESIGN DIRECTOR ✦ DESCRIBE ANYTHING</div>
            <textarea className="ai-input ta" rows={2}
              placeholder={'"Line the driveway with cypress and put a rose garden by the pool" · "Emerald zellige tile and brass fixtures in the primary bath" · "Treehouse in the back oak"'}
              value={director} onChange={(e) => setDirector(e.target.value)} />
            <div className="ai-row">
              <button className="btn-orange sm grow" onClick={() => runDirector()} disabled={ai.busy}>
                {ai.busy ? "Designing…" : "Implement it"}
              </button>
              <button className="btn-ghost xs" title="Let the AI design the whole property in one tap" onClick={() => runDirector(AUTO_PROMPT)} disabled={ai.busy}>✨ Surprise me</button>
            </div>
            {ai.err && <div className="ai-err">{ai.err}</div>}
            {ai.note && <div className="ai-ok">✦ {ai.note}</div>}
          </div>
          <input className="search" placeholder="Search — oak tree, pool, marble, sofa…" value={search} onChange={(e) => setSearch(e.target.value)} />
          {!q && (
            <div className="cat-tabs">
              {cats.map((c) => (
                <button key={c} className={c === activeCat ? "ctab on" : "ctab"} onClick={() => setActiveCat(c)}>{c}</button>
              ))}
            </div>
          )}
          {placed.length === 0 && !q && (
            <div className="starter">
              <div className="ai-label">NEW PARCEL — TWO WAYS TO START</div>
              <button className="btn-orange sm wide-b" onClick={() => addItem(CATALOG[0].items[0], 1)}>🏠 Drop a 5,000 sq ft home</button>
              <button className="btn-ghost wide" onClick={() => runDirector(AUTO_PROMPT)} disabled={ai.busy}>{ai.busy ? "Designing…" : "✨ Auto-design this whole property"}</button>
            </div>
          )}
          <div className="item-list">
            {visibleItems.length === 0 && <div className="empty-note">No matches — describe it to the Design Director above.</div>}
            {visibleItems.map((item) => <CatalogCard key={item.id} item={item} onAdd={addItem} />)}
          </div>
        </section>

        {/* ── SITE PLAN ── */}
        <section className={`panel plan ${mobileTab === "plan" ? "show" : ""}`}>
          <div className="plan-bar">
            <div className="viewtoggle">
              <button className="btn-ghost xs" onClick={undo} title="Undo">↶</button>
              <button className="btn-ghost xs" onClick={redo} title="Redo">↷</button>
              <button className={planView === "site" ? "ctab on" : "ctab"} onClick={() => setPlanView("site")}>Site plan</button>
              <button className={planView === "three" ? "ctab on" : "ctab"} onClick={() => setPlanView("three")}>3D land</button>
              <button className={planView === "photo" ? "ctab on" : "ctab"} onClick={() => setPlanView("photo")}>🌍 Photoreal</button>
              <button className={planView === "floor" ? "ctab on" : "ctab"} onClick={() => setPlanView("floor")}>Floor plan</button>
            </div>
            {planView !== "floor" ? (
              <div className="zoombtns">
                <button className="ctab" title="What the symbols mean" onClick={() => setShowGuide(true)}>Legend</button>
                {location.coords && (
                  <button className={satOn ? "ctab on" : "ctab"} onClick={() => setSatOn(!satOn)}>🛰 Imagery</button>
                )}
                {[["Envelope", 450], ["Wide", 900], ["Full lot", 99999]].map(([lbl, ft]) => (
                  <button key={lbl} className={viewFt === ft ? "ctab on" : "ctab"} onClick={() => setViewFt(ft)}>{lbl}</button>
                ))}
              </div>
            ) : (
              <div className="zoombtns">
                {floorTabs.map((f) => (
                  <button key={f} className={floorSel === f ? "ctab on" : "ctab"} onClick={() => setFloorSel(f)}>
                    {f === "B" ? "Basement" : `Level ${f}`}
                  </button>
                ))}
              </div>
            )}
          </div>
          {location.coords && getK("google") && planView === "site" && (
            <img className="sv-img" alt="Street view near this parcel"
              src={`https://maps.googleapis.com/maps/api/streetview?size=640x260&location=${location.coords.lat},${location.coords.lon}&key=${getK("google")}`}
              onError={(e) => { e.currentTarget.style.display = "none"; }} />
          )}
          {location.terrain && (
            <div className="terrain-strip">
              ⛰ TERRAIN — ELEV {location.terrain.elevFt.toLocaleString()} FT · {location.terrain.slopePct}% SLOPE FALLING {location.terrain.downhill} · {location.terrain.grade} · {location.terrain.reliefFt} FT RELIEF ACROSS PARCEL
            </div>
          )}
          {planView === "photo" ? (
            <PhotorealView location={location} items={placed.filter((p) => p.fp)} />
          ) : planView === "three" ? (
            <ThreeDView location={location} items={placed.filter((p) => p.fp)} viewFt={viewFt} onSnapshot={setSnapUrl} selectedUid={selected} onSelectItem={setSelected} onStyle={(uid, style) => patch(uid, { style })} />
          ) : planView === "floor" ? (
            <div>
              <div className="addroom-row">
                <input className="ci-mini grow" placeholder="Add a room to this level (e.g. Wine Tasting Room)" value={newRoom}
                  onChange={(e) => setNewRoom(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && newRoom.trim()) { setCustomRooms((r) => [...r, { name: newRoom.trim(), floor: floorSel }]); setNewRoom(""); } }} />
                <button className="btn-orange sm" onClick={() => { if (newRoom.trim()) { setCustomRooms((r) => [...r, { name: newRoom.trim(), floor: floorSel }]); setNewRoom(""); } }}>+ Room</button>
              </div>
              <FloorPlan houseSqft={perFloorSqft} floorLabel={floorSel === "B" ? "BASEMENT" : `LEVEL ${floorSel}`}
                rooms={roomsByFloor[floorSel] || {}} selectedRoom={selectedRoom} onSelectRoom={setSelectedRoom} />
              {selectedRoom && (roomsByFloor[floorSel]?.[selectedRoom] || []).length === 0 && (
                <button className="ci-remove" onClick={() => { setCustomRooms((r) => r.filter((x) => !(x.name === selectedRoom && x.floor === floorSel))); setSelectedRoom(null); }}>Remove empty room "{selectedRoom}"</button>
              )}
            </div>
          ) : (
          <SitePlan location={location} items={placed.filter((p) => p.fp)} selected={selected}
            onSelect={setSelected} onMove={(uid, x, y) => patch(uid, { x, y })} viewFt={viewFt}
            satOn={satOn} onDragStart={snap} />
          )}
          {planView === "site" && selItem && selItem.fp && (
            <div className="sel-bar">
              <b>{selItem.name}</b>
              <span className="sel-dim">{Math.round(selItem.fp[0])}′ × {Math.round(selItem.fp[1])}′ · {fmt(selItem.price)}</span>
              <button className="btn-ghost xs" onClick={() => patch(selItem.uid, { rot: !selItem.rot })}>⟳ Rotate</button>
              {selItem.existing
                ? <button className="btn-orange sm" onClick={() => demolish(selItem.uid)}>🏗 Demolish — {fmt(DEMO_ITEM.variants[0][1])}</button>
                : <button className="btn-ghost xs" onClick={() => removeItem(selItem.uid)}>Remove</button>}
            </div>
          )}
          <div className="manifest">
            <div className="panel-head">INTERIOR — BY ROOM</div>
            {Object.keys(rooms).length === 0 && <div className="empty-note">Interior items (rooms, finishes, furniture) collect here. Assign each a room and style notes in the cost panel.</div>}
            {Object.entries(rooms).map(([room, its]) => (
              <div key={room} className="room-group">
                <div className="room-name">{room.toUpperCase()} <span className="room-sum">{fmt(its.reduce((s, i) => s + i.price, 0))}</span></div>
                {its.map((p) => (
                  <div key={p.uid} className="room-item">
                    <span>{p.name}{p.notes ? <em> — {p.notes}</em> : null}</span>
                    <b>{fmt(p.price)}</b>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>

        {/* ── COSTS ── */}
        <section className={`panel costs ${mobileTab === "costs" ? "show" : ""}`}>
          <div className="save-row">
            <input className="search sm" placeholder="Project name…" value={projName} onChange={(e) => setProjName(e.target.value)} />
            <button className="btn-orange sm" onClick={saveProject}>Save</button>
          </div>
          {saveMsg && <div className="ai-ok">{saveMsg}</div>}
          <button className="btn-ghost wide" onClick={generateListing} disabled={listing?.busy}>
            {listing?.busy ? "Writing…" : "✦ Generate realtor listing"}
          </button>
          <button className="btn-ghost wide" onClick={exportCSV}>⬇ Export spec sheet (CSV)</button>
          <button className="btn-ghost wide" onClick={() => {
            try {
              const url = window.location.href.split("#")[0] + "#d=" + btoa(unescape(encodeURIComponent(JSON.stringify({ l: location, p: placed, r: customRooms })))).replace(/=+$/, "");
              navigator.clipboard?.writeText(url);
              setSaveMsg("🔗 Share link copied — anyone who opens it sees this exact design.");
              setTimeout(() => setSaveMsg(""), 4000);
            } catch { setSaveMsg("Couldn't build link"); }
          }}>🔗 Copy share link</button>
          {location.coords && (
            <button className="btn-ghost wide" onClick={scoutNearby} disabled={nearby?.busy}>
              {nearby?.busy ? "Scouting…" : "📍 What's nearby (schools, shops…)"}
            </button>
          )}
          {nearby?.rows && (
            <div className="nearby-box">
              {nearby.rows.map(([l, v]) => <div key={l} className="nearby-row"><b>{l}</b><span>{v}</span></div>)}
            </div>
          )}
          {nearby?.err && <div className="ai-err">{nearby.err}</div>}
          <button className="btn-ghost wide" onClick={() => window.print()}>⎙ Print blueprint / Save as PDF</button>
          {location.terrain && location.terrain.slopePct >= 8 && !placed.some((p) => p.itemId === "hillside") && (
            <div className="slope-warn">
              ⚠ {location.terrain.grade} SLOPE ({location.terrain.slopePct}%) — hillside sites need engineered foundations and retaining.
              <button className="btn-orange sm" onClick={() => addItem(HILLSIDE_ITEM, location.terrain.slopePct < 12 ? 0 : location.terrain.slopePct < 20 ? 1 : 2)}>
                + Add {HILLSIDE_ITEM.variants[location.terrain.slopePct < 12 ? 0 : location.terrain.slopePct < 20 ? 1 : 2][0]} — {fmt(HILLSIDE_ITEM.variants[location.terrain.slopePct < 12 ? 0 : location.terrain.slopePct < 20 ? 1 : 2][1])}
              </button>
            </div>
          )}
          <div className="budget-row">
            <label className="pin-acres">Budget $
              <input type="number" min="0" step="10000" value={budget} placeholder="—"
                onChange={(e) => setBudget(e.target.value)} />
            </label>
            {budget > 0 && (
              <span className={+budget - totals.total >= 0 ? "budget-ok" : "budget-over"}>
                {+budget - totals.total >= 0 ? `${fmt(+budget - totals.total)} under` : `${fmt(totals.total - +budget)} OVER`}
              </span>
            )}
          </div>
          {listing && !listing.busy && listing.text && (
            <div className="listing-box">
              <div className="panel-head">LISTING DRAFT</div>
              <div className="listing-text">{listing.text}</div>
              <button className="btn-ghost xs" onClick={() => { navigator.clipboard?.writeText(listing.text); }}>Copy text</button>
              <button className="btn-ghost xs" onClick={() => setListing(null)}>Close</button>
            </div>
          )}
          <datalist id="roomlist">{Object.keys(rooms).map((r) => <option key={r} value={r} />)}</datalist>
          <div className="panel-head" style={{ marginTop: 14 }}>COST SCHEDULE</div>
          <div className="cost-line big"><span>Land — {location.name}</span><b>{fmt(totals.land)}</b></div>
          <div className="cost-items">
            {placed.length === 0 && <div className="empty-note">Nothing on the schedule yet.</div>}
            {placed.map((p) => (
              <div key={p.uid} className={`cost-item ${selected === p.uid ? "sel" : ""}`} onClick={() => p.fp && setSelected(p.uid)}>
                <div className="ci-top"><span className="ci-name">{p.name}</span><b className="ci-price">{fmt(p.price)}</b></div>
                <div className="ci-vendor">{p.vendor}{p.fp ? ` · ${Math.round(p.fp[0])}′×${Math.round(p.fp[1])}′` : ""}</div>
                {p.variants.length > 1 && (
                  <select className="ci-select" value={p.variantIdx} onClick={(e) => e.stopPropagation()} onChange={(e) => changeVariant(p.uid, +e.target.value)}>
                    {p.variants.map((v, i) => <option key={i} value={i}>{v[0]} — {fmt(v[1])}</option>)}
                  </select>
                )}
                {!p.fp && (
                  <div className="ci-fields" onClick={(e) => e.stopPropagation()}>
                    <div className="ci-roomrow">
                      <select className="ci-mini fl" value={p.floor || "1"} onChange={(e) => patch(p.uid, { floor: e.target.value })} aria-label="Floor">
                        <option value="B">Bsmt</option><option value="1">L1</option><option value="2">L2</option><option value="3">L3</option>
                      </select>
                      <input className="ci-mini grow" list="roomlist" placeholder="Room — pick or type" value={p.room} onChange={(e) => patch(p.uid, { room: e.target.value })} />
                    </div>
                    <input className="ci-mini" placeholder="Style notes — exactly how it should look" value={p.notes} onChange={(e) => patch(p.uid, { notes: e.target.value })} />
                  </div>
                )}
                {p.existing
                  ? <button className="ci-remove" onClick={(e) => { e.stopPropagation(); demolish(p.uid); }}>Demolish & redesign — {fmt(DEMO_ITEM.variants[0][1])}</button>
                  : <button className="ci-remove" onClick={(e) => { e.stopPropagation(); removeItem(p.uid); }}>Remove</button>}
              </div>
            ))}
          </div>
          {location.mapLabel && (
            <div className="ext-links pad">
              Real listings near this parcel:&nbsp;
              {listingLinks(location.mapLabel).map(([n, url]) => (
                <a key={n} href={url} target="_blank" rel="noopener noreferrer">{n} ↗</a>
              ))}
            </div>
          )}
          <div className="cost-summary">
            <div className="cost-line"><span>Construction, landscape & contents</span><b>{fmt(totals.build)}</b></div>
            <div className="cost-line">
              <span><label className="soft-lab"><input type="checkbox" checked={softCosts} onChange={(e) => setSoftCosts(e.target.checked)} /> Soft costs — design 8% · permits 1.5% · contingency 10%</label></span>
              <b>{fmt(totals.soft)}</b>
            </div>
            <div className="cost-line total"><span>PROJECT TOTAL</span><b>{fmt(totals.total)}</b></div>
            <div className="cost-line"><span>Est. property tax / yr ({(location.taxRate * 100).toFixed(2)}%)</span><b>{fmt(totals.tax)}</b></div>
            <div className="cost-line"><span>Est. mortgage / mo (20% down, 6.5%, 30 yr)</span><b>{fmt(totals.monthly)}</b></div>
            {totals.months > 0 && <div className="cost-line"><span>Est. build timeline</span><b>~{totals.months}–{Math.round(totals.months * 1.25)} mo</b></div>}
            <p className="fine">Map-parcel values, taxes and existing-home figures are AI estimates from typical market levels — not appraisals or listings. Catalog pricing is illustrative and vendors are fictional. Use the Zillow / Realtor / LandWatch links for real listings, and verify everything locally before making decisions.</p>
          </div>
        </section>
      </div>
    </div>
  );
}

function CatalogCard({ item, onAdd }) {
  const [vi, setVi] = useState(0);
  const fp = item.variants[vi][2] || item.footprint;
  return (
    <div className="item-card">
      <div className="ic-top">
        <div>
          <div className="ic-name">{item.name}{item.custom ? " ✦" : ""}</div>
          <div className="ic-vendor">{item.vendor}</div>
        </div>
        <div className="ic-price">{fmt(item.variants[vi][1])}</div>
      </div>
      <div className="ic-desc">{item.desc}</div>
      <div className="ic-actions">
        {item.variants.length > 1 && (
          <select className="ci-select" value={vi} onChange={(e) => setVi(+e.target.value)}>
            {item.variants.map((v, i) => <option key={i} value={i}>{v[0]}</option>)}
          </select>
        )}
        <button className="btn-orange sm" onClick={() => onAdd(item, vi)}>+ Add</button>
      </div>
      {fp && <div className="ic-fp">FOOTPRINT {Math.round(fp[0])}′ × {Math.round(fp[1])}′ — DRAGGABLE ON PLAN</div>}
      <div className="shop-row">
        Price check:&nbsp;
        {shopLinks(item.name).slice(0, 4).map(([n, url]) => (
          <a key={n} href={url} target="_blank" rel="noopener noreferrer">{n} ↗</a>
        ))}
      </div>
    </div>
  );
}

/* ─────────── STYLES ─────────── */
function Style() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Archivo:wght@500;700;900&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
      * { box-sizing: border-box; margin: 0; }
      .app {
        min-height: 100vh; background: #0C2340; color: #DCEBFA;
        font-family: 'Archivo', system-ui, sans-serif;
        background-image: radial-gradient(rgba(190,220,245,0.06) 1px, transparent 1px);
        background-size: 26px 26px;
      }
      .hdr { display: flex; align-items: center; gap: 14px; padding: 14px 20px; border-bottom: 2px solid #2A4A72; flex-wrap: wrap; }
      .hdr-mark { font-size: 28px; color: #FF7A29; }
      .hdr h1 { font-size: 19px; font-weight: 900; letter-spacing: 0.5px; }
      .hdr-sub { font-family:'IBM Plex Mono',monospace; font-size: 10px; color: #7FA8CC; letter-spacing: 1.6px; margin-top: 2px; }
      .hdr-title { flex: 1; min-width: 190px; }
      .hdr-total { text-align: right; margin-right: 6px; }
      .hdr-total-label { display:block; font-family:'IBM Plex Mono',monospace; font-size:9.5px; letter-spacing:1.6px; color:#7FA8CC; }
      .hdr-total-num { font-family:'IBM Plex Mono',monospace; font-size:20px; font-weight:600; color:#FF9A52; }
      .btn-ghost { background:none; border:1.5px solid #3A5C86; color:#BFDCF5; font-family:'IBM Plex Mono',monospace; font-size:12px; padding:8px 12px; cursor:pointer; }
      .btn-ghost:hover { border-color:#BFDCF5; }
      .btn-ghost.xs { font-size: 10.5px; padding: 5px 9px; }
      .btn-ghost.wide { width: 100%; margin-top: 8px; }
      .btn-orange { background:#FF7A29; color:#14243D; border:none; font-weight:700; font-family:'Archivo',sans-serif; font-size:14px; padding:12px 18px; cursor:pointer; }
      .btn-orange:hover { background:#FF9A52; }
      .btn-orange:disabled { opacity:.6; cursor:wait; }
      .btn-orange.sm { padding:8px 14px; font-size:13px; }
      .btn-orange.grow { flex: 1; }
      button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, .loc-card:focus-visible { outline:2px solid #FF9A52; outline-offset:2px; }

      /* location screen */
      .loc-wrap { max-width:1080px; margin:0 auto; padding:30px 20px 60px; }
      .loc-intro h2 { font-size:clamp(28px,5vw,42px); font-weight:900; }
      .loc-intro p { color:#9DBEDD; margin:10px 0 18px; max-width:520px; line-height:1.5; }
      .loc-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(245px,1fr)); gap:14px; margin-top:28px; }
      .loc-card { text-align:left; background:#102C4E; border:1.5px solid #2A4A72; padding:16px; color:inherit; cursor:pointer; font-family:inherit; transition:border-color .15s,transform .15s; }
      .loc-card:hover { border-color:#FF7A29; transform:translateY(-2px); }
      .loc-region { font-family:'IBM Plex Mono',monospace; font-size:10px; letter-spacing:1.8px; color:#FF9A52; }
      .loc-name { font-size:17px; font-weight:700; margin:5px 0 6px; }
      .loc-vibe { font-size:12.5px; color:#9DBEDD; line-height:1.45; min-height:36px; }
      .loc-meta { display:flex; justify-content:space-between; margin-top:12px; font-family:'IBM Plex Mono',monospace; font-size:11px; color:#7FA8CC; }
      .loc-price { color:#FF9A52; font-weight:600; }
      /* map picker */
      .map-block { border:1.5px solid #2A4A72; background:#0A1F38; padding:10px; margin-top:6px; }
      .map-toolbar { display:flex; gap:6px; flex-wrap:wrap; }
      .map-canvas { height:min(52vh, 460px); min-height:280px; margin-top:8px; position:relative; background:#0E2746; border:1.5px solid #2A4A72; z-index:0; }
      .map-canvas .leaflet-container { height:100%; width:100%; }
      .map-msg { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#7FA8CC; font-family:'IBM Plex Mono',monospace; font-size:12px; padding:20px; text-align:center; z-index:1; line-height:1.6; }
      .map-msg.blocked { color:#FF9A52; background:rgba(10,31,56,0.85); }
      .geo-results { border:1.5px solid #2A4A72; border-top:none; background:#102C4E; max-height:180px; overflow-y:auto; }
      .geo-row { display:block; width:100%; text-align:left; background:none; border:none; border-bottom:1px solid #1C3A60; color:#C6DCF0; font-size:12.5px; padding:9px 11px; cursor:pointer; font-family:inherit; line-height:1.4; }
      .geo-row:hover { background:#16385F; }
      .geo-row.muted { color:#56789E; cursor:default; }
      .geo-row.errrow { color:#FF9A52; cursor:default; }
      .keybar { border:1.5px dashed #3A5C86; padding:9px; margin-top:8px; font-size:12px; color:#9DBEDD; line-height:1.5; }
      .keybar.ok { color:#8CDCAA; display:flex; gap:10px; align-items:center; flex-wrap:wrap; border-style:solid; }
      .threed-holder.photo { min-height:min(62vh,520px); }
      .int-row { display:flex; flex-direction:column; gap:4px; margin:8px 0; }
      .int-row span { font-size:11.5px; }
      .int-ok { color:#8CDCAA; }
      .int-toggle { background:none; border:none; color:#9DBEDD; cursor:pointer; font-family:'IBM Plex Mono',monospace; font-size:11px; padding:0; text-align:left; }
      .threed-holder { position:relative; border:1.5px solid #2A4A72; min-height:320px; background:#0A1F38; }
      .threed-holder canvas { display:block; width:100%; height:auto; }
      .sun-lab { display:flex; align-items:center; gap:6px; font-family:'IBM Plex Mono',monospace; font-size:11px; color:#FFD9A0; }
      .sun-lab input { width:110px; accent-color:#FF9A52; }
      .style-bar { display:flex; align-items:center; gap:6px; flex-wrap:wrap; border:1.5px solid #FF7A29; background:rgba(255,122,41,0.06); padding:7px 9px; margin-bottom:8px; }
      .style-name { font-size:12.5px; font-weight:700; margin-right:4px; }
      .style-lab { font-family:'IBM Plex Mono',monospace; font-size:9.5px; letter-spacing:1px; color:#7FA8CC; }
      .swatch { width:24px; height:24px; border:2px solid #2A4A72; cursor:pointer; padding:0; }
      .swatch.on { border-color:#FF9A52; }
      .cam-bar { display:flex; gap:6px; margin-bottom:8px; flex-wrap:wrap; }
      .walk-pad { position:absolute; bottom:12px; left:50%; transform:translateX(-50%); display:flex; flex-direction:column; align-items:center; gap:5px; z-index:2; }
      .wp-row { display:flex; gap:5px; }
      .wp { width:52px; height:48px; font-size:18px; background:rgba(12,35,64,0.75); color:#DCEBFA; border:1.5px solid #7FA8CC; cursor:pointer; touch-action:none; user-select:none; }
      .wp:active { background:#FF7A29; color:#14243D; }
      .threed-mount canvas { display:block; width:100%; height:auto; }
      .joy { position:absolute; bottom:16px; left:16px; width:96px; height:96px; border-radius:50%; border:2px solid rgba(191,220,245,0.6); background:rgba(12,35,64,0.45); z-index:2; touch-action:none; }
      .joy-knob { position:absolute; left:50%; top:50%; width:42px; height:42px; margin:-21px 0 0 -21px; border-radius:50%; background:#FF7A29; box-shadow:0 2px 8px rgba(0,0,0,0.4); pointer-events:none; }
      .orbit-hint { font-family:'IBM Plex Mono',monospace; font-size:9.5px; letter-spacing:1px; color:#7FA8CC; margin-top:7px; line-height:1.6; }
      .sv-img { width:100%; border:1.5px solid #2A4A72; display:block; margin:0 0 9px; }
      .nearby-box { border:1.5px solid #2A4A72; background:#102C4E; padding:9px; margin-top:8px; }
      .nearby-row { display:flex; flex-direction:column; gap:2px; font-size:12px; padding:5px 0; border-bottom:1px solid #1C3A60; }
      .nearby-row b { color:#8CDCAA; font-size:11px; }
      .nearby-row span { color:#C6DCF0; line-height:1.45; }
      .starter { border:1.5px solid #8CDCAA; padding:10px; margin-bottom:12px; display:flex; flex-direction:column; gap:7px; }
      .wide-b { width:100%; }
      .lg-row { display:flex; align-items:center; gap:10px; margin:9px 0; font-size:12.5px; color:#C6DCF0; }
      .lg-chip { width:34px; height:22px; flex:none; display:inline-block; background:#102C4E; }
      .gloss p { margin-bottom:9px !important; }
      .guide { max-height:82vh; overflow-y:auto; }
      .soft-lab { display:flex; gap:6px; align-items:flex-start; cursor:pointer; }
      .soft-lab input { accent-color:#FF7A29; margin-top:2px; }
      .guide-scrim { position:fixed; inset:0; background:rgba(5,15,30,0.8); z-index:50; display:flex; align-items:center; justify-content:center; padding:18px; }
      .guide { background:#102C4E; border:2px solid #FF7A29; max-width:480px; padding:22px; }
      .guide h3 { font-size:20px; font-weight:900; margin-bottom:12px; }
      .guide p { font-size:13.5px; line-height:1.6; color:#C6DCF0; margin-bottom:12px; }
      .guide b { color:#FF9A52; }
      .addroom-row { display:flex; gap:6px; margin-bottom:9px; }
      .recent-row { display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-top:8px; }
      .scout-list { margin-top:10px; }
      .scout-card { border:1.5px solid #2A4A72; background:#102C4E; padding:11px; margin-top:8px; }
      .diag-strip { font-family:'IBM Plex Mono',monospace; font-size:9.5px; letter-spacing:1px; color:#56789E; margin-top:7px; line-height:1.6; }
      .pin-bar { margin-top:10px; border:1.5px dashed #FF7A29; padding:10px; background:rgba(255,122,41,0.05); }
      .pin-label { font-size:13px; line-height:1.45; margin-bottom:9px; }
      .pin-controls { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
      .pin-acres { font-family:'IBM Plex Mono',monospace; font-size:11.5px; color:#9DBEDD; display:flex; align-items:center; gap:6px; }
      .pin-acres input { width:70px; background:#0A1F38; border:1.5px solid #2A4A72; color:#DCEBFA; font-family:'IBM Plex Mono',monospace; font-size:12px; padding:7px; }
      .ext-links { margin-top:9px; font-family:'IBM Plex Mono',monospace; font-size:11px; color:#7FA8CC; }
      .ext-links.pad { margin:4px 0 10px; }
      .ext-links a { color:#FF9A52; text-decoration:none; margin-right:12px; }
      .ext-links a:hover { text-decoration:underline; }
      .curated-head { display:flex; justify-content:space-between; align-items:center; margin-top:28px; gap:10px; flex-wrap:wrap; }

      /* trace / compare / floor / budget / shop */
      .trace-hint { font-family:'IBM Plex Mono',monospace; font-size:11px; color:#FF9A52; margin-top:7px; line-height:1.5; }
      .trace-badge { color:#8CDCAA; font-size:10px; }
      .cmp-check { accent-color:#FF7A29; width:17px; height:17px; margin-bottom:7px; }
      .cmp-heads { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:16px; }
      .cmp-head { text-align:left; background:#102C4E; border:1.5px solid #2A4A72; color:inherit; padding:12px; cursor:pointer; font-family:inherit; }
      .cmp-head:hover { border-color:#FF7A29; }
      .cmp-head b { display:block; font-size:15px; }
      .cmp-head span { display:block; font-family:'IBM Plex Mono',monospace; font-size:10.5px; color:#7FA8CC; margin-top:4px; }
      .cmp-head em { display:block; font-style:normal; color:#FF9A52; font-family:'IBM Plex Mono',monospace; font-size:10.5px; margin-top:6px; }
      .cmp-row { display:grid; grid-template-columns:1fr auto 1fr; gap:12px; padding:9px 0; border-bottom:1px solid #1C3A60; font-family:'IBM Plex Mono',monospace; font-size:13px; align-items:center; }
      .cmp-row span:first-child { text-align:right; }
      .cmp-row .cmp-label { color:#7FA8CC; font-family:'Archivo',sans-serif; font-size:12px; text-align:center; min-width:120px; }
      .cmp-row .hi { color:#FF9A52; font-weight:600; }
      .roomdetail { border:1.5px solid #2A4A72; background:#102C4E; padding:10px; margin-top:10px; }
      .viewtoggle { display:flex; gap:6px; }
      .budget-row { display:flex; align-items:center; gap:10px; margin-top:8px; flex-wrap:wrap; }
      .budget-row input { width:120px; background:#0A1F38; border:1.5px solid #2A4A72; color:#DCEBFA; font-family:'IBM Plex Mono',monospace; font-size:12px; padding:7px; }
      .budget-ok { font-family:'IBM Plex Mono',monospace; font-size:12px; color:#8CDCAA; }
      .budget-over { font-family:'IBM Plex Mono',monospace; font-size:12px; color:#FF6B6B; font-weight:600; }
      .shop-row { font-family:'IBM Plex Mono',monospace; font-size:10px; color:#56789E; margin-top:8px; }
      .shop-row a { color:#7FA8CC; text-decoration:none; margin-right:9px; }
      .shop-row a:hover { color:#FF9A52; }
      .muted-note { color:#56789E; }
      .terrain-strip { font-family:'IBM Plex Mono',monospace; font-size:10px; letter-spacing:1px; color:#8CDCAA; border:1px solid #1C3A60; padding:7px 9px; margin-bottom:8px; line-height:1.5; }
      .slope-warn { border:1.5px solid #FF7A29; background:rgba(255,122,41,0.07); padding:10px; margin-top:10px; font-size:12.5px; line-height:1.5; display:flex; flex-direction:column; gap:8px; }
      .ci-roomrow { display:flex; gap:5px; }
      .ci-mini.fl { width:64px; flex:none; }
      .ci-mini.grow { flex:1; min-width:0; }

      /* print sheet */
      .print-sheet { display:none; }
      .printmode .plan-label { fill:#0C2340; }
      .printmode .plan-sub { fill:#3A5C86; }
      .printmode .plan-dim { fill:#3A5C86; }
      .printmode .plan-empty { fill:#7FA8CC; }
      @media print {
        .no-print { display:none !important; }
        .app { background:#fff !important; background-image:none !important; min-height:0; }
        .print-sheet { display:block; color:#0C2340; padding:6px 2px; font-family:'Archivo',system-ui,sans-serif; }
        .ps-head { display:flex; justify-content:space-between; gap:18px; border-bottom:3px solid #0C2340; padding-bottom:10px; margin-bottom:12px; }
        .ps-brand { font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:3px; color:#FF7A29; }
        .print-sheet h1 { font-size:24px; font-weight:900; margin:2px 0; }
        .ps-sub { font-size:11px; color:#3A5C86; line-height:1.5; }
        .ps-totals div { display:flex; justify-content:space-between; gap:16px; font-size:11px; }
        .ps-totals span { color:#3A5C86; }
        .ps-totals b { font-family:'IBM Plex Mono',monospace; }
        .ps-totals div:first-child { font-size:14px; font-weight:900; color:#FF7A29; }
        .ps-cap { font-family:'IBM Plex Mono',monospace; font-size:10px; letter-spacing:2px; color:#3A5C86; margin:14px 0 6px; border-bottom:1px solid #B9CBDD; padding-bottom:4px; }
        .print-sheet .plan-svg { border:1px solid #B9CBDD; page-break-inside:avoid; }
        .ps-table { width:100%; border-collapse:collapse; font-size:10.5px; }
        .ps-table th, .ps-table td { border:1px solid #B9CBDD; padding:4px 6px; text-align:left; vertical-align:top; }
        .ps-table th { background:#EDF2F8; font-family:'IBM Plex Mono',monospace; font-size:9px; letter-spacing:1px; }
        .ps-table td:last-child, .ps-table th:last-child { text-align:right; font-family:'IBM Plex Mono',monospace; white-space:nowrap; }
        .ps-total td { font-weight:900; border-top:2px solid #0C2340; }
        .ps-fine { font-size:9px; color:#6A87A5; margin-top:10px; }
        .roomdetail { display:none; }
      }

      .saved-block { margin-top: 26px; }
      .saved-row { display:flex; align-items:center; gap:8px; }
      .saved-open { flex:1; text-align:left; background:#102C4E; border:1.5px solid #2A4A72; color:inherit; padding:10px 12px; margin-bottom:7px; cursor:pointer; font-family:inherit; display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; }
      .saved-open:hover { border-color:#FF7A29; }
      .saved-open span { font-family:'IBM Plex Mono',monospace; font-size:10.5px; color:#7FA8CC; }

      /* build layout */
      .cols { display:grid; grid-template-columns:320px 1fr 340px; min-height:calc(100vh - 74px); }
      .panel { padding:14px; overflow-y:auto; max-height:calc(100vh - 74px); }
      .catalog { border-right:2px solid #2A4A72; }
      .costs { border-left:2px solid #2A4A72; }
      .panel-head { font-family:'IBM Plex Mono',monospace; font-size:10.5px; letter-spacing:1.8px; color:#7FA8CC; margin-bottom:10px; border-bottom:1px solid #2A4A72; padding-bottom:7px; }
      .panel-head.nb { border:none; margin:0; padding:0; }
      .mobile-tabs { display:none; }

      .search { width:100%; background:#0A1F38; border:1.5px solid #2A4A72; color:#DCEBFA; font-family:'IBM Plex Mono',monospace; font-size:13px; padding:10px 12px; margin-bottom:12px; }
      .search.sm { margin:0; padding:8px 10px; font-size:12px; flex:1; min-width:0; }
      .search::placeholder, .ai-input::placeholder, .ci-mini::placeholder { color:#56789E; }
      .cat-tabs { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; }
      .ctab { background:none; border:1.5px solid #2A4A72; color:#9DBEDD; cursor:pointer; font-family:'IBM Plex Mono',monospace; font-size:11px; padding:6px 9px; }
      .ctab.on { border-color:#FF7A29; color:#FF9A52; }

      .ai-box { border:1.5px dashed #FF7A29; padding:10px; margin-bottom:14px; background:rgba(255,122,41,0.04); }
      .ai-label { font-family:'IBM Plex Mono',monospace; font-size:9.5px; letter-spacing:1.4px; color:#FF9A52; margin-bottom:7px; }
      .ai-row { display:flex; gap:6px; margin-top:7px; }
      .ai-input { width:100%; background:#0A1F38; border:1.5px solid #2A4A72; color:#DCEBFA; font-size:12.5px; padding:8px 10px; font-family:'IBM Plex Mono',monospace; }
      .ai-input.ta { resize:vertical; line-height:1.45; }
      .ai-err { color:#FF9A52; font-size:12px; margin-top:6px; }
      .ai-ok { color:#8CDCAA; font-size:12px; margin-top:6px; font-family:'IBM Plex Mono',monospace; }

      .item-card { border:1.5px solid #2A4A72; background:#102C4E; padding:13px; margin-bottom:10px; }
      .ic-top { display:flex; justify-content:space-between; gap:10px; }
      .ic-name { font-weight:700; font-size:14.5px; }
      .ic-vendor { font-family:'IBM Plex Mono',monospace; font-size:10px; color:#7FA8CC; letter-spacing:.8px; margin-top:2px; }
      .ic-price { font-family:'IBM Plex Mono',monospace; color:#FF9A52; font-weight:600; font-size:14px; white-space:nowrap; }
      .ic-desc { font-size:12.5px; color:#9DBEDD; line-height:1.45; margin:7px 0 9px; }
      .ic-actions { display:flex; gap:7px; align-items:center; }
      .ic-fp { font-family:'IBM Plex Mono',monospace; font-size:9.5px; color:#56789E; letter-spacing:1px; margin-top:8px; }
      .ci-select { flex:1; min-width:0; background:#0A1F38; color:#DCEBFA; border:1.5px solid #2A4A72; font-family:'IBM Plex Mono',monospace; font-size:11.5px; padding:7px; }
      .empty-note { color:#56789E; font-size:13px; padding:12px 4px; line-height:1.5; }

      .plan-bar { display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:10px; flex-wrap:wrap; }
      .zoombtns { display:flex; gap:6px; }
      .plan-svg { width:100%; height:auto; border:1.5px solid #2A4A72; display:block; touch-action:none; }
      .plan-dim { font:600 11px 'IBM Plex Mono',monospace; fill:#7FA8CC; letter-spacing:2px; }
      .plan-label { font:700 11px 'Archivo',sans-serif; fill:#EAF4FF; letter-spacing:1px; }
      .plan-sub { font:500 9px 'IBM Plex Mono',monospace; fill:#9DBEDD; letter-spacing:1px; }
      .plan-empty { font:600 12px 'IBM Plex Mono',monospace; fill:#56789E; letter-spacing:2px; }
      .sel-bar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; border:1.5px solid #FF7A29; padding:8px 10px; margin-top:10px; font-size:13px; }
      .sel-dim { font-family:'IBM Plex Mono',monospace; font-size:11px; color:#FF9A52; }

      .manifest { margin-top:16px; }
      .room-group { margin-bottom:12px; }
      .room-name { font-family:'IBM Plex Mono',monospace; font-size:10.5px; letter-spacing:1.6px; color:#8CDCAA; display:flex; justify-content:space-between; border-bottom:1px solid #1C3A60; padding-bottom:4px; margin-bottom:5px; }
      .room-sum { color:#FF9A52; }
      .room-item { display:flex; justify-content:space-between; gap:10px; font-size:12.5px; padding:3px 0; color:#C6DCF0; }
      .room-item em { color:#7FA8CC; font-style:italic; }
      .room-item b { font-family:'IBM Plex Mono',monospace; font-weight:600; font-size:11.5px; color:#FF9A52; white-space:nowrap; }

      .save-row { display:flex; gap:6px; }
      .listing-box { border:1.5px solid #2A4A72; background:#102C4E; padding:10px; margin-top:10px; }
      .listing-text { white-space:pre-wrap; font-size:12.5px; line-height:1.55; color:#C6DCF0; margin-bottom:8px; max-height:280px; overflow-y:auto; }

      .cost-line { display:flex; justify-content:space-between; gap:10px; padding:8px 0; font-size:13.5px; border-bottom:1px solid #1C3A60; }
      .cost-line b { font-family:'IBM Plex Mono',monospace; font-weight:600; }
      .cost-line.big { font-weight:700; }
      .cost-line.total { font-size:15px; font-weight:900; color:#FF9A52; border-top:2px solid #FF7A29; border-bottom:2px solid #FF7A29; margin-top:6px; }
      .cost-items { margin:10px 0; }
      .cost-item { border:1.5px solid #2A4A72; padding:10px; margin-bottom:8px; background:#102C4E; }
      .cost-item.sel { border-color:#FF7A29; }
      .ci-top { display:flex; justify-content:space-between; gap:8px; }
      .ci-name { font-weight:700; font-size:13.5px; }
      .ci-price { font-family:'IBM Plex Mono',monospace; color:#FF9A52; font-size:13px; }
      .ci-vendor { font-family:'IBM Plex Mono',monospace; font-size:9.5px; color:#7FA8CC; margin:3px 0 7px; letter-spacing:.8px; }
      .cost-item .ci-select { width:100%; margin-bottom:7px; }
      .ci-fields { display:flex; flex-direction:column; gap:5px; margin-bottom:7px; }
      .ci-mini { background:#0A1F38; border:1.5px solid #2A4A72; color:#DCEBFA; font-family:'IBM Plex Mono',monospace; font-size:11px; padding:6px 8px; }
      .ci-remove { background:none; border:none; color:#7FA8CC; font-size:11.5px; cursor:pointer; text-decoration:underline; padding:0; font-family:'IBM Plex Mono',monospace; }
      .ci-remove:hover { color:#FF9A52; }
      .chip-x { background:none; border:none; color:#7FA8CC; cursor:pointer; font-size:16px; padding:0 4px; }
      .chip-x:hover { color:#FF9A52; }
      .fine { font-size:10.5px; color:#56789E; line-height:1.5; margin-top:12px; }

      @media (max-width: 940px) {
        .cols { grid-template-columns:1fr; min-height:unset; }
        .panel { display:none; max-height:none; border:none !important; }
        .panel.show { display:block; }
        .mobile-tabs { display:flex; border-bottom:2px solid #2A4A72; }
        .mtab { flex:1; background:none; border:none; color:#7FA8CC; cursor:pointer; font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:1.6px; padding:12px 0; }
        .mtab.on { color:#FF9A52; box-shadow:inset 0 -2px 0 #FF7A29; }
        .hdr-total { order:4; width:100%; text-align:left; margin-top:4px; }
      }
      @media (prefers-reduced-motion: reduce) { .loc-card { transition:none; } }
    `}</style>
  );
}
