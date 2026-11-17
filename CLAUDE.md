# CLAUDE.md: notes for AI coding assistants

Scout Campsite Finder: a public map of Scout/Guide campsites. Static site + one Cloudflare Worker + a Google Sheet (via Apps Script) as the data store. No framework, no build step, no database.

## Layout
- `public/index.html`, `public/app.js`: the 2D map (Leaflet + markercluster, self-hosted in `public/vendor/`). `app.js` is an ES module (top-level `await`).
- `public/globe.html`, `public/globe.js`: optional 3D globe (MapLibre GL v5, `projection: globe`), reached by the "3D version" button. Same data, popups and filters; adding sites stays on the 2D map.
- `public/glass.css`: all styling (the "glass" look: frosted panels, gradient primary buttons, pill chips; accent `#7413dc`).
- `public/sites.json`: fallback copy of the list, used only before the Worker has built one.
- `public/fonts/Noto Sans Bold/0-255.pbf`: the one glyph range MapLibre needs for cluster numbers (self-hosted).
- `src/worker.js`: routes `/api/sites`, `/api/status`, `/api/config`, `/api/submit` (POST), `/api/refresh?key=` (POST); `scheduled()` runs `refresh()` every 10 minutes.
- `google-apps-script/Code.gs`: lives inside the Google Sheet; `doPost` (`submit`, `import`), `doGet` (`approved` → `{sites, known}`), `onStatusChange` trigger calls the Worker's refresh.
- `data/campsites.xlsx`: seed data in the exact Sheet layout.

## Commands
- `npm install`, then `npm run dev` (local, uses `.dev.vars`; copy `.dev.vars.example`) and `npx wrangler deploy` (publish).
- `node --input-type=module --check < public/app.js` is a quick syntax check (same for `globe.js`, `src/worker.js`).

## Data flow
1. The Sheet (tab **Submissions**) is the main list when `LIST_SOURCE` = `"sheet"`: `refresh()` reads Approved rows → adds country/region (Nominatim reverse geocode, cached in KV `geo`, max 35 lookups a run) → writes KV `sites` (only if changed: KV free tier is ~1,000 writes a day).
2. Optional `GOOGLE_LIST_ID`: a shared Google Maps list read every 6 hours (unofficial endpoint, can return 429). Places whose id isn't in the Sheet's `Source ID` column are sent to the Sheet as Pending. Rejected rows keep their Source ID, so they aren't re-suggested.
3. `/api/submit`: Turnstile check → 5 a hour per IP (edge cache, IP hashed) → field validation → Apps Script `submit` → new Pending row.

## Rules to keep
- **No cookies, localStorage or tracking.** Fetches use `credentials: 'omit'`. Filters live in the URL hash so views are shareable. Don't add analytics or anything that sets cookies (and keep Cloudflare Bot Fight Mode off).
- **Secrets never in files:** `APPS_SCRIPT_SECRET`, `REFRESH_SECRET`, `TURNSTILE_SECRET` are Cloudflare secrets. `.secrets.local` and `.dev.vars` are git-ignored.
- **Sheet columns are append-only** (`COLS` in Code.gs, also the xlsx). Code looks columns up by header name. After changing Code.gs the owner must paste it, run `setup`, and publish a **new version** of the same web-app deployment (the URL stays the same).
- **Bump the `?v=` query** on `app.js`/`globe.js`/`glass.css` in the HTML when you change them, so browsers fetch the new file.
- Don't route requests through Apps Script (or anything else) to get around Google's rate limits.
- Leaflet map: `minZoom` is height-based and `maxBounds` has sideways slack, so the world doesn't repeat and edge places can still be centred. Set `maxZoom` explicitly on the map: markercluster breaks without it.
- Popups show only contact details the list publishes ("Public contact email"); the form reminds people to do the same.

## Organisations and types (filters)
`ORGS`: Scouts, Scouts & Guides, Girlguiding, Scout Adventures, Overseas scouting, Other / unknown.
`KINDS`: Camping, Indoor, Activity centre, Scout hut / HQ, Water / waterside, Restricted / check first.
Defined in `app.js`, `globe.js` and `src/worker.js`: keep all three in step.
