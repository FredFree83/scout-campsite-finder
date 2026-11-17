// Scout Campsite Finder.
// Sites come from /api/sites (the Cloudflare Worker); opened without the Worker it falls back to sites.json.
// New sites go to /api/submit. No cookies, localStorage or tracking: nothing is stored in the visitor's browser.
const NO_CREDS = { credentials: 'omit' };
async function getJSON(u, opt = {}) { const r = await fetch(u, { ...NO_CREDS, ...opt }); if (!r.ok) throw new Error(r.status); return r.json(); }
let SITES = [], CONFIG = { turnstileSiteKey: '' }, LIVE = false;
// if anything goes wrong while starting up, say so instead of leaving an empty map
const fail = msg => { document.getElementById('list').innerHTML = `<div class="empty">${msg}</div>`; document.getElementById('headCount').textContent = 'Could not load sites'; document.getElementById('loading').innerHTML = msg; };
window.addEventListener('error', e => { if (!SITES.length) fail('Something went wrong loading the map. Please reload the page.'); });
try { SITES = await getJSON('/api/sites', { cache: 'no-cache' }); LIVE = true; }
catch { try { SITES = await getJSON('sites.json'); } catch { fail('Could not load the sites. Check your connection and reload the page.'); throw new Error('no sites'); } }
try { CONFIG = await getJSON('/api/config'); } catch {}

const ORG_COLOURS = {
  'Scouts': '#7413dc', 'Scouts & Guides': '#4b3fd1', 'Girlguiding': '#1673c4',
  'Scout Adventures': '#d9480f', 'Overseas scouting': '#0e8a7e', 'Other / unknown': '#6b6577',
};
const ORGS = Object.keys(ORG_COLOURS);
const REGIONS = ['UK', 'Ireland & islands', 'Europe', 'Australia & NZ', 'Africa', 'North America', 'South America', 'Asia', 'Other'];
const KINDS = ['Camping', 'Indoor', 'Activity centre', 'Scout hut / HQ', 'Water / waterside', 'Restricted / check first'];
const state = { q: '', region: new Set(), org: new Set(), kind: new Set(), country: '', origin: null, selected: null, adding: false };

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (id, cls = '') => `<svg class="${cls}"><use href="#i-${id}"/></svg>`;

// sites sent from this page during this visit (shown as "waiting for review"; forgotten when the page closes)
const pending = [];
const ALL = () => SITES.concat(pending);

// ---------- map ----------
// one copy of the world, no grey above/below: the furthest you can zoom out is when the world just fills the screen
const WORLD = L.latLngBounds([[-85, -180], [85, 180]]);
const PAN_LIMIT = L.latLngBounds([[-85, -300], [85, 300]]); // sideways slack so edge places can be centred and zoomed
// (fills the height; on very wide screens the sides are plain sea colour rather than a repeated world)
const fitZoom = () => Math.max(1, Math.ceil(Math.log2(window.innerHeight / 256)));
const map = L.map('map', { zoomControl: false, minZoom: fitZoom(), maxZoom: 19, maxBounds: PAN_LIMIT, maxBoundsViscosity: 0.9, worldCopyJump: false }).setView([54.3, -3.2], 6);
window.addEventListener('resize', () => { map.setMinZoom(fitZoom()); });
L.control.zoom({ position: 'topright' }).addTo(map);
const base = {
  sat: L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, noWrap: true, bounds: WORLD, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, noWrap: true, bounds: WORLD }),
  ]),
  osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, noWrap: true, bounds: WORLD, attribution: '© OpenStreetMap contributors' }),
  topo: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, noWrap: true, bounds: WORLD, attribution: '© OpenStreetMap, SRTM | © OpenTopoMap' }),
};
const SEA = { sat: '#0b2f45', osm: '#aad3df', topo: '#97d2e3' };
let currentBase = base.sat.addTo(map); $('map').style.background = SEA.sat;
$('layers').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  map.removeLayer(currentBase); currentBase = base[b.dataset.l].addTo(map);
  $('map').style.background = SEA[b.dataset.l];
  document.querySelectorAll('#layers button').forEach(x => x.classList.toggle('active', x === b));
});

const cluster = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 45,
  iconCreateFunction: c => L.divIcon({ html: `<div><span>${c.getChildCount()}</span></div>`, className: 'marker-cluster', iconSize: [40, 40] }) });
map.addLayer(cluster);

