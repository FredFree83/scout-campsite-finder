// Scout Campsite Finder: the optional 3D globe view (MapLibre).
// Zoomed out it's a globe (true sizes); zooming in it flattens into a normal map.
// Same data, colours, popups and filters as the 2D map. Adding sites stays on the 2D map.
// No cookies or browser storage; the filters travel in the page address (#…) between 2D and 3D.

const ORG_COLOURS = {
  'Scouts': '#7413dc', 'Scouts & Guides': '#4b3fd1', 'Girlguiding': '#1673c4',
  'Scout Adventures': '#d9480f', 'Overseas scouting': '#0e8a7e', 'Other / unknown': '#6b6577',
};
const ORGS = Object.keys(ORG_COLOURS);
const REGIONS = ['UK', 'Ireland & islands', 'Europe', 'Australia & NZ', 'Africa', 'North America', 'South America', 'Asia', 'Other'];
const KINDS = ['Camping', 'Indoor', 'Activity centre', 'Scout hut / HQ', 'Water / waterside', 'Restricted / check first'];
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = id => `<svg><use href="#i-${id}"/></svg>`;
const KIND_ICON = { 'Camping': 'tent', 'Indoor': 'house', 'Activity centre': 'compass', 'Scout hut / HQ': 'flag', 'Water / waterside': 'wave' };
const kindIcon = s => KIND_ICON[(s.kinds || []).find(k => KIND_ICON[k])] || 'tent';

// ---------- data ----------
const getJSON = async (u, o = {}) => { const r = await fetch(u, { credentials: 'omit', ...o }); if (!r.ok) throw new Error(r.status); return r.json(); };
let SITES = [];
try { SITES = await getJSON('/api/sites', { cache: 'no-cache' }); }
catch { try { SITES = await getJSON('sites.json'); } catch { $('loading').textContent = 'Could not load the sites. Please reload the page.'; throw new Error('no sites'); } }
const byId = new Map(SITES.map(s => [String(s.id), s]));

// filters from the address, shared with the 2D map
const state = { q: '', region: new Set(), org: new Set(), kind: new Set(), country: '' };
{
  const p = new URLSearchParams(location.hash.slice(1));
  state.q = p.get('q') || ''; $('q').value = state.q; state.country = p.get('country') || '';
  for (const k of ['region', 'org', 'kind']) (p.get(k) || '').split('|').filter(Boolean).forEach(v => state[k].add(v));
}
const filterHash = () => {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  for (const k of ['region', 'org', 'kind']) if (state[k].size) p.set(k, [...state[k]].join('|'));
  if (state.country) p.set('country', state.country);
  return p.toString();
};

