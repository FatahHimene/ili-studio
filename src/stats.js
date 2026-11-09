// Visitor statistics of published sites. No cookies, no script in the pages, nothing personal kept:
// the server counts the pages it sends. A visitor is recognised for one day only, by a hash of
// (secret of the day + site + IP + browser); the secret changes every day and is never written down,
// so yesterday's visitors cannot be traced. Only totals are stored:
//   DATA_DIR/stats/<siteId>/<YYYY-MM-DD>.json  { views, visitors, pages, sources, countries, devices }
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { countryOf } from './geo.js';

const KEEP_DAYS = 800; // a little over 2 years; plans show less (see plans.js statsDays)
const BOT = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|curl|wget|python|httpclient|okhttp|go-http|java\/|headless|lighthouse|pingdom|uptime|monitor|scan|check|validator|feed|fetch/i;
const today = () => new Date().toISOString().slice(0, 10);
const blank = () => ({ views: 0, visitors: 0, pages: {}, sources: {}, countries: {}, devices: {} });

const SOURCES = [
  [/(^|\.)google\./, 'Google'], [/(^|\.)bing\.com$/, 'Bing'], [/duckduckgo\.com$/, 'DuckDuckGo'], [/(^|\.)yahoo\./, 'Yahoo'],
  [/(^|\.)ecosia\.org$/, 'Ecosia'], [/(chatgpt\.com|openai\.com)$/, 'ChatGPT'], [/perplexity\.ai$/, 'Perplexity'],
  [/(^|\.)(facebook\.com|fb\.me|fb\.com)$/, 'Facebook'], [/instagram\.com$/, 'Instagram'], [/(^|\.)(t\.co|twitter\.com|x\.com)$/, 'X (Twitter)'],
  [/(linkedin\.com|lnkd\.in)$/, 'LinkedIn'], [/whatsapp\.(com|net)$/, 'WhatsApp'], [/tiktok\.com$/, 'TikTok'], [/(youtube\.com|youtu\.be)$/, 'YouTube'],
  [/pinterest\./, 'Pinterest'], [/nextdoor\./, 'Nextdoor'], [/yell\.com$/, 'Yell'], [/checkatrade\.com$/, 'Checkatrade'],
  [/trustpilot\.com$/, 'Trustpilot'], [/mybuilder\.com$/, 'MyBuilder'], [/ratedpeople\.com$/, 'Rated People'],
];
function sourceOf(req, siteHost) {
  const q = req.query?.utm_source || req.query?.ref;
  if (q) return String(q).toLowerCase().slice(0, 40);
  const ref = req.headers.referer;
  if (!ref) return 'Direct';
  let host;
  try { host = new URL(ref).hostname.toLowerCase().replace(/^www\./, ''); } catch { return 'Direct'; }
  if (host === siteHost.replace(/^www\./, '')) return null; // moving inside the site
  for (const [re, name] of SOURCES) if (re.test(host)) return name;
  return host.slice(0, 60);
}
const deviceOf = (ua) => (/ipad|tablet|kindle|playbook|silk|(android(?!.*mobile))/i.test(ua) ? 'Tablet' : /mobi|iphone|ipod|android|blackberry|opera mini|iemobile/i.test(ua) ? 'Mobile' : 'Desktop');
const add = (m, k, n = 1) => { if (k) m[k] = (m[k] || 0) + n; };