const KIND_ICON = { 'Camping': 'tent', 'Indoor': 'house', 'Activity centre': 'compass', 'Scout hut / HQ': 'flag', 'Water / waterside': 'wave' };
const kindIcon = s => KIND_ICON[(s.kinds || []).find(k => KIND_ICON[k])] || 'tent';
function pinIcon(s) {
  const c = s.pending ? '#8a8197' : ORG_COLOURS[s.org];
  return L.divIcon({ className: '', iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14],
    html: `<div class="site-dot${s.pending ? ' pending' : ''}" style="background:${c}">${icon(kindIcon(s))}</div>` });
}
const whereText = s => ['UK', 'Ireland & islands'].includes(s.region) ? s.country : `${s.country}`;

function popupHtml(s) {
  const site = s.booking || s.url;
  const host = site ? (() => { try { return new URL(site).hostname.replace(/^www\./, ''); } catch { return 'Website'; } })() : '';
  const facts = [
    s.managedBy && ['Managed by', esc(s.managedBy)],
    s.assoc && s.assoc !== s.managedBy && ['Association', esc(s.assoc)],
    site && ['Booking', `<a href="${esc(site)}" target="_blank" rel="noopener">${esc(host)}</a>${s.bookingNote ? ` <span class="sub">(${esc(s.bookingNote)})</span>` : ''}`],
    !site && s.bookingNote && ['Booking', esc(s.bookingNote)],
    s.email && ['Email', `<a href="mailto:${esc(s.email)}">${esc(s.email)}</a>`],
  ].filter(Boolean);
  return `<div class="pop">
    <h3>${esc(s.name)}</h3>
    <div class="badges">
      ${s.pending ? '<span class="badge" style="background:#ece7f4">Waiting for review</span>' : ''}
      <span class="badge" style="background:${ORG_COLOURS[s.org]};color:#fff">${esc(s.org)}</span>
      ${s.kinds.map(k => `<span class="badge">${esc(k)}</span>`).join('')}
      ${s.country ? `<span class="badge">${esc(s.country)}</span>` : ''}
    </div>
    ${s.note ? `<p>${esc(s.note)}</p>` : ''}
    ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` : ''}
    ${s.addr ? `<p class="sub">${esc(s.addr)}</p>` : ''}
    ${s.dist != null ? `<p class="sub"><b>${fmtDist(s.dist)}</b> from ${esc(state.origin.label)}</p>` : ''}
    <div class="actions">
      <a class="btn btn-primary" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}">${icon('route')}Directions</a>
      ${site ? `<a class="btn" target="_blank" rel="noopener" href="${esc(site)}">${icon('ext')}Book</a>`
             : `<a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}">${icon('ext')}Google Maps</a>`}
    </div></div>`;
}

const markers = {};
function makeMarker(s) {
  const m = L.marker([s.lat, s.lng], { icon: pinIcon(s), title: s.name });
  m.bindPopup(() => popupHtml(s), { maxWidth: 330 });
  m.on('click', () => select(s.id, false));
  markers[s.id] = m;
}
ALL().forEach(makeMarker);

// ---------- filters ----------
// Counts are "faceted": each group's numbers show what you'd get with your other choices kept,
// options that would give nothing are dimmed, and the country list follows the chosen regions.
const GROUPS = {
  region: { el: 'fRegion', key: 'region', values: REGIONS },
  org: { el: 'fOrg', key: 'org', values: ORGS, colours: ORG_COLOURS },
  kind: { el: 'fKind', key: 'kinds', values: KINDS },
};
const DISTS = [10, 25, 50, 100];
Object.assign(state, { maxDist: null, sort: 'name' });

function matches(s, skip) {
  if (skip !== 'region' && state.region.size && !state.region.has(s.region)) return false;
  if (skip !== 'country' && state.country && s.country !== state.country) return false;
  if (skip !== 'org' && state.org.size && !state.org.has(s.org)) return false;
  if (skip !== 'kind' && state.kind.size && !s.kinds.some(k => state.kind.has(k))) return false;
  if (skip !== 'dist' && state.origin && state.maxDist && haversine(state.origin, s) > state.maxDist / 0.621371) return false;
  if (state.q) {
    const hay = [s.name, s.pin, s.note, s.addr, s.country, s.region, s.org, s.kinds.join(' '), s.managedBy, s.assoc].join(' ').toLowerCase();
    if (!state.q.split(/\s+/).every(w => hay.includes(w))) return false;
  }
  return true;
}
function tally(skip, key) {
  const c = {}; ALL().forEach(s => { if (matches(s, skip)) [].concat(s[key]).forEach(v => c[v] = (c[v] || 0) + 1); }); return c;
}
function buildFilters() {
  for (const [name, g] of Object.entries(GROUPS)) {
    const c = tally(name, g.key), set = state[name], all = {}; ALL().forEach(s => [].concat(s[g.key]).forEach(v => all[v] = 1));
    $(g.el).innerHTML = g.values.filter(v => all[v] || set.has(v)).map(v =>
      `<button class="chip${set.has(v) ? ' on' : ''}${!c[v] && !set.has(v) ? ' zero' : ''}" data-v="${esc(v)}">${g.colours ? `<span class="dot" style="background:${g.colours[v]}"></span>` : ''}${esc(v)} <span class="n">${c[v] || 0}</span></button>`).join('');
  }
  const cc = tally('country', 'country');
  const list = Object.keys(cc).sort((a, b) => cc[b] - cc[a] || a.localeCompare(b));
  if (state.country && !cc[state.country]) list.unshift(state.country);
  $('fCountry').innerHTML = `<option value="">${state.region.size ? 'Any country here' : 'All countries'}</option>` +
    list.map(c => `<option value="${esc(c)}"${state.country === c ? ' selected' : ''}>${esc(c)} (${cc[c] || 0})</option>`).join('');

  $('fDist').hidden = !state.origin;
  if (state.origin) {
    const dc = DISTS.map(d => ALL().filter(s => matches(s, 'dist') && haversine(state.origin, s) <= d / 0.621371).length);
    $('fDist').innerHTML = `<button class="chip${!state.maxDist ? ' on' : ''}" data-d="">Any distance</button>` +
      DISTS.map((d, i) => `<button class="chip${state.maxDist === d ? ' on' : ''}${!dc[i] ? ' zero' : ''}" data-d="${d}">${d} mi <span class="n">${dc[i]}</span></button>`).join('');
  }

  // active filters as removable chips (handy when the filter section is folded away)
  const act = [];
  state.region.forEach(v => act.push(['region', v])); if (state.country) act.push(['country', state.country]);
  state.org.forEach(v => act.push(['org', v])); state.kind.forEach(v => act.push(['kind', v]));
  $('fCount').hidden = !act.length; $('fCount').textContent = act.length;
  $('activeRow').hidden = !act.length || !$('filters').classList.contains('closed');
  $('activeRow').innerHTML = act.map(([g, v]) => `<button class="chip on" data-g="${g}" data-v="${esc(v)}">${esc(v)}${icon('x')}</button>`).join('') +
    (act.length ? '<button class="text-btn" data-clear>Clear all</button>' : '');
}
for (const [name, g] of Object.entries(GROUPS)) {
  $(g.el).addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    const set = state[name], v = b.dataset.v; set.has(v) ? set.delete(v) : set.add(v);
    if (name === 'region' && state.country) { const s0 = ALL().find(s => s.country === state.country); if (state.region.size && s0 && !state.region.has(s0.region)) state.country = ''; }
    update(true);
  });
}
$('fCountry').onchange = e => { state.country = e.target.value; update(true); };
$('fDist').addEventListener('click', e => {
  const b = e.target.closest('.chip'); if (!b) return;
  state.maxDist = b.dataset.d ? +b.dataset.d : null; update(false); fitOrigin();
});
$('activeRow').addEventListener('click', e => {
  if (e.target.closest('[data-clear]')) return clearFilters();
  const b = e.target.closest('.chip'); if (!b) return;
  if (b.dataset.g === 'country') state.country = ''; else state[b.dataset.g].delete(b.dataset.v);
  update(true);
});
function clearFilters() { state.region.clear(); state.org.clear(); state.kind.clear(); state.country = ''; update(true); }
$('filterToggle').onclick = () => {
  const closed = $('filters').classList.toggle('closed');
  $('filterToggle').setAttribute('aria-expanded', !closed); buildFilters();
};
if (window.innerWidth <= 700) { $('filters').classList.add('closed'); $('filterToggle').setAttribute('aria-expanded', 'false'); }
$('sort').onchange = e => { state.sort = e.target.value; render(false); };
let qt; $('q').addEventListener('input', e => { clearTimeout(qt); qt = setTimeout(() => { state.q = e.target.value.trim().toLowerCase(); update(true); }, 150); });

// filters live in the address (#…) so a filtered view can be shared or bookmarked
function saveHash() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  for (const k of ['region', 'org', 'kind']) if (state[k].size) p.set(k, [...state[k]].join('|'));
  if (state.country) p.set('country', state.country);
  history.replaceState(null, '', p.toString() ? '#' + p : location.pathname);
}
function loadHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  state.q = p.get('q') || ''; $('q').value = state.q; state.country = p.get('country') || '';
  for (const k of ['region', 'org', 'kind']) (p.get(k) || '').split('|').filter(Boolean).forEach(v => state[k].add(v));
  return [...p.keys()].length > 0;
}
function update(fit) { buildFilters(); render(fit); saveHash(); }

// ---------- distance ----------
function haversine(a, b) {
  const R = 6371, r = x => x * Math.PI / 180, dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const fmtDist = km => { const mi = km * 0.621371; return mi < 10 ? mi.toFixed(1) + ' mi' : Math.round(mi).toLocaleString() + ' mi'; };
const panelPad = () => ({ paddingTopLeft: [window.innerWidth > 700 ? 410 : 20, window.innerWidth > 700 ? 80 : 130], paddingBottomRight: [30, 30] });

let originMarker = null;
function setOrigin(lat, lng, label) {
  state.origin = { lat, lng, label }; state.sort = 'near';
  $('sort').querySelector('[value=near]').disabled = false; $('sort').value = 'near';
  if (originMarker) map.removeLayer(originMarker);
  originMarker = L.marker([lat, lng], { icon: L.divIcon({ className: '', html: '<div class="you"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }), zIndexOffset: 2000, interactive: false }).addTo(map);
  status(`Nearest to <b>${esc(label)}</b> · <a id="clearNear">clear</a>`);
  $('clearNear').onclick = clearOrigin;
  update(false); fitOrigin();
}
// zoom so you can see where you are plus the closest few sites, clear of the side panel
function fitOrigin() {
  if (!state.origin) return;
  const near = visible.slice(0, 5).map(s => [s.lat, s.lng]);
  map.flyToBounds(L.latLngBounds([[state.origin.lat, state.origin.lng], ...near]), { ...panelPad(), maxZoom: 13, duration: 0.8 });
}
function clearOrigin() {
  state.origin = null; state.maxDist = null; if (originMarker) map.removeLayer(originMarker); originMarker = null;
  state.sort = 'name'; $('sort').value = 'name'; $('sort').querySelector('[value=near]').disabled = true;
  status(''); $('nearQ').value = ''; update(true);
}
function status(html, err) { $('nearStatus').innerHTML = html; $('nearStatus').classList.toggle('err', !!err); }
function busy(btn, on) { btn.classList.toggle('busy', on); }

// One box for full postcodes ("SO31 7BA"), the first half ("SO31") or a town/place name ("Fareham")
const PC_FULL = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i, PC_OUT = /^[A-Z]{1,2}\d[A-Z\d]?$/i;
const geoCache = {};
async function findPlace(q) {
  const key = q.toLowerCase(); if (geoCache[key]) return geoCache[key];
  const get = async u => { const r = await fetch(u, { ...NO_CREDS, signal: AbortSignal.timeout(6000) }); return r.ok ? r.json() : null; };
  let hit = null;
  if (PC_FULL.test(q)) { const j = await get('https://api.postcodes.io/postcodes/' + encodeURIComponent(q)); if (j?.result) hit = { lat: j.result.latitude, lng: j.result.longitude, label: j.result.postcode }; }
  else if (PC_OUT.test(q)) { const j = await get('https://api.postcodes.io/outcodes/' + encodeURIComponent(q)); if (j?.result) hit = { lat: j.result.latitude, lng: j.result.longitude, label: j.result.outcode }; }
  if (!hit) {
    const j = await get('https://photon.komoot.io/api/?' + new URLSearchParams({ q, limit: 1, lang: 'en', lat: 53, lon: -2 }));
    const f = j?.features?.[0];
    if (f) { const p = f.properties; hit = { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], label: [p.name, p.county || p.state || p.country].filter(Boolean).join(', ') }; }
  }
  return geoCache[key] = hit;
}
$('nearForm').onsubmit = async e => {
  e.preventDefault();
  const q = $('nearQ').value.trim(); if (!q) return;
  busy($('goNear'), true); status('Finding ' + esc(q) + '…');
  try { const hit = await findPlace(q); hit ? setOrigin(hit.lat, hit.lng, hit.label) : status(`Couldn't find “${esc(q)}”. Try a postcode or a town name.`, true); }
  catch { status('That took too long. Check your connection and try again.', true); }
  busy($('goNear'), false);
};
$('goMe').onclick = () => {
  if (!navigator.geolocation) return status('Your browser can\'t share its location.', true);
  busy($('goMe'), true); status('Finding you…');
  // low accuracy is quick (wifi/IP) and plenty for "nearest campsite"; give up after 8 seconds; reuse a fix up to 10 minutes old
  navigator.geolocation.getCurrentPosition(
    p => { busy($('goMe'), false); setOrigin(p.coords.latitude, p.coords.longitude, 'your location'); },
    err => { busy($('goMe'), false); status(err.code === 1 ? 'Location is blocked for this site. Allow it in your browser, or type a postcode or town.' : 'Couldn\'t get your location in time. Type a postcode or town instead.', true); },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 });
};

