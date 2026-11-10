// ili-sites: the server that shows published client websites (MODE=sites).
// It knows nothing about accounts, the editor or AI. ili studio pushes each published site here
// (a ZIP, authenticated with SITES_SECRET) and this server only serves the files.
// Contact forms are passed back to ili studio, which keeps the messages and e-mails the owner.
// Because everything arrives by push, this server can later run on another VPS: only SITES_URL changes in ili studio.
//
// Storage:  DATA_DIR/live/<sub>/...      files of the site
//           DATA_DIR/live/<sub>.json     { id, sub, name, publishedAt, thanks, domain, badge }
// badge: true for free plans: every page served gets the "Website made with Ilidweb" bar (see badge.js).
//
// Own domains: a site can also answer on the client's domain (and its www). When TRAEFIK_DIR is set
// (Coolify's proxy/dynamic folder, mounted in this container), we write ili-domains.yaml there so
// Traefik routes those domains here and gets their HTTPS certificates. ili studio only sends a domain
// once its DNS points to us, so Let's Encrypt never fails on it.
import express from 'express';
import compression from 'compression';
import AdmZip from 'adm-zip';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { clientIp } from './clientip.js';
import { FREE_DOMAIN } from './plans.js';
import { createStats, top } from './stats.js';
import { startGeo } from './geo.js';
import { injectBadge } from './badge.js';

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const LIVE = path.join(DATA_DIR, 'live');
const SECRET = process.env.SITES_SECRET || '';
const STUDIO_URL = (process.env.STUDIO_URL || '').replace(/\/$/, '');
const MAX_ZIP = 300 * 1024 * 1024;
const SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';
const stats = createStats(DATA_DIR);
const SUB_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const TRAEFIK_DIR = process.env.TRAEFIK_DIR || '';
const TRAEFIK_TARGET = process.env.TRAEFIK_TARGET || 'http://ili-sites:3000';
const cleanDomain = (d) => { d = String(d || '').toLowerCase().trim(); return DOMAIN_RE.test(d) && !d.endsWith('.' + FREE_DOMAIN) && d !== FREE_DOMAIN ? d : null; };

if (!SECRET || SECRET.length < 24) console.warn('[sites] SITES_SECRET is missing or too short: ili studio cannot publish here.');
if (!STUDIO_URL) console.warn('[sites] STUDIO_URL is missing: contact forms cannot be delivered.');

const safeJoin = (base, rel) => {
  const p = path.resolve(base, '.' + path.posix.normalize('/' + String(rel || '')));
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error('Unsafe path');
  return p;
};
const siteDir = (sub) => path.join(LIVE, sub);
const metaFile = (sub) => path.join(LIVE, sub + '.json');

// published sites by address, in memory; own domains → address
const index = new Map();
const hosts = new Map();
async function loadIndex() {
  await fs.mkdir(LIVE, { recursive: true });
  index.clear();
  for (const f of await fs.readdir(LIVE)) {
    if (!f.endsWith('.json')) continue;
    try { const m = JSON.parse(await fs.readFile(path.join(LIVE, f), 'utf8')); if (SUB_RE.test(m.sub)) index.set(m.sub, m); } catch { /* skip */ }
  }
  await domainsChanged();
}

async function writeMeta(meta) {
  await fs.writeFile(metaFile(meta.sub) + '.tmp', JSON.stringify(meta));
  await fs.rename(metaFile(meta.sub) + '.tmp', metaFile(meta.sub));
}

