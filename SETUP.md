# Setting up Scout Campsite Finder

The full step-by-step guide is in **`CHATGPT-SETUP-PROMPT.txt`**, under "THE STEPS". It's written so an AI assistant can walk you through it, but you can follow it yourself just as well. About 45 minutes, all on free plans.

## The short version
1. Install Node.js LTS and Git, fork and clone this repository (or download it as a ZIP), then run `npm install` in the folder.
2. Make two long random passwords (the Sheet password and the Refresh password): `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
3. Google Sheet: import `data/campsites.xlsx` (tab must be named **Submissions**).
4. Apps Script: paste `google-apps-script/Code.gs`, add Script property `SECRET`, run `setup`, then deploy it as a **Web app** (Execute as Me, access Anyone) and copy the `/exec` address.
5. Cloudflare: `npx wrangler login` → `npx wrangler kv namespace create SITES` → put the id and the `/exec` address into `wrangler.jsonc` → `npx wrangler deploy`.
6. Turnstile widget for your site address → site key into `wrangler.jsonc` → `npx wrangler secret put TURNSTILE_SECRET`.
7. `npx wrangler secret put APPS_SCRIPT_SECRET` (Sheet password) and `npx wrangler secret put REFRESH_SECRET` (Refresh password) → `npx wrangler deploy`.
8. Apps Script Script property `REFRESH_URL` = `https://YOUR-SITE/api/refresh?key=REFRESH-PASSWORD`.
9. Build the list: POST to that same address (or wait 10 minutes). Check `https://YOUR-SITE/api/status`.

## Day to day
- **Approved** = shown on the map, **Pending** = waiting, **Rejected** = hidden. Use Rejected rather than deleting a row.
- After changing Code.gs: paste it → Save → run `setup` → Deploy → Manage deployments → pencil → **New version** → Deploy.
- After changing website files: `npx wrangler deploy`.
- Test on your own computer: copy `.dev.vars.example` to `.dev.vars`, then `npm run dev`.

See `docs/HOW-IT-WORKS.md` for how the pieces fit together.
