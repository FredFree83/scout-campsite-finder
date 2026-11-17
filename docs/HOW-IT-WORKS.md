# How Scout Campsite Finder works

```
                         ┌──────────────── Cloudflare (free) ────────────────┐
 Visitors ── website ───►│  public/  (map, 3D globe)                         │
                         │  Worker   /api/sites   ◄── KV storage: the list   │
   "Add a site" form ───►│           /api/submit ─┐                          │
                         │  every 10 min: refresh │      ▲                   │
                         └────────────────────────┼──────┼───────────────────┘
                                                  ▼      │ Approved rows
                                   Google Sheet (Apps Script web app)
                                   Pending / Approved / Rejected
                                                  ▲
                         optional: a shared Google Maps list (new places → Pending)
```

## The pieces
- **The website** (`public/`): plain HTML/CSS/JavaScript. The 2D map uses Leaflet; the optional 3D globe uses MapLibre. Map pictures come from Esri (satellite), OpenStreetMap (map) and OpenTopoMap (terrain). Postcode search uses postcodes.io; place search uses OpenStreetMap's Photon and Nominatim.
- **The Worker** (`src/worker.js`): a small program on Cloudflare. It serves the website, hands out the list of sites, checks and forwards suggestions, and every 10 minutes rebuilds the list from the Sheet.
- **KV storage:** Cloudflare's simple key-value store, which holds the ready-made list so the website loads fast.
- **The Google Sheet** with **Code.gs** (Apps Script): the main list. The website talks to it through a private "web app" address, protected by a long password (the *Sheet password*).

## A suggestion's journey
1. Someone fills in **Add a site** and passes Cloudflare's "I'm human" check (Turnstile).
2. The Worker checks the fields, allows at most 5 suggestions per person per hour, and sends it to the Sheet.
3. It appears in the Sheet as **Pending**. If `NOTIFY` is set, an email goes out.
4. A volunteer sets **Approved**. The Sheet tells the Worker to rebuild straight away, or the 10-minute timer catches it.

## Passwords and keys (all made during setup, none in the files)
| Name | What it's for | Where it lives |
|---|---|---|
| Sheet password | lets the Worker talk to the Sheet's script | Cloudflare secret `APPS_SCRIPT_SECRET` + Script property `SECRET` |
| Refresh password | lets the Sheet ask the Worker to rebuild now | Cloudflare secret `REFRESH_SECRET` + inside Script property `REFRESH_URL` |
| Turnstile secret key | checks the "I'm human" answer | Cloudflare secret `TURNSTILE_SECRET` |
| Turnstile site key | shows the "I'm human" check (public) | `wrangler.jsonc` |

## Useful addresses (on your site)
- `/api/status`: when the list was last rebuilt, how many sites, and any problems.
- `/globe`: the 3D globe view.

## Free-plan limits (roughly; providers change them now and then)
- Cloudflare Workers: 100,000 requests a day. KV: about 1,000 writes a day (the list is only saved when it changes).
- Google Apps Script and Sheets: far more than this needs.
- Nominatim (country lookups): 1 a second, so new places get their country over a few runs.

## Privacy
No cookies, no browser storage, no analytics. Visitor IP addresses are only used in memory for the human check and the hourly limit. Suggestions keep only what people type. The map shows contact emails and booking links that are already public; check owners are happy with that.