/** Rebuild the domain → address map and Traefik's routes for the own domains. */
let lastRoutes = null;
async function domainsChanged() {
  hosts.clear();
  for (const m of index.values()) if (m.domain && !hosts.has(m.domain)) hosts.set(m.domain, m.sub);
  if (!TRAEFIK_DIR) return;
  const names = [...hosts.keys()].sort();
  const q = (d) => '`' + d + '`';
  let yaml = '# Written by ili-sites: own domains of client websites. Do not edit, it is rewritten.\n';
  if (names.length) {
    yaml += 'http:\n  routers:\n';
    for (const d of names) {
      const key = 'ili-d-' + crypto.createHash('sha1').update(d).digest('hex').slice(0, 12);
      const rule = `Host(${q(d)}) || Host(${q('www.' + d)})`;
      yaml += `    ${key}:\n      rule: "${rule}"\n      entryPoints: [https]\n      service: ili-domains\n      tls:\n        certResolver: letsencrypt\n`;
      yaml += `    ${key}-http:\n      rule: "${rule}"\n      entryPoints: [http]\n      middlewares: [ili-to-https]\n      service: ili-domains\n`;
    }
    yaml += `  middlewares:\n    ili-to-https:\n      redirectScheme:\n        scheme: https\n        permanent: true\n  services:\n    ili-domains:\n      loadBalancer:\n        servers:\n          - url: "${TRAEFIK_TARGET}"\n`;
  }
  if (yaml === lastRoutes) return;
  try {
    const file = path.join(TRAEFIK_DIR, 'ili-domains.yaml');
    if (!names.length) await fs.rm(file, { force: true });
    else { await fs.writeFile(file + '.tmp', yaml); await fs.rename(file + '.tmp', file); }
    lastRoutes = yaml;
    console.log(`[sites] Traefik routes: ${names.length} own domain${names.length === 1 ? '' : 's'}`);
  } catch (e) { console.error('[sites] could not write Traefik routes:', e.message); }
}

function authorised(req) {
  const got = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''));
  const want = Buffer.from(SECRET);
  return SECRET.length >= 24 && got.length === want.length && crypto.timingSafeEqual(got, want);
}

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(compression());
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); next(); });

app.get('/healthz', (req, res) => res.json({ ok: true, sites: index.size }));

// ---- internal API, used only by ili studio -------------------------------------------
const internal = express.Router();
internal.use((req, res, next) => (authorised(req) ? next() : res.status(404).send('Not found')));

internal.get('/sites', (req, res) => res.json({ sites: [...index.values()].map(({ id, sub, publishedAt, domain, badge }) => ({ id, sub, publishedAt, domain: domain || null, badge: !!badge })) }));

// the owner's plan changed: show or hide the free bar, without publishing again
internal.put('/badge/:sub', express.json({ limit: '10kb' }), async (req, res) => {
  const m = index.get(req.params.sub);
  if (!m || m.id !== req.body?.id) return res.status(404).json({ error: 'Site not found' });
  m.badge = !!req.body.badge;
  await writeMeta(m);
  res.json({ ok: true });
});

// put an own domain on a published site, or take it off (domain: null), without publishing again
internal.put('/domains/:sub', express.json({ limit: '10kb' }), async (req, res) => {
  const m = index.get(req.params.sub);
  if (!m || m.id !== req.body?.id) return res.status(404).json({ error: 'Site not found' });
  const domain = req.body.domain ? cleanDomain(req.body.domain) : null;
  if (req.body.domain && !domain) return res.status(400).json({ error: 'Bad domain' });
  const other = domain && hosts.get(domain);
  if (other && other !== m.sub) return res.status(409).json({ error: 'Domain used by another site' });
  m.domain = domain;
  await writeMeta(m);
  await domainsChanged();
  console.log(`[sites] ${m.sub}: domain ${domain || 'removed'}`);
  res.json({ ok: true });
});

