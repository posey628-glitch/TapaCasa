# TapaCasa — Dream Property Studio

Design any property on real land: search or tap anywhere on Earth (satellite view),
trace the actual parcel boundary, get an AI appraisal with real elevation/slope data,
then build — structures, amenities, landscaping, room-by-room interiors — with live
pricing, taxes, budget tracking, comparisons, CSV export, and printable blueprints.

Everything that was blocked in the chat-app preview (map tiles, geocoding, AI calls)
works normally once this runs as a real website.

## Run it locally (5 minutes)

1. Install Node.js (https://nodejs.org, LTS version).
2. In this folder:
   ```
   npm install
   npm run dev
   ```
3. Open the printed URL (usually http://localhost:5173).

## Deploy it free (pick one)

**Netlify (easiest):**
1. `npm install && npm run build` — this creates a `dist/` folder.
2. Go to https://app.netlify.com/drop and drag the `dist` folder in. Done — you get a live URL.

**Vercel:**
1. Push this folder to a GitHub repo.
2. Go to https://vercel.com, "New Project", import the repo, accept defaults, Deploy.

## Enable the AI features

The AI appraiser, Design Director, AI locate, and listing writer call the Anthropic API.

1. Get an API key at https://console.anthropic.com (Settings → API Keys). Usage is
   pay-as-you-go; these calls are small (typically fractions of a cent each).
2. Open your deployed TapaCasa, and on the location screen paste the key into the
   🔑 bar under the map. It's stored only in your browser's localStorage.

**Security note:** a key saved in the browser is fine for personal use, but anyone
you share the site with could open dev tools and see network requests using it.
For a public/production site, don't ship a key to the browser — add a tiny
serverless function (Netlify Function / Vercel Function) that holds the key
server-side and forwards requests, and point `askAI` in `src/App.jsx` at it.

## What needs no key at all

Maps, satellite imagery, address search (OpenStreetMap/Nominatim), parcel tracing,
elevation & slope (Open-Elevation), the full catalog, drag-and-place site plan,
floor plans, pricing, taxes, budget, compare, CSV export, and print-to-PDF.


## Host it FROM YOUR PHONE (no computer needed)

iPhone's Files preview blocks scripts, so opening tapacasa.html directly can show a
dead page. Instead, put the single file online — takes ~2 minutes on a phone:

1. Save `tapacasa.html` to your phone (share → Save to Files / Downloads).
2. In your phone's browser go to **tiiny.host** (free, no card).
3. Tap upload, pick `tapacasa.html`, choose a site name, publish.
4. You get a real URL like `yourname.tiiny.site` — open it. Maps, satellite,
   tracing, elevation all work. Paste your API key in the 🔑 bar for AI features.

Alternatives that also work from a phone browser: **static.app**, or GitHub +
Vercel if you already have accounts.

## Serverless proxy (keep your key off the browser)

This package now includes ready-made proxies — the app automatically uses them
when deployed (it tries `/api/ai`, then `/.netlify/functions/ai`, before any
browser-stored key):

- **Vercel:** `api/ai.js` is picked up automatically. After importing the repo,
  add an environment variable `ANTHROPIC_API_KEY` (Project → Settings →
  Environment Variables), redeploy — AI features work for every visitor with no
  key in the browser.
- **Netlify:** `netlify/functions/ai.js` + `netlify.toml` are included. Add
  `ANTHROPIC_API_KEY` under Site settings → Environment variables, deploy the
  repo (functions don't run via drag-and-drop Drop — connect the repo instead).

With the proxy set, users never see or need a key; without it, the 🔑 bar
fallback still works for personal use.


## v10-PRO integrations (all optional, app works free without them)

Open "⚙ Pro integrations" on the front page and paste any of these:

- **Anthropic API key** (🔑 bar) — enables AI appraiser, Design Director, AI locate,
  listing writer. console.anthropic.com → API Keys. Pay-as-you-go, pennies.
- **Mapbox token** — HD satellite imagery everywhere (map, blueprint underlay, 3D
  ground). Free tier at mapbox.com → Access tokens.
- **Google Maps key** — unlocks 🌍 Photoreal mode: your design rendered inside
  Google's photorealistic 3D scan of the real world. console.cloud.google.com →
  enable billing → enable "Map Tiles API" → create key. Free monthly credit
  covers casual use.
- **Regrid token** — "▦ Load official parcel" button pulls the exact legal parcel
  boundary at your pin (paid, regrid.com).

## Sharing designs

"🔗 Copy share link" encodes the entire design into the URL — send it to anyone
and they see exactly your property, no accounts needed. 3D snapshots (📸) are
included in the printable PDF sheet.

## Optional: cloud saves with Supabase (free)

1. supabase.com → new project → SQL editor → run:
   `create table projects (id bigint primary key generated always as identity, name text, data jsonb, created_at timestamptz default now());`
2. This app currently saves to the browser; wiring Supabase means swapping the
   loadProjects/saveProjects functions in src/App.jsx for supabase-js calls —
   a good first customization if you take this codebase further.

## Custom domain (~$10/yr)

Buy a domain (Namecheap/Cloudflare) → Netlify: Site settings → Domain management
→ Add custom domain → follow the DNS instructions. HTTPS is automatic.

## Notes

- Prices are illustrative market-typical estimates; vendors are fictional.
- Zillow/Realtor/LandWatch and Amazon/eBay/Home Depot/Lowe's buttons are deep links
  to live listings/prices (those services don't offer public APIs).
- Official parcel boundaries: use the County GIS / Regrid links, then trace the
  recorded plat on the satellite map for an exact match.