export function createStats(dataDir) {
  const root = path.join(dataDir, 'stats');
  const file = (id, d) => path.join(root, id, d + '.json');
  let day = today();
  let salt = crypto.randomBytes(32);
  const live = new Map(); // siteId -> today's totals
  const seen = new Map(); // siteId -> Set of today's visitor hashes
  const dirty = new Set();

  async function load(id, d) { try { return JSON.parse(await fs.readFile(file(id, d), 'utf8')); } catch { return null; } }
  async function flush() {
    for (const id of [...dirty]) {
      dirty.delete(id);
      const t = live.get(id); if (!t) continue;
      await fs.mkdir(path.join(root, id), { recursive: true });
      await fs.writeFile(file(id, day) + '.tmp', JSON.stringify(t));
      await fs.rename(file(id, day) + '.tmp', file(id, day));
    }
  }
  async function rollover() {
    if (today() === day) return;
    await flush();
    day = today(); salt = crypto.randomBytes(32); live.clear(); seen.clear();
  }

  /**
   * Count one page sent to a visitor. Call it only for real pages (HTML, status 200, GET).
   * `site` is { id }, `pagePath` the path of the page, `ip` the visitor's real IP.
   */
  async function record(site, req, pagePath, ip) {
    try {
      const ua = String(req.headers['user-agent'] || '');
      if (!ua || BOT.test(ua)) return;
      if (/prefetch|prerender/i.test(String(req.headers['sec-purpose'] || req.headers.purpose || ''))) return;
      await rollover();
      let t = live.get(site.id);
      if (!t) { t = (await load(site.id, day)) || blank(); live.set(site.id, t); seen.set(site.id, new Set()); }
      const host = String(req.hostname || '').toLowerCase();
      const page = ('/' + String(pagePath || '').replace(/^\/+/, '')).replace(/\/index\.html$/, '/').replace(/\.html$/, '').slice(0, 120) || '/';
      t.views++; add(t.pages, page);
      const v = crypto.createHash('sha256').update(salt).update(site.id).update(String(ip)).update(ua).digest('base64').slice(0, 16);
      const set = seen.get(site.id);
      if (!set.has(v) && set.size < 200000) {
        set.add(v);
        t.visitors++;
        add(t.sources, sourceOf(req, host) || 'Direct');
        add(t.countries, String(req.headers['cf-ipcountry'] || '').toUpperCase().replace(/^(XX|T1)$/, '') || countryOf(ip) || 'Unknown');
        add(t.devices, deviceOf(ua));
      }
      dirty.add(site.id);
    } catch (e) { console.warn('[stats]', e.message); }
  }

  /** Totals for the last `days` days (today included): one entry per day plus the breakdowns. */
  async function query(id, days) {
    await flush();
    const out = { days: [], pages: {}, sources: {}, countries: {}, devices: {}, views: 0, visitors: 0 };
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10);
      const t = (d === day && live.get(id)) || (await load(id, d)) || blank();
      out.days.push({ date: d, views: t.views, visitors: t.visitors });
      out.views += t.views; out.visitors += t.visitors;
      for (const k of ['pages', 'sources', 'countries', 'devices']) for (const [n, c] of Object.entries(t[k])) add(out[k], n, c);
    }
    return out;
  }

  /** Remove a site's statistics (when the site is deleted). */
  async function purge(id) { live.delete(id); seen.delete(id); dirty.delete(id); await fs.rm(path.join(root, id), { recursive: true, force: true }); }

  /** Remove days older than KEEP_DAYS. */
  async function prune() {
    const limit = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
    for (const id of await fs.readdir(root).catch(() => [])) {
      for (const f of await fs.readdir(path.join(root, id)).catch(() => [])) if (f.slice(0, 10) < limit) await fs.rm(path.join(root, id, f), { force: true });
    }
  }

  /** Ids of all sites that have statistics. */
  const ids = async () => (await fs.readdir(root).catch(() => [])).filter((x) => /^[a-z0-9]{10}$/.test(x));

  setInterval(() => { rollover().then(flush).catch((e) => console.warn('[stats] flush:', e.message)); }, 60000).unref();
  setInterval(() => prune().catch(() => {}), 24 * 3600 * 1000).unref();
  const stop = () => flush().catch(() => {}).finally(() => process.exit(0));
  process.once('SIGTERM', stop); process.once('SIGINT', stop);

  return { record, query, purge, prune, flush, ids };
}

/** Sort a {name: count} map into the top `n` entries, the rest grouped as "Other". */
export function top(map, n = 8) {
  const all = Object.entries(map || {}).sort((a, b) => b[1] - a[1]);
  const head = all.slice(0, n).map(([name, count]) => ({ name, count }));
  const rest = all.slice(n).reduce((s, [, c]) => s + c, 0);
  if (rest) head.push({ name: 'Other', count: rest });
  return head;
}
