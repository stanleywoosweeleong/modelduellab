/* Daily server-side forecast capture — run by .github/workflows/capture.yml.

   A forecast that is not captured on the day is gone for good, and until now
   capturing depended on someone opening the app. This script captures, for
   every seed farm in index.html:
     - all challenger models (Open-Meteo), 7 days ahead, daily + time-of-day mm
     - MET Malaysia's forecast for the farm's nearest MET town (via the Worker)
     - ERA5 actuals for the days that have just matured
   and writes data/captures/<date>.json. The app merges these files into each
   phone's own log (see syncServerCaptures in index.html), filing every forecast
   under its lead time and never overwriting what the phone captured itself.

   Farms a user added on their own phone are not in index.html, so they are not
   covered — those still need logging in the app.

   No dependencies; Node 20+.   Usage: node scripts/capture.mjs */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* The app is a single file; read its constants rather than keep a second copy. */
function constFromApp(name) {
  const m = html.match(new RegExp('const ' + name + '\\s*=\\s*(\\[[\\s\\S]*?\\n\\]);'));
  if (!m) throw new Error('cannot find ' + name + ' in index.html');
  return new Function('return ' + m[1])();
}
const SEED_FARMS = constFromApp('SEED_FARMS');
const MET_TOWNS = constFromApp('MET_TOWNS');
const MODELS = constFromApp('CHALLENGERS').map((c) => c.key);
const PROXY = (process.env.MET_PROXY || html.match(/const DEFAULT_MET_PROXY\s*=\s*'([^']+)'/)[1]).replace(/\/+$/, '');
const ERA5_LAG_DAYS = 5, ERA5_SPAN = 8;      // refresh the 8 most recently matured days
const TZ = 'Asia%2FKuala_Lumpur';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const klDate = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
const addDays = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const TODAY = klDate(new Date());
const keyOf = (lat, lon) => (+lat).toFixed(4) + ',' + (+lon).toFixed(4);
const r2 = (x) => Math.round(x * 100) / 100;

async function getJSON(url, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (r.ok) return await r.json();
      last = new Error('HTTP ' + r.status);
    } catch (e) { last = e; }
    await sleep(3000 * (i + 1));
  }
  throw last;
}