// ---------- render ----------
let visible = [];
function render(fit) {
  visible = ALL().filter(s => matches(s));
  ALL().forEach(s => s.dist = state.origin ? haversine(state.origin, s) : null);
  const byName = (a, b) => a.name.localeCompare(b.name);
  visible.sort(state.sort === 'near' && state.origin ? (a, b) => a.dist - b.dist
    : state.sort === 'country' ? (a, b) => a.country.localeCompare(b.country) || byName(a, b)
    : (a, b) => (b.pending || 0) - (a.pending || 0) || byName(a, b));
  cluster.clearLayers(); cluster.addLayers(visible.map(s => markers[s.id]));

  let lastC = null;
  $('list').innerHTML = visible.length ? visible.slice(0, 300).map(s => {
    const head = state.sort === 'country' && s.country !== lastC ? `<div class="group-head" style="padding:10px 11px 2px"><span>${esc(lastC = s.country)}</span></div>` : '';
    return head + `
    <div class="item${state.selected === s.id ? ' active' : ''}${s.pending ? ' pending' : ''}" data-id="${s.id}">
      <span class="sw" style="background:${ORG_COLOURS[s.org]}">${icon(kindIcon(s))}</span>
      <div><h3>${esc(s.name)}</h3><div class="meta">${s.pending ? 'Waiting for review · ' : ''}${esc(whereText(s))} · ${esc(s.org)} · ${esc(s.kinds.join(', '))}</div></div>
      ${s.dist != null ? `<div class="dist">${fmtDist(s.dist)}</div>` : ''}
    </div>`;
  }).join('') + (visible.length > 300 ? `<div class="empty">Showing 300 of ${visible.length}. Search or filter to narrow it down.</div>` : '')
    : `<div class="empty">No sites match.${state.maxDist ? ' Try a bigger distance.' : ''} <button class="text-btn" data-clear>Clear filters</button></div>`;

  $('headCount').textContent = visible.length === ALL().length ? `${ALL().length} sites` : `${visible.length} of ${ALL().length} sites`;
  if (!$('panel').classList.contains('open')) $('mToggle').textContent = `Show list (${visible.length})`;
  if (fit && visible.length && !state.origin) map.flyToBounds(L.latLngBounds(visible.map(s => [s.lat, s.lng])), { ...panelPad(), maxZoom: 13, duration: 0.6 });
}
function select(id, fly) {
  state.selected = id;
  document.querySelectorAll('.item').forEach(el => el.classList.toggle('active', el.dataset.id == id));
  if (fly) {
    const m = markers[id];
    cluster.zoomToShowLayer(m, () => { map.setView(m.getLatLng(), Math.max(map.getZoom(), 15)); m.openPopup(); });
    if (window.innerWidth <= 700) togglePanel(false);
  }
}
$('list').addEventListener('click', e => {
  if (e.target.closest('[data-clear]')) return clearFilters();
  const it = e.target.closest('.item'); if (it) select(it.dataset.id, true);
});

