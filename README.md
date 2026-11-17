# Scout Campsite Finder

A free public website that shows Scout and Guide campsites, huts and activity centres on a map, with search, filters, "nearest to me", a 3D globe view, and an **Add a site** form whose suggestions go to a Google Sheet for a volunteer to approve.

- **Hosting:** Cloudflare (free plan): the website plus a small server script (a "Worker").
- **The list of sites:** a Google Sheet. Set a row to *Approved* and it shows on the map; *Rejected* and it's hidden.
- **No cookies, no tracking, no logins** for visitors.

## Start here

| If you are… | Open |
|---|---|
| Setting this up for the first time with ChatGPT (or another AI) helping | **[`CHATGPT-SETUP-PROMPT.txt`](CHATGPT-SETUP-PROMPT.txt)**: open it, copy all of it, paste it into ChatGPT |
| Setting it up yourself | **`SETUP.md`** |
| Wanting to understand how it fits together | **`docs/HOW-IT-WORKS.md`** |
| An AI coding assistant changing the code | **`CLAUDE.md`** |

## Quick start (for people comfortable with a terminal)

```bash
git clone https://github.com/FredFree83/scout-campsite-finder.git
cd scout-campsite-finder
npm install
```

Then follow [`SETUP.md`](SETUP.md). You need free Cloudflare and Google accounts.

## What's in this folder

```
public/                 the website (map page, 3D globe page, styles, map libraries, a starter copy of the sites)
src/worker.js           the Cloudflare Worker: serves the site, takes suggestions, rebuilds the list from the Sheet
google-apps-script/     Code.gs: the script that goes inside the Google Sheet
data/campsites.xlsx     all 538 sites, ready to import into a new Google Sheet
wrangler.jsonc          Cloudflare settings (three PASTE_… values to fill in during setup)
.dev.vars.example       test settings for running it on your own computer
```

No passwords or keys are included. You make your own during setup.

## Licence

MIT: free to use, copy and change. The map pictures and data services (Esri, OpenStreetMap, OpenTopoMap, postcodes.io) have their own terms. Keep their credits on the map.
