// Country of a visitor from their IP address, for the visitor statistics.
// Data: DB-IP "IP to Country Lite" (CC BY 4.0, https://db-ip.com), republished monthly as numeric CSV
// by the @ip-location-db project. Downloaded at start-up if missing or older than 30 days, kept in DATA_DIR/geo.
// The IP is only looked up, never stored. Without the data, countries show as "Unknown".
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const SOURCES = [
  'https://cdn.jsdelivr.net/npm/@ip-location-db/dbip-country/',
  'https://unpkg.com/@ip-location-db/dbip-country/',
];
const FILES = { v4: 'dbip-country-ipv4-num.csv', v6: 'dbip-country-ipv6-num.csv' };
const MAX_AGE = 30 * 24 * 3600 * 1000;

let dir = null;
let v4 = null; // { start: Uint32Array, end: Uint32Array, cc: Uint16Array }
let v6 = null; // same with BigUint64Array (first 64 bits of the address)
const codes = [];
const codeIndex = new Map();
const cIdx = (c) => { if (!codeIndex.has(c)) { codeIndex.set(c, codes.length); codes.push(c); } return codeIndex.get(c); };

function parse(text, six) {
  const lines = text.split('\n').filter(Boolean);
  const n = lines.length;
  const start = six ? new BigUint64Array(n) : new Uint32Array(n);
  const end = six ? new BigUint64Array(n) : new Uint32Array(n);
  const cc = new Uint16Array(n);
  let k = 0;
  for (const line of lines) {
    const [a, b, c] = line.split(',');
    if (!c) continue;
    if (six) { start[k] = BigInt(a) >> 64n; end[k] = BigInt(b) >> 64n; }
    else { start[k] = Number(a); end[k] = Number(b); }
    cc[k++] = cIdx(c.trim().toUpperCase());
  }
  return { start: start.subarray(0, k), end: end.subarray(0, k), cc: cc.subarray(0, k) };
}

async function download(file) {
  for (const base of SOURCES) {
    try {
      const r = await fetch(base + file, { signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      if (text.length < 100000) throw new Error('file too small');
      await fs.writeFile(path.join(dir, file + '.tmp'), text);
      await fs.rename(path.join(dir, file + '.tmp'), path.join(dir, file));
      return true;
    } catch (e) { console.warn(`[geo] ${base}${file}: ${e.message}`); }
  }
  return false;
}

async function load() {
  for (const [k, file] of Object.entries(FILES)) {
    const f = path.join(dir, file);
    if (!fss.existsSync(f)) continue;
    const table = parse(await fs.readFile(f, 'utf8'), k === 'v6');
    if (k === 'v4') v4 = table; else v6 = table;
  }
  if (v4) console.log(`[geo] country data loaded (${v4.start.length + (v6?.start.length || 0)} ranges) · IP Geolocation by DB-IP`);
}

/** Load the country data, and fetch a fresh copy when it is missing or a month old. Never throws. */
export async function startGeo(dataDir) {
  dir = path.join(dataDir, 'geo');
  try {
    await fs.mkdir(dir, { recursive: true });
    await load();
    const refresh = async () => {
      const f = path.join(dir, FILES.v4);
      const age = fss.existsSync(f) ? Date.now() - (await fs.stat(f)).mtimeMs : Infinity;
      if (age < MAX_AGE) return;
      console.log('[geo] downloading country data…');
      const ok = (await download(FILES.v4)) && (await download(FILES.v6));
      if (ok) await load();
    };
    refresh().catch((e) => console.warn('[geo]', e.message));
    setInterval(() => refresh().catch(() => {}), 24 * 3600 * 1000).unref();
  } catch (e) { console.warn('[geo] not available:', e.message); }
}

function find(t, x) {
  let lo = 0, hi = t.start.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t.start[mid] > x) hi = mid - 1;
    else if (t.end[mid] < x) lo = mid + 1;
    else return codes[t.cc[mid]];
  }
  return null;
}

/** Two-letter country code (e.g. "GB") for an IP address, or null. */
export function countryOf(ip) {
  ip = String(ip || '').replace(/^::ffff:/, '');
  if (net.isIPv4(ip)) {
    if (!v4) return null;
    const p = ip.split('.').map(Number);
    return find(v4, ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]);
  }
  if (net.isIPv6(ip)) {
    if (!v6) return null;
    // expand to 8 groups and keep the first 64 bits
    const [head, tail = ''] = ip.split('::');
    const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
    const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
    let x = 0n;
    for (let i = 0; i < 4; i++) x = (x << 16n) + BigInt(parseInt(groups[i] || '0', 16));
    return find(v6, x);
  }
  return null;
}
