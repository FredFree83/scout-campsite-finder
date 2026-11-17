// Scout Campsite Finder: Cloudflare Worker.
// Serves the site (public/), and three small jobs:
//   GET  /api/sites     the site list (kept in KV, rebuilt nightly and whenever a submission is approved)
//   GET  /api/status    when the list was last rebuilt, and how many sites came from where
//   GET  /api/config    public settings the page needs (the Turnstile site key)
//   POST /api/submit    a new site from the "Add a site" form → checked → added to the Google Sheet as "Pending"
//   POST /api/refresh   rebuild the list now (the Google Sheet calls this when you approve something)
// Nightly (cron): re-read the shared Google Maps list + approved rows from the Sheet → tag → save to KV.
// No cookies are set anywhere. Visitor IP addresses are only used in memory for Turnstile and rate limiting.

const ORGS = ['Scouts', 'Scouts & Guides', 'Girlguiding', 'Scout Adventures', 'Overseas scouting', 'Other / unknown'];
const KINDS = ['Camping', 'Indoor', 'Activity centre', 'Scout hut / HQ', 'Water / waterside', 'Restricted / check first'];

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/api/sites' && req.method === 'GET') return sites(env);
      if (url.pathname === '/api/status' && req.method === 'GET') return json(JSON.parse(await env.SITES.get('meta') || '{"ok":false,"notes":["Not refreshed yet"]}'));
      if (url.pathname === '/api/config' && req.method === 'GET') return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || '' });
      if (url.pathname === '/api/submit' && req.method === 'POST') return submit(req, env);
      if (url.pathname === '/api/refresh' && req.method === 'POST') {
        if (!env.REFRESH_SECRET || url.searchParams.get('key') !== env.REFRESH_SECRET) return json({ error: 'Not allowed' }, 403);
        return json(await refresh(env, { fullList: url.searchParams.get('full') === '1' }));
      }
      if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: 'Something went wrong' }, 500);
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refresh(env).then(r => console.log('refresh', JSON.stringify(r))));
  },
};

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY, ...extra } });
}

// ---------------------------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------------------------
async function sites(env) {
  const body = await env.SITES.get('sites');
  if (body) return new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', ...SECURITY } });
  return env.ASSETS.fetch(new Request('https://assets/sites.json')); // first run, before the nightly job has filled KV
}

// ---------------------------------------------------------------------------------------------
// New submissions
// ---------------------------------------------------------------------------------------------
async function submit(req, env) {
  if (!env.APPS_SCRIPT_URL || !env.APPS_SCRIPT_SECRET) return json({ error: 'Adding sites is not switched on yet.' }, 503);
  const raw = await req.text();
  if (raw.length > 8000) return json({ error: 'Too long' }, 413);
  let d; try { d = JSON.parse(raw); } catch { return json({ error: 'Bad request' }, 400); }
  const ip = req.headers.get('CF-Connecting-IP') || '';

  // 1. Human check (Cloudflare Turnstile)
  if (env.TURNSTILE_SECRET) {
    const form = new FormData();
    form.append('secret', env.TURNSTILE_SECRET); form.append('response', String(d.token || '')); if (ip) form.append('remoteip', ip);
    const v = await (await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form })).json();
    if (!v.success) return json({ error: 'Please tick the “I’m human” check and try again.' }, 400);
  }

  // 2. Rate limit: 5 submissions per IP per hour (kept in the edge cache, not stored anywhere)
  if (ip) {
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + (env.APPS_SCRIPT_SECRET || ''))))].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
    const key = new Request(`https://ratelimit.internal/${hash}/${Math.floor(Date.now() / 3600e3)}`);
    const hit = await caches.default.match(key), n = hit ? +(await hit.text()) : 0;
    if (n >= 5) return json({ error: 'Thanks! You have sent a few already. Please try again in an hour.' }, 429);
    await caches.default.put(key, new Response(String(n + 1), { headers: { 'Cache-Control': 'max-age=3600' } }));
  }

  // 3. Check and tidy every field
  const str = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  const lat = Number(d.lat), lng = Number(d.lng);
  const site = {
    name: str(d.name, 120), org: ORGS.includes(d.org) ? d.org : 'Other / unknown',
    kinds: (Array.isArray(d.kinds) ? d.kinds : []).filter(k => KINDS.includes(k)).slice(0, 6),
    note: str(d.note, 1000), url: /^https?:\/\/\S+$/i.test(str(d.url, 300)) ? str(d.url, 300) : '',
    by: str(d.by, 120), addr: str(d.addr, 300), managedBy: str(d.managedBy, 150), bookingNote: str(d.bookingNote, 120),
    email: /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(str(d.email, 120)) ? str(d.email, 120) : '', osm: /^(node|way|relation|[NWR])\/?\d+$/i.test(str(d.osm, 40)) ? str(d.osm, 40) : '',
    lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6,
  };
  if (site.name.length < 2) return json({ error: 'Please give the site a name.' }, 400);
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180) || (lat === 0 && lng === 0)) return json({ error: 'Please pick a location on the map.' }, 400);
  if (/https?:\/\//i.test(site.name + site.by + site.managedBy + site.bookingNote)) return json({ error: 'Links go in the Booking website box.' }, 400);
  if (str(d.email, 120) && !site.email) return json({ error: 'That email address doesn’t look right.' }, 400);

  // 4. Hand it to the Google Sheet as "Pending"
  const r = await fetch(env.APPS_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: env.APPS_SCRIPT_SECRET, action: 'submit', site }) });
  const out = await r.json().catch(() => ({}));
  if (!out.ok) return json({ error: 'Could not save it just now. Please try again later.' }, 502);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------------------------