internal.put('/sites/:sub', express.raw({ type: 'application/zip', limit: MAX_ZIP }), async (req, res) => {
  const sub = req.params.sub;
  if (!SUB_RE.test(sub)) return res.status(400).json({ error: 'Bad address' });
  let info;
  try { info = JSON.parse(Buffer.from(String(req.headers['x-ili-site'] || ''), 'base64').toString('utf8')); } catch { info = null; }
  if (!info || !/^[a-z0-9]{10}$/.test(info.id)) return res.status(400).json({ error: 'Bad site info' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Empty upload' });
  const owner = index.get(sub);
  if (owner && owner.id !== info.id) return res.status(409).json({ error: 'Address used by another site' });

  const tmp = siteDir(sub) + '.tmp-' + crypto.randomBytes(3).toString('hex');
  try {
    const zip = new AdmZip(req.body);
    let total = 0;
    for (const e of zip.getEntries()) {
      if (e.isDirectory) continue;
      total += e.header.size;
      if (total > MAX_ZIP * 2) throw new Error('Site too large');
      const dest = safeJoin(tmp, e.entryName);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, e.getData());
    }
    await fs.mkdir(tmp, { recursive: true });
    let domain = info.domain === undefined ? owner?.domain || null : cleanDomain(info.domain);
    if (domain && hosts.has(domain) && hosts.get(domain) !== sub) domain = null; // already on another site
    const meta = { id: info.id, sub, name: String(info.name || '').slice(0, 120), publishedAt: String(info.publishedAt || new Date().toISOString()), thanks: fss.existsSync(path.join(tmp, 'thanks.html')), domain, badge: info.badge === undefined ? !!owner?.badge : !!info.badge };
    const old = siteDir(sub) + '.old-' + crypto.randomBytes(3).toString('hex');
    if (fss.existsSync(siteDir(sub))) await fs.rename(siteDir(sub), old);
    await fs.rename(tmp, siteDir(sub));
    await writeMeta(meta);
    index.set(sub, meta);
    if ((owner?.domain || null) !== domain) await domainsChanged();
    await fs.rm(old, { recursive: true, force: true });
    console.log(`[sites] published ${sub} (${info.id})`);
    res.json({ ok: true });
  } catch (e) {
    await fs.rm(tmp, { recursive: true, force: true });
    console.error(`[sites] publish ${sub} failed:`, e.message);
    res.status(400).json({ error: e.message });
  }
});

// visitor statistics, read by ili studio (which checks who may see what)
const daysOf = (q) => Math.min(800, Math.max(1, parseInt(q, 10) || 30));
internal.get('/stats/:id', async (req, res) => {
  if (!/^[a-z0-9]{10}$/.test(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  res.json(await stats.query(req.params.id, daysOf(req.query.days)));
});
internal.get('/stats', async (req, res) => {
  const days = daysOf(req.query.days);
  const sites = {};
  for (const id of await stats.ids()) { const q = await stats.query(id, days); if (q.views) sites[id] = q; }
  res.json({ sites });
});

internal.delete('/sites/:sub', async (req, res) => {
  const sub = req.params.sub;
  if (!SUB_RE.test(sub)) return res.status(400).json({ error: 'Bad address' });
  const m = index.get(sub);
  if (m && req.query.id && m.id !== req.query.id) return res.status(409).json({ error: 'Address used by another site' });
  index.delete(sub);
  if (m && req.query.purge === '1') await stats.purge(m.id); // the site is deleted for good, not just taken offline
  await fs.rm(metaFile(sub), { force: true });
  await fs.rm(siteDir(sub), { recursive: true, force: true });
  if (m?.domain) await domainsChanged();
  console.log(`[sites] removed ${sub}`);
  res.json({ ok: true });
});
app.use('/_internal', internal);

// ---- Blesta webhook relay ----------------------------------------------------------------------
// Blesta (on the reseller's server) calls https://billing.yela.uk/_blesta/<key>: yela.uk is on Cloudflare,
// so the call always finds us. We pass it on to ili studio unchanged; ili studio checks the key.
app.post('/_blesta/:key', express.json({ limit: '200kb' }), express.urlencoded({ extended: true, limit: '200kb' }), async (req, res) => {
  if (!STUDIO_URL) return res.status(503).json({ error: 'not configured' });
  try {
    const r = await fetch(`${STUDIO_URL}/_internal/blesta/${encodeURIComponent(req.params.key)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req.body || {}), signal: AbortSignal.timeout(30000),
    });
    res.status(r.status).type('json').send(await r.text());
  } catch (e) { console.error('[sites] blesta relay:', e.message); res.status(502).json({ error: 'studio unreachable' }); }
});

// ---- public: the websites themselves ----------------------------------------------------
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

function subOf(req) {
  const host = String(req.hostname || '').toLowerCase();
  if (host.endsWith('.' + FREE_DOMAIN)) return host.slice(0, -FREE_DOMAIN.length - 1);
  return hosts.get(host) || null;
}

app.use(async (req, res, next) => {
  try {
    const host = String(req.hostname || '').toLowerCase();
    if (host === FREE_DOMAIN || host === 'www.' + FREE_DOMAIN) return res.redirect(302, 'https://ilidweb.uk/ili-studio/');
    // www.<own domain> → <own domain>; the free address → the own domain once it is live
    if (host.startsWith('www.') && hosts.has(host.slice(4))) return res.redirect(301, `https://${host.slice(4)}${req.originalUrl}`);
    const free = host.endsWith('.' + FREE_DOMAIN) ? index.get(host.slice(0, -FREE_DOMAIN.length - 1)) : null;
    if (free?.domain && (req.method === 'GET' || req.method === 'HEAD')) return res.redirect(301, `https://${free.domain}${req.originalUrl}`);
    const sub = subOf(req);
    if (!sub) return res.status(404).send('Site not found');
    const site = index.get(sub);
    res.setHeader('Content-Security-Policy', SANDBOX);
    if (!site) return res.status(404).send('Site not found');
    if (req.method === 'POST' && req.path === '/_form') return await forwardForm(site, req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).send('Method not allowed');

    const base = siteDir(sub);
    let file = safeJoin(base, decodeURIComponent(req.path).split('/').filter(Boolean).join('/') || 'index.html');
    if (fss.existsSync(file) && fss.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fss.existsSync(file) && fss.existsSync(file + '.html')) file += '.html';
    if (!fss.existsSync(file)) return res.status(404).send('Page not found');
    // pages are always fresh; images, styles and fonts are kept by the browser for a day
    res.setHeader('Cache-Control', /\.html?$/i.test(file) ? 'no-cache' : 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'GET' && /\.html?$/i.test(file)) stats.record(site, req, path.relative(base, file), clientIp(req));
    if (site.badge && /\.html?$/i.test(file)) return res.type('html').send(injectBadge(await fs.readFile(file, 'utf8'), site.sub));
    res.sendFile(file);
  } catch (e) { next(e); }
});

/** A visitor sent a contact form: hand it to ili studio, which keeps it and e-mails the owner. */
async function forwardForm(site, req, res) {
  let r;
  try {
    const resp = await fetch(STUDIO_URL + '/_internal/form', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + SECRET },
      body: JSON.stringify({ sub: site.sub, id: site.id, ip: clientIp(req), body: req.body || {} }),
      signal: AbortSignal.timeout(15000),
    });
    r = await resp.json();
  } catch (e) {
    console.error(`[sites] form for ${site.sub} not delivered:`, e.message);
    return res.status(503).type('html').send('<!doctype html><meta charset="utf-8"><title>Try again</title><p style="font:17px system-ui;max-width:520px;margin:15vh auto;padding:0 20px">Sorry, your message could not be sent right now. Please try again in a few minutes. <a href="javascript:history.back()">← Go back</a></p>');
  }
  if (r.redirect && site.thanks) return res.redirect(303, 'thanks.html');
  res.status(r.status || 200).type('html').send(r.html || '');
}

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status === 413 ? 413 : 500).send(err.status === 413 ? 'Too large' : 'Something went wrong');
});

await loadIndex();
startGeo(DATA_DIR);
app.listen(PORT, () => console.log(`ili-sites running on http://localhost:${PORT} (${index.size} sites, data: ${LIVE})`));