function togglePanel(open) { $('panel').classList.toggle('open', open); $('mToggle').setAttribute('aria-expanded', open); $('mToggle').textContent = open ? 'Hide list' : `Show list (${visible.length})`; }
$('mToggle').onclick = () => togglePanel(!$('panel').classList.contains('open'));

// =====================================================================================
// Add a site
// Real places come from OpenStreetMap: campsites (tourism=camp_site) and anything named
// "scout"/"guide" in view are shown as clickable spots (Nominatim), place search uses Photon,
// and a dropped pin is turned into a real address (Nominatim reverse).
// =====================================================================================
const candLayer = L.layerGroup().addTo(map);
let tempMarker = null, draft = null;

function nearestListed(lat, lng) {
  let best = null;
  for (const s of ALL()) { const d = haversine({ lat, lng }, s); if (!best || d < best.d) best = { s, d }; }
  return best && best.d < 0.4 ? best : null;
}

function startAdding() {
  state.adding = true; document.body.classList.add('adding');
  $('addbar').hidden = false; $('placeQ').focus();
  if (window.innerWidth <= 700) togglePanel(false);
  if (map.getZoom() < 12) $('candStatus').textContent = 'Zoom in to see campsites from OpenStreetMap you can click.';
  loadCandidates();
}
function stopAdding() {
  state.adding = false; document.body.classList.remove('adding');
  $('addbar').hidden = true; candLayer.clearLayers(); $('placeResults').innerHTML = ''; $('placeQ').value = '';
  if (tempMarker) { map.removeLayer(tempMarker); tempMarker = null; }
}
$('addBtn').onclick = () => state.adding ? stopAdding() : startAdding();
$('addClose').onclick = stopAdding;