// ---------- map ----------
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const map = new maplibregl.Map({
  container: 'map',
  center: [-3.2, 54.3], zoom: 1.6,
  maxPitch: 60, minZoom: 1,
  attributionControl: { compact: true },
  style: {
    version: 8,
    projection: { type: 'globe' },
    glyphs: location.origin + '/fonts/{fontstack}/{range}.pbf',
    sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0] },
    sources: {
      sat: { type: 'raster', tiles: [`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
      satLabels: { type: 'raster', tiles: [`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: 19 },
      osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19, attribution: '© OpenStreetMap contributors' },
      topo: { type: 'raster', tiles: ['a', 'b', 'c'].map(s => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`), tileSize: 256, maxzoom: 17, attribution: '© OpenStreetMap, SRTM | © OpenTopoMap' },
    },
    layers: [
      { id: 'sat', type: 'raster', source: 'sat' },
      { id: 'satLabels', type: 'raster', source: 'satLabels' },
      { id: 'osm', type: 'raster', source: 'osm', layout: { visibility: 'none' } },
      { id: 'topo', type: 'raster', source: 'topo', layout: { visibility: 'none' } },
    ],
  },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
// keep the globe (and anything we fly to) centred in the space beside the side panel, not behind it
const sidePad = () => window.innerWidth > 700 ? { left: 392, top: 70, right: 0, bottom: 0 } : { left: 0, top: 120, right: 0, bottom: 52 };
map.setPadding(sidePad());
window.addEventListener('resize', () => map.setPadding(sidePad()));

const LAYERS = { sat: ['sat', 'satLabels'], osm: ['osm'], topo: ['topo'] };
$('layers').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  for (const [k, ids] of Object.entries(LAYERS)) ids.forEach(id => map.setLayoutProperty(id, 'visibility', k === b.dataset.l ? 'visible' : 'none'));
  document.querySelectorAll('#layers button').forEach(x => x.classList.toggle('active', x === b));
});

// ---------- sites on the globe: grouped when zoomed out, coloured by who runs them ----------
const toGeo = list => ({ type: 'FeatureCollection', features: list.map(s => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { id: String(s.id), colour: ORG_COLOURS[s.org] || '#6b6577' } })) });

map.once('style.load', () => {
  map.addSource('sites', { type: 'geojson', data: toGeo([]), cluster: true, clusterRadius: 45, clusterMaxZoom: 12 });
  map.addLayer({ id: 'clusters', type: 'circle', source: 'sites', filter: ['has', 'point_count'],
    paint: { 'circle-color': '#7413dc', 'circle-radius': ['step', ['get', 'point_count'], 15, 10, 18, 50, 22, 200, 27], 'circle-stroke-width': 2.5, 'circle-stroke-color': '#fff' } });
  map.addLayer({ id: 'cluster-count', type: 'symbol', source: 'sites', filter: ['has', 'point_count'],
    layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Bold'], 'text-size': 12.5, 'text-allow-overlap': true },
    paint: { 'text-color': '#fff' } });
  map.addLayer({ id: 'site', type: 'circle', source: 'sites', filter: ['!', ['has', 'point_count']],
    paint: { 'circle-color': ['get', 'colour'], 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 6, 12, 10], 'circle-stroke-width': 2.5, 'circle-stroke-color': '#fff' } });

  map.on('click', 'clusters', async e => {
    const f = e.features[0];
    const z = await map.getSource('sites').getClusterExpansionZoom(f.properties.cluster_id);
    map.easeTo({ center: f.geometry.coordinates, zoom: z + 0.3 });
  });
  map.on('click', 'site', e => openSite(byId.get(e.features[0].properties.id), false));
  for (const l of ['clusters', 'site']) {
    map.on('mouseenter', l, () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', l, () => map.getCanvas().style.cursor = '');
  }

  // arrive from the 2D map at the same place, or start on a slowly settling globe over the UK
  const v = new URLSearchParams(location.search).get('view')?.split(',').map(Number);
  if (v && v.length === 3 && v.every(isFinite)) map.jumpTo({ center: [v[1], v[0]], zoom: Math.max(0, v[2] - 1) });
  else map.easeTo({ zoom: 3.2, duration: 2500 });

  buildFilters(); render();
  $('loading').classList.add('done'); setTimeout(() => $('loading').remove(), 400);
});

// ---------- popup (same content as the 2D map) ----------
let popup = null;
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
      <span class="badge" style="background:${ORG_COLOURS[s.org]};color:#fff">${esc(s.org)}</span>
      ${s.kinds.map(k => `<span class="badge">${esc(k)}</span>`).join('')}
      ${s.country ? `<span class="badge">${esc(s.country)}</span>` : ''}
    </div>
    ${s.note ? `<p>${esc(s.note)}</p>` : ''}
    ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` : ''}
    ${s.addr ? `<p class="sub">${esc(s.addr)}</p>` : ''}
    <div class="actions">
      <a class="btn btn-primary" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}">${icon('route')}Directions</a>
      ${site ? `<a class="btn" target="_blank" rel="noopener" href="${esc(site)}">${icon('ext')}Book</a>`
             : `<a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}">${icon('ext')}Google Maps</a>`}
    </div></div>`;
}
function openSite(s, fly) {
  if (!s) return;
  document.querySelectorAll('.item').forEach(el => el.classList.toggle('active', el.dataset.id === String(s.id)));
  if (popup) popup.remove();
  popup = new maplibregl.Popup({ maxWidth: '330px', offset: 12 }).setLngLat([s.lng, s.lat]).setHTML(popupHtml(s)).addTo(map);
  if (fly) map.flyTo({ center: [s.lng, s.lat], zoom: Math.max(map.getZoom(), 14), speed: 1.4 });
  if (window.innerWidth <= 700) togglePanel(false);
}

// ---------- filters and list ----------
function matches(s) {
  if (state.region.size && !state.region.has(s.region)) return false;
  if (state.country && s.country !== state.country) return false;
  if (state.org.size && !state.org.has(s.org)) return false;
  if (state.kind.size && !s.kinds.some(k => state.kind.has(k))) return false;
  if (state.q) {
    const hay = [s.name, s.pin, s.note, s.addr, s.country, s.region, s.org, s.kinds.join(' '), s.managedBy, s.assoc].join(' ').toLowerCase();
    if (!state.q.split(/\s+/).every(w => hay.includes(w))) return false;
  }
  return true;
}
const GROUPS = { region: ['fRegion', 'region', REGIONS, null], org: ['fOrg', 'org', ORGS, ORG_COLOURS], kind: ['fKind', 'kinds', KINDS, null] };
function buildFilters() {
  for (const [name, [el, key, values, colours]] of Object.entries(GROUPS)) {
    const c = {}; SITES.forEach(s => [].concat(s[key]).forEach(v => c[v] = (c[v] || 0) + 1));
    $(el).innerHTML = values.filter(v => c[v]).map(v =>
      `<button class="chip${state[name].has(v) ? ' on' : ''}" data-v="${esc(v)}">${colours ? `<span class="dot" style="background:${colours[v]}"></span>` : ''}${esc(v)} <span class="n">${c[v]}</span></button>`).join('');
  }
  const n = state.region.size + state.org.size + state.kind.size + (state.country ? 1 : 0);
  $('fCount').hidden = !n; $('fCount').textContent = n;
}
for (const [name, [el]] of Object.entries(GROUPS)) {
  $(el).addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    const set = state[name], v = b.dataset.v; set.has(v) ? set.delete(v) : set.add(v);
    buildFilters(); render(true);
  });
}
let qt; $('q').addEventListener('input', e => { clearTimeout(qt); qt = setTimeout(() => { state.q = e.target.value.trim().toLowerCase(); render(true); }, 150); });
$('filterToggle').onclick = () => { const closed = $('filters').classList.toggle('closed'); $('filterToggle').setAttribute('aria-expanded', !closed); };
if (window.innerWidth <= 700) { $('filters').classList.add('closed'); $('filterToggle').setAttribute('aria-expanded', 'false'); }

let visible = [];
function render(fit) {
  visible = SITES.filter(matches).sort((a, b) => a.name.localeCompare(b.name));
  map.getSource('sites')?.setData(toGeo(visible));
  $('list').innerHTML = visible.length ? visible.slice(0, 300).map(s => `
    <div class="item" data-id="${esc(s.id)}">
      <span class="sw" style="background:${ORG_COLOURS[s.org]}">${icon(kindIcon(s))}</span>
      <div><h3>${esc(s.name)}</h3><div class="meta">${esc(s.country)} · ${esc(s.org)} · ${esc(s.kinds.join(', '))}</div></div>
    </div>`).join('') + (visible.length > 300 ? `<div class="empty">Showing 300 of ${visible.length}. Search or filter to narrow it down.</div>` : '')
    : '<div class="empty">No sites match.</div>';
  $('headCount').textContent = visible.length === SITES.length ? `${SITES.length} sites · 3D globe` : `${visible.length} of ${SITES.length} sites · 3D globe`;
  if (!$('panel').classList.contains('open')) $('mToggle').textContent = `Show list (${visible.length})`;
  const h = filterHash(); history.replaceState(null, '', location.pathname + location.search + (h ? '#' + h : ''));
  if (fit && visible.length) {
    const b = new maplibregl.LngLatBounds(); visible.forEach(s => b.extend([s.lng, s.lat]));
    map.fitBounds(b, { padding: 40, maxZoom: 12, duration: 900 });
  }
}
$('list').addEventListener('click', e => { const it = e.target.closest('.item'); if (it) openSite(byId.get(it.dataset.id), true); });

function togglePanel(open) { $('panel').classList.toggle('open', open); $('mToggle').setAttribute('aria-expanded', open); $('mToggle').textContent = open ? 'Hide list' : `Show list (${visible.length})`; }
$('mToggle').onclick = () => togglePanel(!$('panel').classList.contains('open'));

// back to the 2D map at the same place, with the same filters
function link2d(e) {
  e.preventDefault();
  const c = map.getCenter(), z = Math.min(18, Math.max(2, Math.round(map.getZoom() + 1)));
  const h = filterHash();
  location.href = `./?view=${c.lat.toFixed(4)},${c.lng.toFixed(4)},${z}${h ? '#' + h : ''}`;
}
$('to2d').onclick = link2d;
$('addLink').onclick = link2d;
