/**
 * Scout Campsite Finder: the sites sheet.
 * Paste this into Extensions → Apps Script on the Google Sheet. See SETUP.md.
 *
 * Every site on the map is a row here. Status decides what shows:
 *   Approved  shown on the map
 *   Pending   waiting for you (new suggestions from the website, and new places found in the Google Maps list)
 *   Rejected  hidden, and stays hidden (use this rather than deleting a row, so a place still in the
 *             Google Maps list isn't suggested again)
 * Changes show on the website within 10 minutes (usually under a minute).
 *
 * Script properties (Project Settings → Script properties):
 *   SECRET       a long random password, the same as APPS_SCRIPT_SECRET in Cloudflare
 *   REFRESH_URL  https://<your-site>/api/refresh?key=<REFRESH_SECRET>
 *   NOTIFY       (optional) an email address to tell when something new arrives
 */
const SHEET = 'Submissions';
// new columns only ever go on the end, so existing rows stay lined up
const COLS = ['ID', 'Submitted', 'Status', 'Name', 'Run by', 'Types', 'Notes', 'Website', 'Latitude', 'Longitude', 'Address', 'OSM place', 'Sent by',
  'Check on Google Maps', 'Managed by', 'Contact email', 'How to book', 'Source ID', 'Association'];
const STATUS_COL = COLS.indexOf('Status') + 1;

/** Run from the editor (choose "setup", press Run) after pasting a new version of this script. */
function setup() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEET) || ss.insertSheet(SHEET);
  sh.getRange(1, 1, 1, COLS.length).setValues([COLS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  const rule = SpreadsheetApp.newDataValidation().requireValueInList(['Pending', 'Approved', 'Rejected'], true).build();
  sh.getRange(2, STATUS_COL, sh.getMaxRows() - 1, 1).setDataValidation(rule);
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onStatusChange').forSpreadsheet(ss).onEdit().create();
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function secretOk(s) {
  const want = PropertiesService.getScriptProperties().getProperty('SECRET');
  return want && s === want;
}
// a leading ' stops anything typed on the website being treated as a formula
const safe = v => (typeof v === 'string' && /^[=+\-@]/.test(v)) ? "'" + v : (v == null ? '' : v);
const plain = v => String(v == null ? '' : v).replace(/^'/, '');

function toRow(s, status) {
  const byName = {
    'ID': Utilities.getUuid().slice(0, 8), 'Submitted': new Date(), 'Status': status, 'Name': safe(s.name), 'Run by': s.org || '',
    'Types': (s.kinds || []).join(', '), 'Notes': safe(s.note), 'Website': safe(s.url), 'Latitude': s.lat, 'Longitude': s.lng,
    'Address': safe(s.addr), 'OSM place': s.osm || '', 'Sent by': safe(s.by),
    'Check on Google Maps': 'https://www.google.com/maps/search/?api=1&query=' + s.lat + ',' + s.lng,
    'Managed by': safe(s.managedBy), 'Contact email': safe(s.email), 'How to book': safe(s.bookingNote),
    'Source ID': s.sourceId || '', 'Association': safe(s.assoc),
  };
  return COLS.map(c => byName[c]);
}

/** The website sends new suggestions here, and places to import. */
function doPost(e) {
  let d;
  try { d = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'bad json' }); }
  if (!secretOk(d.secret)) return out({ ok: false, error: 'not allowed' });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName(SHEET);

    if (d.action === 'submit' && d.site) {
      sh.appendRow(toRow(d.site, 'Pending'));
      const to = PropertiesService.getScriptProperties().getProperty('NOTIFY');
      if (to) MailApp.sendEmail(to, 'New campsite to review: ' + d.site.name, 'Someone suggested "' + d.site.name + '".\n\nReview it here: ' + SpreadsheetApp.getActive().getUrl());
      return out({ ok: true });
    }

    // many places at once (the first import, and new places found in the Google Maps list); skips any already here
    if (d.action === 'import' && Array.isArray(d.sites)) {
      const status = d.status === 'Approved' ? 'Approved' : 'Pending';
      const idCol = COLS.indexOf('Source ID');
      const last = sh.getLastRow();
      const have = new Set(last > 1 ? sh.getRange(2, idCol + 1, last - 1, 1).getValues().map(r => String(r[0])).filter(Boolean) : []);
      const rows = d.sites.filter(s => s && s.name && isFinite(s.lat) && isFinite(s.lng) && !(s.sourceId && have.has(String(s.sourceId))))
        .map(s => toRow(s, status));
      if (rows.length) sh.getRange(last + 1, 1, rows.length, COLS.length).setValues(rows);
      if (rows.length && status === 'Pending') {
        const to = PropertiesService.getScriptProperties().getProperty('NOTIFY');
        if (to) MailApp.sendEmail(to, rows.length + ' new place(s) from the Google Maps list to review', 'Review them here: ' + SpreadsheetApp.getActive().getUrl());
      }
      return out({ ok: true, added: rows.length, skipped: d.sites.length - rows.length });
    }

    return out({ ok: false, error: 'bad action' });
  } finally { lock.releaseLock(); }
}

/** The website reads the sites from here. */
function doGet(e) {
  if (!secretOk(e.parameter.secret)) return out({ ok: false, error: 'not allowed' });
  if (e.parameter.action !== 'approved') return out({ ok: false, error: 'bad action' });
  const rows = SpreadsheetApp.getActive().getSheetByName(SHEET).getDataRange().getValues();
  const head = rows.shift(), c = n => head.indexOf(n), get = (r, n) => c(n) < 0 ? '' : plain(r[c(n)]);
  const sites = rows.filter(r => r[c('Status')] === 'Approved').map(r => ({
    id: r[c('ID')], name: get(r, 'Name'), org: get(r, 'Run by'), kinds: get(r, 'Types'), note: get(r, 'Notes'), url: get(r, 'Website'),
    lat: r[c('Latitude')], lng: r[c('Longitude')], addr: get(r, 'Address'), managedBy: get(r, 'Managed by'), email: get(r, 'Contact email'),
    bookingNote: get(r, 'How to book'), sourceId: get(r, 'Source ID'), assoc: get(r, 'Association'),
  }));
  // every Source ID in the sheet, whatever its status, so the website knows which Google Maps places it has already seen
  const known = c('Source ID') < 0 ? [] : rows.map(r => plain(r[c('Source ID')])).filter(Boolean);
  return out({ ok: true, version: 2, sites: sites, known: known });
}

/** When a Status changes, tell the website to rebuild its list. */
function onStatusChange(e) {
  if (!e || e.range.getSheet().getName() !== SHEET || e.range.getColumn() > STATUS_COL || e.range.getLastColumn() < STATUS_COL) return;
  const url = PropertiesService.getScriptProperties().getProperty('REFRESH_URL');
  if (url) UrlFetchApp.fetch(url, { method: 'post', muteHttpExceptions: true });
}