// Clickable OSM campsites in view (Nominatim allows ~1 request a second, so this is debounced and sequential)
let candTimer, candSeq = 0;
map.on('moveend', () => { if (state.adding) { clearTimeout(candTimer); candTimer = setTimeout(loadCandidates, 700); } });
async function nominatim(params) {
  const r = await fetch('https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ format: 'jsonv2', addressdetails: 1, extratags: 1, ...params }), NO_CREDS);
  return r.ok ? r.json() : [];
}
async function loadCandidates() {
  if (!state.adding) return;
  if (map.getZoom() < 12) { candLayer.clearLayers(); $('candStatus').textContent = 'Zoom in to see campsites from OpenStreetMap you can click.'; return; }
  const seq = ++candSeq, b = map.getBounds();
  const vb = [b.getWest(), b.getNorth(), b.getEast(), b.getSouth()].join(',');
  $('candStatus').textContent = 'Looking for campsites here…';
  const found = new Map();
  for (const q of ['[camp_site]', 'scout', 'guide']) {
    try { (await nominatim({ q, viewbox: vb, bounded: 1, limit: 40 })).forEach(p => found.set(p.osm_type + p.osm_id, p)); } catch {}
    if (seq !== candSeq) return;
    await new Promise(r => setTimeout(r, 1100));
  }
  if (seq !== candSeq || !state.adding) return;
  candLayer.clearLayers();
  let n = 0;
  found.forEach(p => {
    const lat = +p.lat, lng = +p.lon, name = p.name || p.display_name.split(',')[0];
    const listed = nearestListed(lat, lng);
    const m = L.circleMarker([lat, lng], { radius: 9, weight: 3, color: '#fff', fillColor: listed ? '#8a8197' : '#f59f00', fillOpacity: 1 })
      .bindTooltip(listed ? `${esc(name)} · already listed` : esc(name), { className: 'cand-label', direction: 'top', offset: [0, -8], permanent: map.getZoom() >= 14 })
      .on('click', ev => { L.DomEvent.stopPropagation(ev); const x = p.extratags || {}; pickPlace({ lat, lng, name, addr: shortAddr(p), osm: `${p.osm_type}/${p.osm_id}`, url: x.website || x['contact:website'], email: x.email || x['contact:email'], managedBy: x.operator, phone: x.phone || x['contact:phone'] }); });
    candLayer.addLayer(m); n++;
  });
  $('candStatus').innerHTML = n ? `<b>${n}</b> places from OpenStreetMap here. Orange = not listed yet, grey = already on the map. Not there? Search above or click the map.` :
    'No campsites mapped in OpenStreetMap here. Search for the place above, or click the map to drop a pin.';
}
function shortAddr(p) {
  const a = p.address || {};
  const parts = [a.road, a.village || a.hamlet || a.town || a.suburb || a.city, a.county || a.state, a.postcode].filter(Boolean);
  return parts.length ? parts.join(', ') : p.display_name;
}

// Place search (Photon: OSM-based, free, made for search-as-you-type)
let pq;
$('placeQ').addEventListener('input', e => {
  clearTimeout(pq); const q = e.target.value.trim();
  if (q.length < 3) { $('placeResults').innerHTML = ''; return; }
  pq = setTimeout(async () => {
    const c = map.getCenter();
    try {
      const j = await getJSON(`https://photon.komoot.io/api/?${new URLSearchParams({ q, lat: c.lat, lon: c.lng, limit: 7, lang: 'en' })}`);
      $('placeResults').innerHTML = j.features.map((f, i) => {
        const p = f.properties, sub = [p.street, p.city || p.town || p.village || p.district, p.county || p.state, p.country].filter(Boolean).join(', ');
        return `<button data-i="${i}">${esc(p.name || sub)}<small>${esc((p.osm_value || '').replace(/_/g, ' '))}${sub ? ' · ' + esc(sub) : ''}</small></button>`;
      }).join('') || '<div class="addbar-status">Nothing found. Try another name, or click the map.</div>';
      $('placeResults').onclick = ev => {
        const btn = ev.target.closest('button'); if (!btn) return;
        const f = j.features[btn.dataset.i], p = f.properties, [lng, lat] = f.geometry.coordinates;
        map.setView([lat, lng], 16);
        pickPlace({ lat, lng, name: p.name || '', addr: [p.street, p.city || p.town || p.village, p.county, p.postcode].filter(Boolean).join(', '), osm: `${p.osm_type}/${p.osm_id}` });
      };
    } catch { $('placeResults').innerHTML = '<div class="addbar-status">Search is unavailable right now.</div>'; }
  }, 300);
});

// Click anywhere: drop a pin and look up the real address there
map.on('click', async e => {
  if (!state.adding) return;
  const { lat, lng } = e.latlng;
  setTemp(lat, lng);
  $('candStatus').textContent = 'Finding the address here…';
  let addr = '', name = '';
  try {
    const p = await getJSON('https://nominatim.openstreetmap.org/reverse?' + new URLSearchParams({ format: 'jsonv2', lat, lon: lng, zoom: 17, addressdetails: 1 }));
    addr = shortAddr(p); name = p.name || '';
  } catch {}
  $('candStatus').textContent = '';
  pickPlace({ lat, lng, name, addr, dropped: true });
});

function setTemp(lat, lng) {
  if (tempMarker) map.removeLayer(tempMarker);
  tempMarker = L.marker([lat, lng], { icon: pinIcon({ pending: true }), zIndexOffset: 1000 }).addTo(map);
}

// ---------- the form ----------
$('siteForm').org.innerHTML = ORGS.map(o => `<option>${o}</option>`).join('');
$('formKinds').innerHTML = KINDS.slice(0, 5).map(k => `<button type="button" class="chip" data-v="${k}">${k}</button>`).join('');
$('formKinds').onclick = e => { const b = e.target.closest('.chip'); if (b) b.classList.toggle('on'); };

function pickPlace(p) {
  draft = p; setTemp(p.lat, p.lng);
  const f = $('siteForm'); f.reset();
  f.name.value = p.name || ''; f.url.value = p.url || ''; f.addr.value = p.addr || ''; f.email.value = p.email || '';
  f.managedBy.value = p.managedBy || ''; f.bookingNote.value = p.phone ? 'Phone ' + p.phone : '';
  f.org.value = /guid/i.test(p.name) ? 'Girlguiding' : 'Scouts';
  $('formKinds').querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.v === 'Camping'));
  const listed = nearestListed(p.lat, p.lng);
  $('locCard').innerHTML = `${icon('pin')}<div><b>${esc(p.addr || 'Location picked on the map')}</b>
    <small>${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}${p.osm ? ' · OpenStreetMap place' : p.dropped ? ' · dropped pin' : ''}</small>
    ${listed ? `<div style="margin-top:6px;color:#b4361b;font-weight:700">Already on the map nearby: ${esc(listed.s.name)} (${Math.round(listed.d * 1000)} m away)</div>` : ''}</div>`;
  $('formBack').hidden = false; $('siteForm').scrollTop = 0; loadTurnstile();
  // on a computer, put the cursor in the first box; on a phone don't, as the keyboard popping up straight away shoves the page about
  if (!matchMedia('(pointer: coarse)').matches) (p.name ? f.org : f.name).focus();
}
// phones: keep the box being typed in visible inside the card, and undo any page scroll the keyboard leaves behind
$('siteForm').addEventListener('focusin', e => {
  if (!matchMedia('(pointer: coarse)').matches || !e.target.matches('input, textarea, select')) return;
  setTimeout(() => e.target.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 300);
});
document.addEventListener('focusout', () => setTimeout(() => { if (window.scrollY || window.scrollX) window.scrollTo(0, 0); }, 120));
$('formBack').addEventListener('click', e => { if (e.target === $('formBack') || e.target.closest('[data-close]')) $('formBack').hidden = true; });