// Rebuild the list: Google Maps shared list + approved rows from the Sheet
// ---------------------------------------------------------------------------------------------
async function refresh(env, opts = {}) {
  const started = Date.now(), sheetMode = env.LIST_SOURCE === 'sheet';
  const geo = JSON.parse(await env.SITES.get('geo') || 'null') || await seedGeo(env);
  const out = [], notes = [];

  // a. the shared Google Maps list (unofficial: the same request Google's own page makes)
  // Google is only asked every 6 hours (asking too often gets "too many requests"); in between, the last good copy is used
  const cached = JSON.parse(await env.SITES.get('list') || 'null');
  let listItems = cached?.items || [], listFrom = cached?.at || null, listFailed = false;
  if (env.GOOGLE_LIST_ID && (opts.fullList || !cached || Date.now() - Date.parse(cached.at) > 6 * 3600e3)) {
    try {
      const fresh = await readGoogleList(env.GOOGLE_LIST_ID);
      if (fresh.length) { listItems = fresh; listFrom = new Date().toISOString(); await env.SITES.put('list', JSON.stringify({ at: listFrom, items: fresh })); }
      else notes.push('Google list came back empty: using the copy from ' + listFrom);
    } catch (e) { notes.push(`Google list: ${e.message}, using the copy from ${listFrom}`); listFailed = true; }
  }
  if (!listItems.length && !sheetMode) {
    // never read yet: start from the Google places already showing on the site
    const prev = JSON.parse(await env.SITES.get('sites') || 'null') || await (await env.ASSETS.fetch(new Request('https://assets/sites.json'))).json();
    listItems = prev.filter(s => String(s.id).startsWith('g')).map(({ org, kinds, country, region, assoc, dist, ...rest }) => rest);
    notes.push('Using the places already on the site until Google can be read again');
  }
  if (!listItems.length && !sheetMode) return { ok: false, notes };
  // after a refusal, wait 6 hours before asking Google again (keeps the copy we have, just restarts the clock)
  if (listFailed) await env.SITES.put('list', JSON.stringify({ at: new Date().toISOString(), items: listItems, lastGoodRead: listFrom }));

  // b. the Sheet
  let approved = [], known = new Set(), sheetFailed = false;
  if (env.APPS_SCRIPT_URL && env.APPS_SCRIPT_SECRET) {
    try {
      const r = await fetch(`${env.APPS_SCRIPT_URL}?${new URLSearchParams({ secret: env.APPS_SCRIPT_SECRET, action: 'approved' })}`);
      const o = await r.json();
      if (!o.ok || !Array.isArray(o.sites)) throw new Error(o.error || 'unexpected reply');
      if (sheetMode && !Array.isArray(o.known)) throw new Error('the Sheet script is an old version');
      approved = o.sites; known = new Set((o.known || []).map(String));
    } catch (e) { notes.push('Sheet: ' + e.message + ' (kept the sites already showing)'); sheetFailed = true; }
  }
  // when the Sheet is the main list and can't be read, change nothing
  if (sheetMode && sheetFailed) return { ok: false, notes };

  // c. country for anything new (Nominatim: max 1 a second, and Workers allow ~50 outside requests a run, so 35 at most per run)
  let looked = 0;
  const where = async (lat, lng) => {
    const k = `${lat.toFixed(3)},${lng.toFixed(3)}`;
    if (geo[k]) return geo[k];
    if (looked >= 35) return null;
    looked++;
    await new Promise(r => setTimeout(r, 1100));
    try {
      const p = await (await fetch(`https://nominatim.openstreetmap.org/reverse?${new URLSearchParams({ format: 'jsonv2', lat, lon: lng, zoom: 5, 'accept-language': 'en' })}`,
        { headers: { 'User-Agent': 'ScoutCampsiteFinder/1.0 (Cloudflare Worker)' } })).json();
      return geo[k] = placeFromAddress(p.address || {});
    } catch { return null; }
  };
  const fromSheet = async a => {
    const lat = +a.lat, lng = +a.lng;
    if (!isFinite(lat) || !isFinite(lng)) return null;
    const g = await where(lat, lng) || { country: 'Unknown', region: 'Other' };
    const kinds = String(a.kinds || '').split(',').map(s => s.trim()).filter(k => KINDS.includes(k));
    const guess = describe({ name: a.name, pin: '', note: a.note || '', managedBy: a.managedBy, region: g.region, orgText: a.assoc });
    return {
      id: 's' + a.id, name: String(a.name), pin: '', note: a.note || '', addr: a.addr || '', lat, lng, ...g,
      org: ORGS.includes(a.org) ? a.org : guess.org, kinds: kinds.length ? kinds : guess.kinds, booking: a.url || '', added: true,
      ...(a.managedBy ? { managedBy: String(a.managedBy) } : {}), ...(a.email ? { email: String(a.email) } : {}),
      ...(a.bookingNote ? { bookingNote: String(a.bookingNote) } : {}), ...(a.assoc ? { assoc: String(a.assoc) } : {}),
    };
  };

  let sentToSheet = 0;
  if (sheetMode) {
    // The Sheet is the main list: show its Approved rows only. Places in the Google Maps list that the Sheet has
    // never seen go into the Sheet as Pending, for you to approve or reject (max 100 a run).
    const fresh = listItems.filter(it => !known.has(it.id)).slice(0, 100);
    if (fresh.length) {
      const sites = [];
      for (const it of fresh) {
        const g = await where(it.lat, it.lng) || { country: 'Unknown', region: 'Other' };
        const d = describe({ ...it, ...g });
        sites.push({ sourceId: it.id, name: d.name, org: d.org, kinds: d.kinds, note: d.note, url: d.booking || '', lat: d.lat, lng: d.lng, addr: d.addr,
          managedBy: d.managedBy || '', email: d.email || '', bookingNote: d.bookingNote || '', assoc: d.assoc || '', by: 'Found in the Google Maps list' });
      }
      try {
        const r = await fetch(env.APPS_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: env.APPS_SCRIPT_SECRET, action: 'import', status: 'Pending', sites }) });
        const o = await r.json(); sentToSheet = o.added || 0;
      } catch (e) { notes.push('Could not add new Google list places to the Sheet: ' + e.message); }
    }
    for (const a of approved) { const s = await fromSheet(a); if (s) out.push(s); }
  } else {
    for (const it of listItems) {
      const g = await where(it.lat, it.lng) || { country: 'Unknown', region: 'Other' };
      out.push(describe({ ...it, ...g }));
    }
    for (const a of approved) {
      if (out.some(s => dist(s, { lat: +a.lat, lng: +a.lng }) < 0.1)) continue; // already in the Google list
      const s = await fromSheet(a); if (s) out.push(s);
    }
    if (sheetFailed) {
      const prev = JSON.parse(await env.SITES.get('sites') || '[]');
      out.push(...prev.filter(s => s.added));
    }
  }
  out.forEach(s => { if (!s.kinds.length) s.kinds = ['Camping']; });

  // only write when something changed: the free plan allows about 1,000 writes a day and this runs every 10 minutes
  const sitesJson = JSON.stringify(out), changed = sitesJson !== await env.SITES.get('sites');
  if (looked) await env.SITES.put('geo', JSON.stringify(geo));
  const meta = { ok: true, mainList: sheetMode ? 'Google Sheet' : 'Google Maps list', updated: new Date().toISOString(), googleListRead: listFrom,
    fromList: listItems.length, fromSheet: approved.length, newPlacesSentToSheet: sentToSheet, total: out.length, newLookups: looked, ms: Date.now() - started, notes };
  if (changed) { await env.SITES.put('sites', sitesJson); await env.SITES.put('meta', JSON.stringify(meta)); }
  return { ...meta, changed };
}