function haversine(la1, lo1, la2, lo2) {
  const R = 6371, d = (x) => x * Math.PI / 180;
  const a = Math.sin(d(la2 - la1) / 2) ** 2 + Math.cos(d(la1)) * Math.cos(d(la2)) * Math.sin(d(lo2 - lo1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function nearestTown(lat, lon) {
  let best = null, bd = 1e9;
  for (const t of MET_TOWNS) { const dd = haversine(lat, lon, t.lat, t.lon); if (dd < bd) { bd = dd; best = t; } }
  return best.town;
}
/* [total, morning 06-12, afternoon 12-18, night 18-24] in mm for one date */
function dayRow(total, times, hourly, date) {
  const p = [0, 0, 0], seen = [false, false, false];
  if (hourly) times.forEach((t, i) => {
    if (!t.startsWith(date) || hourly[i] == null) return;
    const h = +t.slice(11, 13), k = h >= 6 && h < 12 ? 0 : h >= 12 && h < 18 ? 1 : h >= 18 ? 2 : -1;
    if (k >= 0) { p[k] += hourly[i]; seen[k] = true; }
  });
  return [total, ...p.map((v, k) => (seen[k] ? r2(v) : null))];
}

// ---- farms: one entry per distinct coordinate ----
const farms = new Map();
for (const [, lat, lon] of SEED_FARMS) {
  const k = keyOf(lat, lon);
  if (!farms.has(k)) farms.set(k, { lat: +lat, lon: +lon, tableTown: nearestTown(+lat, +lon), fc: {}, act: {} });
}
const list = [...farms.values()];
console.log(`${list.length} farm coordinates · ${MODELS.length} models · capture date ${TODAY}`);

const file = path.join(ROOT, 'data', 'captures', TODAY + '.json');
const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;   // a later run only fills gaps
const out = { v: 1, date: TODAY, captured: new Date().toISOString(), models: MODELS, farms: {}, met: (prev && prev.met) || {} };
const warn = [];

// ---- 1. challenger models, 20 farms per call ----
const CHUNK = 20;
for (let i = 0; i < list.length; i += CHUNK) {
  const part = list.slice(i, i + CHUNK);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${part.map((f) => f.lat).join(',')}&longitude=${part.map((f) => f.lon).join(',')}` +
    `&daily=precipitation_sum&hourly=precipitation&forecast_days=7&models=${MODELS.join(',')}&timezone=${TZ}`;
  try {
    let j = await getJSON(url); if (!Array.isArray(j)) j = [j];
    j.forEach((loc, n) => {
      for (const m of MODELS) {
        const dp = loc.daily && loc.daily['precipitation_sum_' + m], hp = loc.hourly && loc.hourly['precipitation_' + m];
        if (!dp) continue;
        loc.daily.time.forEach((d, di) => {
          if (dp[di] == null) return;
          (part[n].fc[m] = part[n].fc[m] || {})[d] = dayRow(dp[di], loc.hourly.time, hp, d);
        });
      }
    });
  } catch (e) { warn.push(`models, farms ${i}-${i + part.length - 1}: ${e.message}`); }
  await sleep(1500);
}

// ---- 2. ERA5 actuals for the days that have matured ----
const eraTo = addDays(TODAY, -ERA5_LAG_DAYS), eraFrom = addDays(eraTo, -(ERA5_SPAN - 1));
for (let i = 0; i < list.length; i += CHUNK) {
  const part = list.slice(i, i + CHUNK);
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${part.map((f) => f.lat).join(',')}&longitude=${part.map((f) => f.lon).join(',')}` +
    `&start_date=${eraFrom}&end_date=${eraTo}&daily=precipitation_sum&hourly=precipitation&timezone=${TZ}`;
  try {
    let j = await getJSON(url); if (!Array.isArray(j)) j = [j];
    j.forEach((loc, n) => {
      loc.daily.time.forEach((d, di) => {
        const mm = loc.daily.precipitation_sum[di];
        if (mm != null) part[n].act[d] = dayRow(mm, loc.hourly.time, loc.hourly.precipitation, d);
      });
    });
  } catch (e) { warn.push(`ERA5, farms ${i}-${i + part.length - 1}: ${e.message}`); }
  await sleep(1500);
}

// ---- 3. MET Malaysia, once per nearest town (the Worker and data.gov.my rate-limit hard) ----
// Group farms by their nearest town in the WORKER's own town list (it knows far
// more towns than the app's built-in table), then ask once per group.
let workerTowns = [];
try { workerTowns = ((await getJSON(`${PROXY}/towns`)).locations || []).filter((t) => t.lat != null && t.lon != null); }
catch (e) { warn.push('MET town list: ' + e.message); }
const groupOf = (f) => {
  let best = null, bd = 1e9;
  for (const t of workerTowns) { const dd = haversine(f.lat, f.lon, t.lat, t.lon); if (dd < bd) { bd = dd; best = t.name; } }
  return best || f.tableTown;
};
const groups = new Map();
for (const f of list) { const g = groupOf(f); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(f); }
for (const [g, members] of groups) {
  const f = members[0];
  try {
    const j = await getJSON(`${PROXY}/forecast?lat=${f.lat}&lon=${f.lon}`);
    const days = j.days || [];
    // freshness gate (same rule as the app): a frozen feed must not be filed as today's forecast
    if (!j.town || !days.length || !(j.newest_date >= TODAY)) throw new Error('stale or empty feed (newest ' + j.newest_date + ')');
    for (const m of members) m.town = j.town;
    if (!out.met[j.town]) {
      const rows = {};
      for (const d of days) if (d.rain != null && d.date >= TODAY) rows[d.date] = [d.rain, d.morning ?? null, d.afternoon ?? null, d.night ?? null];
      out.met[j.town] = rows;
    }
  } catch (e) { warn.push(`MET ${g}: ${e.message}`); }
  await sleep(2500);
}

// ---- write ----
let nFc = 0, nAct = 0;
for (const [k, f] of farms) {
  const old = (prev && prev.farms && prev.farms[k]) || {};
  const fc = Object.assign({}, f.fc); for (const m in old.fc || {}) fc[m] = Object.assign({}, f.fc[m], old.fc[m]);   // first capture of the day wins
  const act = Object.assign({}, old.act, f.act);                                                                    // newest ERA5 wins
  const town = old.town || f.town || null;
  out.farms[k] = { town, fc, act };
  if (Object.keys(fc).length) nFc++; if (Object.keys(act).length) nAct++;
}
const nMet = Object.keys(out.met).length;
console.log(`models: ${nFc}/${list.length} farms · ERA5: ${nAct}/${list.length} farms · MET towns: ${nMet}`);
for (const w of warn) console.warn('WARN', w);
if (!nFc && !nMet) { console.error('Nothing captured — not writing a file.'); process.exit(1); }

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out));
const dates = fs.readdirSync(path.dirname(file)).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).map((n) => n.slice(0, 10)).sort();
fs.writeFileSync(path.join(ROOT, 'data', 'index.json'), JSON.stringify({ v: 1, updated: out.captured, dates }));
console.log(`wrote ${path.relative(ROOT, file)} (${(fs.statSync(file).size / 1024).toFixed(0)} KB) · ${dates.length} capture day(s) on file`);