// "I'm human" check (Cloudflare Turnstile): only loaded when the form opens, sets no cookies
let tsWidget = null;
function loadTurnstile() {
  if (!CONFIG.turnstileSiteKey || !LIVE) return;
  const draw = () => { if (tsWidget === null) tsWidget = turnstile.render('#humanCheck', { sitekey: CONFIG.turnstileSiteKey, appearance: 'interaction-only',
    'error-callback': code => { toast(`The “I’m human” check didn't work (code ${code}). Try reloading the page, or another browser.`, false); return true; } }); else turnstile.reset(tsWidget); };
  if (window.turnstile) return draw();
  const sc = document.createElement('script');
  sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; sc.async = true; sc.onload = draw;
  document.head.appendChild(sc);
}

$('siteForm').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, kinds = [...$('formKinds').querySelectorAll('.chip.on')].map(c => c.dataset.v);
  const s = {
    name: f.name.value.trim(), org: f.org.value, kinds: kinds.length ? kinds : ['Camping'],
    note: f.note.value.trim(), url: f.url.value.trim(), by: f.by.value.trim(), addr: f.addr.value.trim(), osm: draft.osm || '',
    managedBy: f.managedBy.value.trim(), email: f.email.value.trim(), bookingNote: f.bookingNote.value.trim(),
    lat: +draft.lat.toFixed(6), lng: +draft.lng.toFixed(6),
  };
  const btn = f.querySelector('.btn-primary'); busy(btn, true);
  let sent = false;
  if (LIVE) {
    try {
      const token = window.turnstile && tsWidget !== null ? turnstile.getResponse(tsWidget) : '';
      const r = await fetch('/api/submit', { ...NO_CREDS, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...s, token }) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) { busy(btn, false); if (window.turnstile && tsWidget !== null) turnstile.reset(tsWidget); return toast(out.error || 'Could not send it. Please try again.', false); }
      sent = true;
    } catch { busy(btn, false); return toast('Could not send it. Check your connection and try again.', false); }
  }
  busy(btn, false);
  let near = null; for (const x of SITES) { const d = haversine(s, x); if (!near || d < near.d) near = { s: x, d }; }
  Object.assign(s, { id: 'p' + Date.now(), pending: true, booking: s.url, country: near && near.d < 60 ? near.s.country : 'Unknown', region: near && near.d < 60 ? near.s.region : 'Other' });
  pending.push(s);
  makeMarker(s); $('formBack').hidden = true; stopAdding(); update(false);
  select(s.id, true);
  toast(sent ? 'Thanks! It will appear for everyone once it has been checked.' : 'Preview only: nothing was sent (the Cloudflare part is not running here).');
};

function toast(msg, ok = true) {
  const t = $('toast'); t.innerHTML = (ok ? icon('check') : '') + esc(msg); t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => t.hidden = true, 4000);
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!$('formBack').hidden) $('formBack').hidden = true; else if (state.adding) stopAdding(); } });

const fromLink = loadHash();
buildFilters(); render(false);
$('loading').classList.add('done'); setTimeout(() => $('loading').remove(), 400);
const view = new URLSearchParams(location.search).get('view')?.split(',').map(Number);
if (view && view.length === 3 && view.every(isFinite)) { map.setView([view[0], view[1]], view[2]); history.replaceState(null, '', location.pathname + location.hash); }
else if (fromLink) render(true);
else map.fitBounds(L.latLngBounds(SITES.filter(s => s.region === 'UK').map(s => [s.lat, s.lng])), panelPad());

// "3D version": open the globe at the same place with the same filters (only if the visitor chooses it)
$('to3d').onclick = e => {
  e.preventDefault();
  const c = map.getCenter();
  location.href = `globe?view=${c.lat.toFixed(4)},${c.lng.toFixed(4)},${map.getZoom()}${location.hash}`;
};