async function readGoogleList(id) {
  if (!id) throw new Error('GOOGLE_LIST_ID not set');
  const pb = `!1m4!1s${id}!2e1!3m1!1e1!2e2!3e2!4i5000!16b1`;
  const r = await fetch(`https://www.google.com/maps/preview/entitylist/getlist?authuser=0&hl=en&gl=gb&pb=${encodeURIComponent(pb)}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = JSON.parse((await r.text()).replace(/^\)\]\}'\s*/, ''));
  const items = d?.[0]?.[8] || [];
  return items.map(it => {
    const c = it?.[1]?.[5]; if (!c) return null;
    const ids = it[1][6] || [], gname = it[2] || '';
    const n = parseNote(it[3] || '');
    let name = gname;
    if (n.title) name = n.title;
    else if (/^\d+°|^dropped pin$|^[A-Z]{1,2}\d/i.test(gname)) name = n.note ? n.note.split(/[.—]/)[0].slice(0, 60).trim() : 'Unnamed pin';
    return { id: 'g' + (ids.join('_') || `${c[2]},${c[3]}`), name, pin: gname !== name ? gname : '', ...n, title: undefined,
      addr: it[1][4] || '', lat: +(+c[2]).toFixed(6), lng: +(+c[3]).toFixed(6) };
  }).filter(Boolean);
}

// The list's notes look like:
//   [Site name — description]            (older entries)
//   Organisation / Scouts  (two lines)   or  Organisation — Scouts
//   Managed by — Hampshire Scouts
//   Booking website — https://…
//   Public contact email — someone@…
const FIELD = { 'organisation': 'orgText', 'managed by': 'managedBy', 'booking website': 'booking', 'public contact email': 'email' };
const EMPTY = /^(n\/?a|none|unknown|not (found|known|listed|published|available)|could not (verify|find)|-+|tbc|\?)\.?$/i;
function parseNote(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean), f = {}, desc = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], low = l.toLowerCase();
    if (FIELD[low] && i + 1 < lines.length && !/ — /.test(lines[i + 1])) { f[FIELD[low]] = lines[++i]; continue; }
    const m = l.match(/^([A-Za-z ]{3,30}?)\s+—\s+(.*)$/);
    if (m && FIELD[m[1].toLowerCase()]) { f[FIELD[m[1].toLowerCase()]] = m[2].trim(); continue; }
    desc.push(l);
  }
  let title = '';
  if (desc.length && / — /.test(desc[0]) && lines[0] === desc[0]) { const [t, ...rest] = desc[0].split(' — '); title = t.trim(); desc[0] = rest.join(' — ').trim(); }
  for (const k of Object.keys(f)) if (EMPTY.test(f[k])) delete f[k];
  const out = { title, note: desc.filter(Boolean).join(' ') };
  if (f.orgText) out.orgText = f.orgText;
  if (f.managedBy) out.managedBy = f.managedBy.slice(0, 150);
  const url = (f.booking || '').match(/https?:\/\/[^\s)]+/);
  if (url) { out.booking = url[0]; const extra = f.booking.replace(url[0], '').replace(/[()]/g, '').trim(); if (extra) out.bookingNote = extra.slice(0, 80); }
  else if (f.booking) out.bookingNote = f.booking.slice(0, 120);
  const em = (f.email || '').match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/);
  if (em) out.email = em[0];
  return out;
}

// First run: reuse the countries already worked out in the bundled sites.json, so only new places need looking up
async function seedGeo(env) {
  const geo = {};
  try {
    const list = await (await env.ASSETS.fetch(new Request('https://assets/sites.json'))).json();
    list.forEach(s => geo[`${s.lat.toFixed(3)},${s.lng.toFixed(3)}`] = { country: s.country, region: s.region });
  } catch {}
  return geo;
}

const UK = ['England', 'Scotland', 'Wales', 'Northern Ireland'];
const CONTINENT = (() => {
  const m = {}, add = (r, codes) => codes.split(' ').forEach(c => m[c] = r);
  add('Europe', 'al ad at by be ba bg hr cy cz dk ee fo fi fr de gi gr hu is it xk lv li lt lu mt md mc me nl mk no pl pt ro ru sm rs sk si es se ch ua va');
  add('Australia & NZ', 'au nz fj pg');
  add('Africa', 'dz ao bj bw bf bi cm cv cf td km cd cg ci dj eg gq er sz et ga gm gh gn gw ke ls lr ly mg mw ml mr mu ma mz na ne ng rw st sn sc sl so za ss sd tz tg tn ug zm zw');
  add('North America', 'us ca mx gl bm bs cu jm ht do pr tt bb gt bz hn sv ni cr pa');
  add('South America', 'ar bo br cl co ec gy py pe sr uy ve');
  add('Asia', 'af am az bh bd bt bn kh cn ge hk in id ir iq il jp jo kz kw kg la lb my mv mn mm np kp om pk ps ph qa sa sg kr lk sy tw tj th tl tr tm ae uz vn ye');
  return m;
})();
function placeFromAddress(a) {
  const cc = (a.country_code || '').toLowerCase();
  if (cc === 'gb') { const n = UK.find(x => (a.state || '').includes(x)) || 'England'; return { country: n, region: 'UK' }; }
  if (['ie', 'im', 'je', 'gg'].includes(cc)) return { country: a.country || cc.toUpperCase(), region: 'Ireland & islands' };
  return { country: a.country || 'Unknown', region: CONTINENT[cc] || 'Other' };
}

function dist(a, b) {
  const R = 6371, r = x => x * Math.PI / 180, dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  return 2 * R * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2));
}

// Same guesses as the first import: who runs it and what kind of site it is, from its name and note
function describe(s) {
  const desc = [s.name, s.pin, s.note].join(' ').toLowerCase(), home = ['UK', 'Ireland & islands'].includes(s.region);
  const t = desc + ' ' + [s.orgText, s.managedBy].join(' ').toLowerCase();
  const scout = /scout|pfadfind|speider|spejd|scouting|dpsg|scoutisme|baden.powell|gilwell|fdf|padvind|plast/.test(t);
  const guide = /girlguid|guide|guiding/.test(t);
  const ot = (s.orgText || '').toLowerCase();
  let org;
  if (home && /scout adventures/.test((s.managedBy || '').toLowerCase() + ' ' + desc)) org = 'Scout Adventures';
  else if (/^(external|other)/.test(ot)) org = 'Other / unknown';
  else if (/scouts? (and|&) guid/.test(ot) || (scout && guide && !/^(scouts|girlguiding|guiding)/.test(ot))) org = 'Scouts & Guides';
  else if (/guid/.test(ot) || (!ot && guide)) org = 'Girlguiding';
  else if (/scout|plast/.test(ot) || scout) org = home ? 'Scouts' : 'Overseas scouting';
  else org = home ? 'Other / unknown' : 'Overseas scouting';
  // the association named in brackets or after a dash, e.g. "Scouts — Scouts Australia" → "Scouts Australia"
  const assoc = (s.orgText || '').match(/\(([^)]+)\)|—\s*(.+)$/);
  const kinds = [];
  if (/camp|kampeer|terrein|lejr|field|wood|copse|plantation|farm/.test(desc)) kinds.push('Camping');
  if (/house|lodge|cottage|\bhall\b|hytte|indoor|residential|bunk|hostel|barn|hytta|chalet|cabin|bothy|manor/.test(desc)) kinds.push('Indoor');
  if (/\bhut\b|headquarters|\bhq\b|scout group|^\d+(st|nd|rd|th) /.test(desc)) kinds.push('Scout hut / HQ');
  if (/activit|adventure|outdoor|climb|centre|center|centrum|zentrum|estate/.test(desc)) kinds.push('Activity centre');
  if (/water|sea scout|lake|loch|river|boat|sail|canoe|kayak|marina|quay|beach|lough|island|isle|\bbay\b/.test(desc)) kinds.push('Water / waterside');
  if (/no public|private site|unconfirmed|closed|not .{0,20}bookable|members only|no longer exists|could not verify/.test(desc + ' ' + (s.bookingNote || '').toLowerCase())) kinds.push('Restricted / check first');
  const outS = { ...s, org, kinds: kinds.length ? kinds : ['Camping'] };
  if (assoc) outS.assoc = (assoc[1] || assoc[2]).trim();
  delete outS.orgText;
  return outS;
}
