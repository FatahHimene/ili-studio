// ili studio prototype server.
import express from 'express';
import multer from 'multer';
import compression from 'compression';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import { importUpload, ImportError } from './importer.js';
import { tag } from './html.js';
import * as cheerio from 'cheerio';
import { applyOps, injectEditor, strip, title, elementForAi, STYLE_OK, ID_ATTR } from './html.js';
import { wren, aiStatus, AiError, ping, askJson } from './ai.js';
import { searchPhotos, importPhoto, saveImage, bankStatus, ImageError } from './images.js';
import { listThemes, getTheme, publicTheme, installTheme, removeTheme, restoreTheme, copyThemeTo, applyPalette } from './themes.js';
import { personalise, cleanBrief } from './personalise.js';
import { requireAuth, requireAdmin, login, signup, logout, currentUser, frameToken, checkFrameToken, readToken, peekToken, limit, openSession } from './auth.js';
import { sendWelcome, sendReset, sendRecipientConfirm, sendEmailChange, sendEmailChanged, sendDomainLive, pwBind } from './emails.js';
import { mailEnabled, mailFrom, layout as mailLayout } from './mail.js';
import * as users from './users.js';
import { clientIp } from './clientip.js';
import { prepareForms, receive, emailText, listMessages, updateMessage, deleteMessage, thanksPage } from './forms.js';
import { sendMail } from './mail.js';
import { PLATFORMS, cleanReviews, renderReviews, hasReviewsBlock } from './reviews.js';
import { MODULES, contactOf, cleanContact, keepVerified, renderModules, sectionHtml, fieldLabels, contactDefaults, adoptForms, contactFromTheme } from './modules.js';
import { seoPage, seoFiles } from './seo.js';
import { analyse, crawl, pagespeed } from './audit.js';
import { PLANS, planOf, COSTS, FREE_DOMAIN, RESERVED } from './plans.js';
import { remote, pushSite, removeSite, startSync, internalSecret, remoteStats, liveDomain, setRemoteDomain } from './sitesync.js';
import { cleanDomainInput, checkDns, dnsRecords, startDomainCheck, SITES_IPS, CNAME_TARGET } from './domains.js';
import { createStats, top } from './stats.js';
import { startGeo } from './geo.js';
import crypto from 'node:crypto';
import * as versions from './versions.js';
import { billingEnabled, checkout, blestaLink, ensureClient, syncUser, onWebhook, startBillingSync, WEBHOOK_KEY, registerDomain, FREE_TLDS, tldOf, BillingError } from './billing.js';
import { registrarEnabled, isAvailable, pointDomain, NAMESERVERS } from './registrar.js';
import { deleteSite, deleteAccount, diskUsage, startCleanup } from './cleanup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 3000);

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

// Basic security headers for the app itself
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// Free sites: <name>.FREE_DOMAIN is served straight from the published copy (nothing of the app is reachable there).
app.use((req, res, next) => {
  const host = String(req.hostname || '').toLowerCase();
  if (host === FREE_DOMAIN || host === 'www.' + FREE_DOMAIN) return res.redirect(302, 'https://ilidweb.uk/ili-studio/');
  if (!host.endsWith('.' + FREE_DOMAIN)) return next();
  const sub = host.slice(0, -FREE_DOMAIN.length - 1);
  if (req.method === 'POST' && req.path === '/_form') return handleForm(sub, req, res).catch(next);
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).send('Method not allowed');
  const parts = decodeURIComponent(req.path).split('/').filter(Boolean);
  serveSite(sub, parts, res, req).catch(next);
});

// Site content (draft in the editor, published sites) runs in an opaque origin, so its scripts
// can never reach the admin API or cookies.
const SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads';
// Sandboxed pages have an opaque origin, so fonts and fetches to their own files need CORS.
const corsOk = (res) => res.setHeader('Access-Control-Allow-Origin', '*');

const upload = multer({ dest: path.join(os.tmpdir(), 'ili-uploads'), limits: { fileSize: 100 * 1024 * 1024, files: 1 } });
const imageUpload = multer({
  dest: path.join(os.tmpdir(), 'ili-uploads'), limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_, f, cb) => cb(null, /^image\/(png|jpe?g|gif|webp|avif|svg\+xml)$/.test(f.mimetype)),
});

// Pages reference /_ili assets with ?v=<boot id>, so every deploy busts the browser cache.
const VERSION = Date.now().toString(36);
const pageCache = new Map();
const send = (res, file) => {
  let html = pageCache.get(file);
  if (!html) {
    html = fss.readFileSync(path.join(PUBLIC, file), 'utf8').replace(/(\/_ili\/[\w.-]+\.(?:css|js))(?=["'])/g, `$1?v=${VERSION}`);
    pageCache.set(file, html);
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(html);
};
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---- static assets of the editor ---------------------------------------------------
// always revalidate (ETag), so an update of the editor is picked up straight away
app.use('/_ili', express.static(path.join(PUBLIC, 'assets'), { maxAge: 0 }));

// ---- auth ----------------------------------------------------------------------------
app.get('/login', wrap(async (req, res) => ((await currentUser(req)) ? res.redirect('/') : send(res, 'login.html'))));
app.get('/signup', wrap(async (req, res) => ((await currentUser(req)) ? res.redirect('/') : send(res, 'signup.html'))));
app.post('/login', wrap(async (req, res) => {
  const r = await login(req, res, req.body.email, req.body.password);
  if (r.ok) return res.redirect(req.body.next === 'seo' ? '/seo' : '/');
  res.redirect('/login?error=' + encodeURIComponent(r.error) + '&email=' + encodeURIComponent(String(req.body.email || '').slice(0, 120)));
}));
// ---- password reset, confirming addresses -----------------------------------------------------
const escH = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** A small page in the sign-in style, for the result of a link from an e-mail. */
function notice(res, status, title, text, link = { href: '/', label: 'Open ili studio' }) {
  res.status(status).type('html').send(`<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escH(title)} · ili studio</title><link rel="icon" href="/_ili/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/_ili/app.css"><link rel="stylesheet" href="/_ili/auth.css"></head>
<body class="grid-bg"><div class="card"><span class="logo"><span class="i"><span class="cur"></span>ı</span>li studio</span><h1>${escH(title)}</h1><p>${escH(text)}</p><a class="btn btn-primary" href="${escH(link.href)}">${escH(link.label)}</a></div></body></html>`);
}
app.get('/forgot', (req, res) => send(res, 'forgot.html'));
app.post('/forgot', wrap(async (req, res) => {
  const e = users.normEmail(req.body.email);
  // same answer whether the account exists or not, so nobody can find out who has an account
  if (!limit('forgot:' + clientIp(req), 5, 3600000, 3600000) && !limit('forgot:' + e, 3, 3600000, 3600000)) {
    const u = await users.byEmail(e);
    if (u && u.role !== 'admin') await sendReset(u);
  }
  res.redirect('/forgot?sent=1&email=' + encodeURIComponent(e.slice(0, 120)));
}));
async function resetUser(t) {
  const p = peekToken(t);
  const u = p?.u ? await users.get(String(p.u)) : null;
  const ok = u && readToken(t, pwBind(u));
  return ok && ok.k === 'reset' ? u : null;
}
app.get('/reset', wrap(async (req, res) => {
  if (!(await resetUser(req.query.t))) return notice(res, 400, 'This link has expired', 'Reset links work once and for 1 hour. Ask for a new one.', { href: '/forgot', label: 'Get a new link' });
  send(res, 'reset.html');
}));
app.post('/reset', wrap(async (req, res) => {
  const u = await resetUser(req.body.t);
  if (!u) return notice(res, 400, 'This link has expired', 'Reset links work once and for 1 hour. Ask for a new one.', { href: '/forgot', label: 'Get a new link' });
  const pw = String(req.body.password || '');
  if (pw.length < 8 || pw.length > 200) return res.redirect('/reset?t=' + encodeURIComponent(req.body.t) + '&error=' + encodeURIComponent('Choose a password of at least 8 characters'));
  u.password = users.hashPassword(pw); await users.save(u);
  openSession(req, res, u.id);
  res.redirect('/?reset=1');
}));
app.get('/confirm/recipient', wrap(async (req, res) => {
  const p = readToken(req.query.t);
  if (!p || p.k !== 'rcpt') return notice(res, 400, 'This link has expired', 'Ask the website owner to add your address again.', { href: 'https://ilidweb.uk', label: 'ilidweb.uk' });
  const m = await store.readMeta(String(p.s)).catch(() => null);
  const r = m?.contact?.recipients?.find((x) => x.email === p.e);
  if (!r) return notice(res, 404, 'Nothing to confirm', 'This address is no longer on the list for this website.', { href: 'https://ilidweb.uk', label: 'ilidweb.uk' });
  r.verified = true; await store.writeMeta(m.id, m); invalidateSites();
  notice(res, 200, 'Address confirmed', `Messages sent through the contact form of “${m.name}” will now be copied to ${p.e}.`, { href: 'https://ilidweb.uk', label: 'ilidweb.uk' });
}));
app.post('/api/me/email', requireAuth, wrap(async (req, res) => {
  if (req.user.role === 'admin') return res.status(400).json({ error: 'Not for the admin account' });
  const next = users.normEmail(req.body.email);
  if (!users.EMAIL_RE.test(next)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (next === req.user.email) return res.status(400).json({ error: 'This is already your address' });
  if (!users.checkPassword(String(req.body.password || ''), req.user.password)) return res.status(403).json({ error: 'Wrong password' });
  if (await users.byEmail(next)) return res.status(409).json({ error: 'Another account already uses this address' });
  if (limit('email:' + req.user.id, 5, 3600000, 3600000)) return res.status(429).json({ error: 'Too many tries. Try again in an hour.' });
  if (!mailEnabled()) return res.status(503).json({ error: 'E-mails are not set up yet. Write to hello@ilidweb.uk to change your address.' });
  await sendEmailChange(req.user, next);
  res.json({ ok: true });
}));
app.get('/confirm/email', wrap(async (req, res) => {
  const p0 = peekToken(req.query.t);
  const u = p0?.u ? await users.get(String(p0.u)) : null;
  const p = u && readToken(req.query.t, u.email);
  if (!p || p.k !== 'email') return notice(res, 400, 'This link has expired', 'Ask again from your account page.', { href: '/account', label: 'Your account' });
  if (await users.byEmail(p.e)) return notice(res, 409, 'Address already used', 'Another account already uses this address.', { href: '/account', label: 'Your account' });
  const old = u.email; u.email = p.e; await users.save(u);
  sendEmailChanged(u, old);
  notice(res, 200, 'New address confirmed', `Sign in with ${p.e} from now on.`, { href: '/account', label: 'Your account' });
}));
// admin: is e-mail working?
app.get('/api/admin/mail', requireAdmin, (req, res) => res.json({ enabled: mailEnabled(), from: mailFrom() }));
app.post('/api/admin/mail/test', requireAdmin, wrap(async (req, res) => {
  const to = users.normEmail(req.body.to);
  if (!users.EMAIL_RE.test(to)) return res.status(400).json({ error: 'Enter a valid email address' });
  const m = mailLayout({ title: 'Test e-mail', paras: ['If you can read this, ili studio can send e-mails.'] });
  try { const ok = await sendMail({ to, subject: 'ili studio test e-mail', ...m }); res.json({ ok, error: ok ? null : 'SMTP is not set up' }); }
  catch (e) { res.status(502).json({ error: 'Sending failed: ' + e.message }); }
}));

app.post('/signup', wrap(async (req, res) => {
  const r = await signup(req, res, { email: req.body.email, password: req.body.password, name: req.body.name });
  if (r.ok) sendWelcome(r.user);
  if (r.ok) return res.redirect(req.body.next === 'seo' ? '/seo' : '/welcome');
  res.redirect('/signup?error=' + encodeURIComponent(r.error) + '&email=' + encodeURIComponent(String(req.body.email || '').slice(0, 120)) + (req.body.next === 'seo' ? '&next=seo' : ''));
}));
app.post('/logout', (req, res) => { logout(res); res.redirect('/login'); });

// ---- account, plans and credits --------------------------------------------------------
app.get('/api/plans', (req, res) => res.json({ plans: PLANS, freeDomain: FREE_DOMAIN, costs: COSTS }));
app.get('/api/me', requireAuth, wrap(async (req, res) => {
  const u = req.user;
  // back from the payment page: check Blesta now rather than waiting for the webhook (at most every 20 s)
  if (u.blesta?.pending && billingEnabled() && Date.now() - (u._checkedAt || 0) > 20000) { u._checkedAt = Date.now(); await syncUser(u).catch(() => {}); }
  res.json({ ...users.publicUser(u), planInfo: planOf(u), billing: billingEnabled(), paying: !!u.blesta?.pending });
}));
// ---- the client's own account: see it, delete it -----------------------------------------
app.get('/account', requireAuth, (req, res) => send(res, 'account.html'));
app.patch('/api/me', requireAuth, wrap(async (req, res) => {
  if (req.user.role === 'admin') return res.status(400).json({ error: 'Not for the admin account' });
  const name = String(req.body.name ?? '').trim().slice(0, 80);
  req.user.name = name; await users.save(req.user);
  res.json({ ok: true, name });
}));
app.post('/api/me/password', requireAuth, wrap(async (req, res) => {
  if (req.user.role === 'admin') return res.status(400).json({ error: 'The admin password is set in Coolify (ADMIN_PASSWORD).' });
  const next = String(req.body.next || '');
  if (!users.checkPassword(String(req.body.current || ''), req.user.password)) return res.status(403).json({ error: 'Your current password is wrong' });
  if (next.length < 8) return res.status(400).json({ error: 'Choose a new password of at least 8 characters' });
  if (next.length > 200) return res.status(400).json({ error: 'This password is too long' });
  req.user.password = users.hashPassword(next); await users.save(req.user);
  res.json({ ok: true });
}));
app.delete('/api/me', requireAuth, wrap(async (req, res) => {
  if (req.user.role === 'admin') return res.status(400).json({ error: 'The admin account cannot be deleted here.' });
  if (!users.checkPassword(String(req.body.password || ''), req.user.password)) return res.status(403).json({ error: 'Wrong password' });
  try { await deleteAccount(req.user); }
  catch (e) { console.error(`[account] ${req.user.id}:`, e.message); return res.status(502).json({ error: 'Your account could not be deleted right now. Please try again in a few minutes.' }); }
  invalidateSites();
  logout(res);
  res.json({ ok: true });
}));

// ---- admin: clients ------------------------------------------------------------------------
app.get('/clients', requireAdmin, (req, res) => send(res, 'clients.html'));
app.get('/api/admin/clients', requireAdmin, wrap(async (req, res) => {
  const all = await store.listSites();
  const list = await Promise.all((await users.list()).filter((u) => u.role !== 'admin').map(async (u) => {
    const mine = all.filter((s) => s.owner === u.id);
    let bytes = 0;
    for (const s of mine) bytes += await diskUsage(store.siteDir(s.id));
    return {
      id: u.id, email: u.email, name: u.name, plan: u.plan, wantsPlan: u.wantsPlan || null, credits: u.credits,
      createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null, bytes,
      sites: mine.map((s) => ({ id: s.id, name: s.name, live: !!s.publishedAt, address: s.publishedAt ? `${s.subdomain || s.slug}.${FREE_DOMAIN}` : null })),
    };
  }));
  list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json({ clients: list, plans: PLANS.map((p) => ({ id: p.id, name: p.name })), disk: await diskUsage(store.DATA_DIR) });
}));
app.patch('/api/admin/clients/:id', requireAdmin, wrap(async (req, res) => {
  const u = await users.get(req.params.id);
  if (!u || u.role === 'admin') return res.status(404).json({ error: 'Client not found' });
  if (req.body.plan !== undefined) {
    const plan = PLANS.find((p) => p.id === req.body.plan);
    if (!plan) return res.status(400).json({ error: 'Unknown plan' });
    u.plan = plan.id; u.planChosen = true; if (u.wantsPlan === plan.id) u.wantsPlan = null;
  }
  if (req.body.credits !== undefined) {
    const n = Math.round(Number(req.body.credits));
    if (!Number.isFinite(n) || n < 0 || n > 100000) return res.status(400).json({ error: 'Credits must be a number between 0 and 100000' });
    u.credits = n;
  }
  await users.save(u);
  res.json({ ok: true });
}));
app.delete('/api/admin/clients/:id', requireAdmin, wrap(async (req, res) => {
  const u = await users.get(req.params.id);
  if (!u || u.role === 'admin') return res.status(404).json({ error: 'Client not found' });
  if (users.normEmail(req.body.confirm) !== u.email) return res.status(400).json({ error: 'Type the client\'s email address to confirm.' });
  let n;
  try { n = await deleteAccount(u); }
  catch (e) { console.error(`[account] ${u.id}:`, e.message); return res.status(502).json({ error: 'Could not delete this account right now (a site could not be taken offline). Try again in a minute.' }); }
  invalidateSites();
  res.json({ ok: true, sites: n });
}));

/** The client's choice on the offers screen. Paid plans are recorded until card payment is switched on. */
app.post('/api/me/choice', requireAuth, wrap(async (req, res) => {
  const plan = PLANS.find((p) => p.id === req.body.plan);
  if (!plan) return res.status(400).json({ error: 'Unknown plan' });
  const u = req.user;
  u.planChosen = true;
  if (plan.id !== 'free') u.wantsPlan = plan.id;
  await users.save(u);
  // paid plan and Blesta is set up: straight to the payment page, already signed in
  if (plan.id !== 'free' && billingEnabled() && u.role !== 'admin') {
    try { return res.json({ ...users.publicUser(u), payments: true, ...(await checkout(u, plan.id)) }); }
    catch (e) { console.error(`[billing] checkout ${u.id}:`, e.message); }
  }
  res.json({ ...users.publicUser(u), payments: false });
}));

// ---- Blesta: invoices, support, webhook -------------------------------------------------------
const BLESTA_PAGES = { invoices: '/client/invoices/', support: '/client/plugin/support_manager/client_tickets/', services: '/client/services/' };
app.get('/billing/:page', requireAuth, wrap(async (req, res) => {
  const path = BLESTA_PAGES[req.params.page];
  if (!path || req.user.role === 'admin') return res.redirect('/account');
  if (!billingEnabled()) return res.redirect(req.params.page === 'support' ? 'mailto:hello@ilidweb.uk' : '/account');
  try { await ensureClient(req.user); res.redirect(blestaLink(req.user, path)); }
  catch (e) { console.error(`[billing] ${req.params.page} ${req.user.id}:`, e.message); res.redirect('/account?billing=down'); }
}));
// Blesta's Webhooks plugin calls this when an invoice is paid or a service changes. The key in the URL is the only secret.
app.post('/_internal/blesta/:key', wrap(async (req, res) => {
  const got = Buffer.from(String(req.params.key)), want = Buffer.from(WEBHOOK_KEY);
  if (WEBHOOK_KEY.length < 24 || got.length !== want.length || !crypto.timingSafeEqual(got, want)) return res.status(404).send('Not found');
  const n = await onWebhook(req.body || {});
  res.json({ ok: true, checked: n });
}));
app.get('/welcome', requireAuth, (req, res) => send(res, 'welcome.html'));

// ---- ownership ------------------------------------------------------------------------
class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
/** The site in the URL, if the signed-in user owns it (the admin sees every site). */
async function siteFor(req, id = req.params.id) {
  let meta;
  try { meta = await store.readMeta(String(id)); } catch { throw new HttpError(404, 'Site not found'); }
  if (req.user.role !== 'admin' && meta.owner !== req.user.id) throw new HttpError(404, 'Site not found');
  return meta;
}
/** Why the user cannot create another site, or null. */
async function siteLimit(user) {
  if (user.role === 'admin') return null;
  const plan = planOf(user);
  const n = (await store.listSites()).filter((s) => s.owner === user.id).length;
  return n >= plan.drafts ? `Your ${plan.name} plan allows ${plan.drafts} sites in progress. Delete one to start another.` : null;
}

// ---- dashboard & editor pages -------------------------------------------------------------
app.get('/', requireAuth, (req, res) => (req.user.role !== 'admin' && !req.user.planChosen ? res.redirect('/welcome') : send(res, 'dashboard.html')));
app.get('/editor/:id', requireAuth, wrap(async (req, res) => { await siteFor(req); send(res, 'editor.html'); }));

// ---- API -------------------------------------------------------------------------
app.get('/api/sites', requireAuth, wrap(async (req, res) => {
  const all = await store.listSites();
  if (req.user.role === 'admin') {
    const emails = new Map((await users.list()).map((u) => [u.id, u.email]));
    return res.json(all.map((s) => ({ ...s, ownerEmail: s.owner ? emails.get(s.owner) || '?' : null })));
  }
  const mine = all.filter((s) => s.owner === req.user.id);
  const msgs = await listMessages(mine.map((s) => s.id));
  res.json(mine.map((s) => ({ ...s, unread: msgs.filter((m) => m.site === s.id && !m.read && !m.spam).length })));
}));

app.post('/api/sites', requireAuth, upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a .zip or .html file' });
  const limit = await siteLimit(req.user);
  if (limit) { fs.rm(req.file.path, { force: true }); return res.status(403).json({ error: limit, code: 'site_limit' }); }
  const id = store.newId();
  const dir = store.siteDir(id);
  try {
    await fs.mkdir(store.draftDir(id), { recursive: true });
    const { pages } = await importUpload(req.file.path, req.file.originalname, store.draftDir(id));
    const index = await fs.readFile(path.join(store.draftDir(id), 'index.html'), 'utf8');
    const name = (req.body.name || '').trim() || title(index) || req.file.originalname.replace(/\.(zip|html?)$/i, '');
    let slug = store.slugify(name);
    for (let n = 2; await store.slugTaken(slug); n++) slug = `${store.slugify(name)}-${n}`;
    const now = new Date().toISOString();
    const meta = { id, owner: req.user.id, name: name.slice(0, 80), slug, pages, createdAt: now, updatedAt: now, publishedAt: null, source: req.file.originalname };
    await store.writeMeta(id, meta);
    res.json(meta);
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true });
    if (e instanceof ImportError) return res.status(400).json({ error: e.message });
    throw e;
  } finally {
    fs.rm(req.file.path, { force: true });
  }
}));

app.get('/api/sites/:id', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  const page = req.query.page || 'index.html';
  res.json({ ...meta, frameToken: frameToken(meta.id), undo: await store.historyCount(meta.id, page) });
}));

app.patch('/api/sites/:id', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  if (typeof req.body.name === 'string' && req.body.name.trim()) meta.name = req.body.name.trim().slice(0, 80);
  if (typeof req.body.slug === 'string') {
    const slug = store.slugify(req.body.slug);
    if (await store.slugTaken(slug, meta.id)) return res.status(409).json({ error: 'This address is already used' });
    meta.slug = slug;
  }
  meta.updatedAt = new Date().toISOString();
  await store.writeMeta(meta.id, meta);
  res.json(meta);
}));

app.delete('/api/sites/:id', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  try { await deleteSite(meta); }
  catch (e) { console.error(`[delete] ${meta.id}:`, e.message); return res.status(502).json({ error: 'Could not take the site offline right now. Please try again in a minute.' }); }
  invalidateSites();
  res.json({ ok: true });
}));

/** Apply edit operations to one page. Body: { page, ops: [...] } */
app.post('/api/sites/:id/ops', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  const page = String(req.body.page || 'index.html');
  if (!meta.pages.includes(page)) return res.status(404).json({ error: 'Page not found' });
  if (!Array.isArray(req.body.ops) || !req.body.ops.length || req.body.ops.length > 50) return res.status(400).json({ error: 'No changes sent' });
  const file = store.safeJoin(store.draftDir(meta.id), page);
  const before = await fs.readFile(file, 'utf8');
  let out;
  try { out = applyOps(before, req.body.ops); } catch (e) { return res.status(400).json({ error: e.message }); }
  await store.pushHistory(meta.id, page, before);
  await fs.writeFile(file, out.html);
  meta.updatedAt = new Date().toISOString();
  meta.dirty = true;
  await store.writeMeta(meta.id, meta);
  res.json({ ok: true, results: out.results, undo: await store.historyCount(meta.id, page) });
}));

// ---- Wren (AI) ------------------------------------------------------------------------
// Clients only learn whether Wren is on: which AI company runs it and how it is set up stays private.
app.get('/api/ai', requireAuth, (req, res) => { const st = aiStatus(); res.json(req.user.role === 'admin' ? st : { enabled: st.enabled }); });
const TECH_WORDS = /azure|free ai|gemini|anthropic|claude|openai|deployment|endpoint|api.?key|ai key|\bmodel\b|ai error|\(\d{3}\)|internet|caprover|coolify|app settings|server/i;
const ENV_NAME = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;
/** What a client may read about an AI failure. The admin sees the real reason; clients never see providers, settings or keys. */
function aiMsg(e, user, fallback) {
  const m = e instanceof AiError ? e.message : fallback;
  if (user?.role === 'admin' || !(TECH_WORDS.test(m) || ENV_NAME.test(m))) return m;
  console.error('[wren] error hidden from client:', m);
  return 'Wren is not available right now. Please try again in a few minutes.';
}
app.get('/api/ai/ping', requireAdmin, wrap(async (req, res) => res.json(await ping())));

const aiCalls = []; // simple guard: max 20 AI calls per minute for the whole app
const jobs = new Map(); // jobId -> { status: 'working'|'done'|'error', error?, undo?, site, at }

/** Start a Wren job; the editor polls GET /api/sites/:id/wren/:job (avoids proxy time-outs on slow AI). */
app.post('/api/sites/:id/wren', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  const page = String(req.body.page || 'index.html');
  const elId = String(req.body.id || '');
  const instruction = String(req.body.instruction || '').trim().slice(0, 500);
  if (!meta.pages.includes(page)) return res.status(404).json({ error: 'Page not found' });
  if (!instruction) return res.status(400).json({ error: 'Tell Wren what to do' });
  const cost = req.body.mode === 'text' ? COSTS.wrenText : COSTS.wrenBlock;
  if (!users.canSpend(req.user, cost)) return res.status(402).json({ error: 'You have used all your AI credits.', code: 'no_credits', credits: req.user.credits });
  const now = Date.now(); while (aiCalls.length && now - aiCalls[0] > 60000) aiCalls.shift();
  if (aiCalls.length >= 20) return res.status(429).json({ error: 'Wren is busy. Wait a minute and try again.' });
  aiCalls.push(now);

  const file = store.safeJoin(store.draftDir(meta.id), page);
  const snapshot = await fs.readFile(file, 'utf8');
  let el;
  try { el = elementForAi(snapshot, elId); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (el.html.length > 60000) return res.status(400).json({ error: 'This part is too big for Wren. Select a smaller element.' });
  const mode = req.body.mode === 'text' ? 'text' : 'block';
  const look = typeof req.body.style === 'string' ? req.body.style.slice(0, 400) : '';
  const current = req.body.current && typeof req.body.current === 'object' ? req.body.current : {};
  const palette = await sitePalette(store.draftDir(meta.id));

  const jobId = store.newId();
  const job = { status: 'working', site: meta.id, owner: req.user.id, at: Date.now() };
  jobs.set(jobId, job);
  for (const [k, j] of jobs) if (Date.now() - j.at > 10 * 60 * 1000) jobs.delete(k);
  res.status(202).json({ job: jobId });

  (async () => {
    try {
      const out = await wren({ mode, html: mode === 'text' ? `<${el.tag}>${el.inner}</${el.tag}>` : el.html, instruction, context: el.context, style: look, palette });
      const ops = [];
      if (out.html) {
        let html = out.html;
        if (mode === 'text') html = html.replace(new RegExp(`^<${el.tag}[^>]*>([\\s\\S]*)</${el.tag}>$`, 'i'), '$1');
        ops.push(mode === 'text' ? { type: 'html', id: elId, html } : { type: 'replace', id: elId, html });
      }
      let sameLook = false;
      if (out.style) {
        // drop values identical to what the element already shows (the AI sometimes "changes" a colour to itself)
        const norm = (v) => String(v).trim().toLowerCase().replace(/\s+/g, '');
        const same = { color: current.color, 'background-color': current.bg, 'font-size': current.fontSize ? current.fontSize + 'px' : null, 'border-radius': current.radius != null ? current.radius + 'px' : null };
        for (const k of Object.keys(out.style)) if (same[k.toLowerCase()] && norm(same[k.toLowerCase()]) === norm(out.style[k])) delete out.style[k];
        if (!Object.keys(out.style).length) { out.style = null; sameLook = true; }
      }
      if (out.style) {
        const props = Object.fromEntries(Object.entries(out.style).filter(([k, v]) => STYLE_OK.has(String(k).toLowerCase()) && (typeof v === 'string' || typeof v === 'number')).map(([k, v]) => [k.toLowerCase(), String(v)]));
        if (Object.keys(props).length) ops.push({ type: 'style', id: elId, props });
      }
      console.log(`[wren] job ${jobId} ${mode} <${el.tag}> "${instruction.slice(0, 60)}" -> html:${out.html ? out.html.length + ' chars' : 'none'} style:${out.style ? JSON.stringify(out.style).slice(0, 120) : 'none'} note:"${out.note.slice(0, 100)}"`);
      if (!ops.length) throw new AiError(sameLook ? 'Wren picked the same look as now. Say what you want, e.g. "dark blue background" or "bigger title".' : (out.note || 'Wren suggested no change. Try a more specific instruction.'));
      const layoutAsk = /column|colonne|grid|grille|layout|mise en page|r[ée]organi|3d|anim|redesign|refai|refonte|modern|add |ajout|call to action|cta|section/i.test(instruction);
      if (mode === 'block' && layoutAsk && !out.html) {
        console.warn(`[wren] job ${jobId}: layout asked but only style returned`);
        throw new AiError('Wren could not restructure this section (the AI only suggested a style change). Try again, or use a stronger design model (AZURE_OPENAI_DESIGN_DEPLOYMENT).');
      }
      const before = await fs.readFile(file, 'utf8'); // apply on the latest version of the page
      let result;
      try { result = applyOps(before, ops); }
      catch (e) { console.error(`[wren] job ${jobId} could not apply:`, e.message); throw new AiError('Wren returned something unusable. Try again.'); }
      const sig = (h) => h.replace(/\sdata-ili-id="[^"]*"/g, '').replace(/\s+/g, ' ').trim();
      if (sig(result.html) === sig(before)) { console.warn(`[wren] job ${jobId}: no change`); throw new AiError(out.note || 'Wren suggested no change. Try a more specific instruction.'); }
      await store.pushHistory(meta.id, page, before);
      await fs.writeFile(file, result.html);
      const m = await store.readMeta(meta.id);
      m.updatedAt = new Date().toISOString(); m.dirty = true;
      m.aiUsage = { calls: (m.aiUsage?.calls || 0) + 1, input: (m.aiUsage?.input || 0) + out.usage.input, output: (m.aiUsage?.output || 0) + out.usage.output };
      await store.writeMeta(meta.id, m);
      const payer = await users.spend(req.user.id, cost);
      Object.assign(job, { status: 'done', note: out.note, undo: await store.historyCount(meta.id, page), credits: payer?.role === 'admin' ? null : payer?.credits });
    } catch (e) {
      if (!(e instanceof AiError)) console.error('[wren] job failed:', e);
      Object.assign(job, { status: 'error', error: aiMsg(e, req.user, 'Wren hit a problem. Try again.') });
    }
  })();
}));

app.get('/api/sites/:id/wren/:job', requireAuth, (req, res) => {
  const job = jobs.get(req.params.job);
  if (!job || job.site !== req.params.id || (job.owner !== req.user.id && req.user.role !== 'admin')) return res.status(404).json({ error: 'Unknown Wren task' });
  res.json({ status: job.status, error: job.error, note: job.note, undo: job.undo, credits: job.credits });
});

app.post('/api/sites/:id/undo', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  const page = String(req.body.page || 'index.html');
  if (!meta.pages.includes(page)) return res.status(404).json({ error: 'Page not found' });
  const html = await store.popHistory(meta.id, page);
  if (html == null) return res.status(400).json({ error: 'Nothing to undo' });
  await fs.writeFile(store.safeJoin(store.draftDir(meta.id), page), html);
  meta.updatedAt = new Date().toISOString(); meta.dirty = true;
  await store.writeMeta(meta.id, meta);
  res.json({ ok: true, undo: await store.historyCount(meta.id, page) });
}));

/** Most used colours of a site (from its CSS and inline styles), to keep Wren's choices on-brand. */
async function sitePalette(dir) {
  const counts = new Map();
  const walk = async (d, depth = 0) => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.name === 'ili-uploads' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) await walk(p, depth + 1);
      else if (/\.(css|html)$/i.test(e.name)) {
        const txt = (await fs.readFile(p, 'utf8')).slice(0, 400000);
        for (const m of txt.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
          let h = m[1].toLowerCase(); if (h.length === 3) h = h.split('').map((c) => c + c).join('');
          counts.set('#' + h, (counts.get('#' + h) || 0) + 1);
        }
      }
    }
  };
  await walk(dir);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([c]) => c);
}

const relFromPage = (page, file) => path.posix.relative(path.posix.dirname(page) === '.' ? '' : path.posix.dirname(page), file);

/** Upload an image into the site (resized + compressed); returns a path relative to the page. */
app.post('/api/sites/:id/images', requireAuth, imageUpload.single('image'), wrap(async (req, res) => {
  const meta = await siteFor(req);
  if (!req.file) return res.status(400).json({ error: 'Choose a PNG, JPG, GIF, WebP, AVIF or SVG image (max 10 MB)' });
  const page = String(req.body.page || 'index.html');
  try {
    const saved = await saveImage(await fs.readFile(req.file.path), path.join(store.draftDir(meta.id), 'ili-uploads'), { keepFormat: true });
    res.json({ src: relFromPage(page, 'ili-uploads/' + saved.name) });
  } catch (e) {
    if (e instanceof ImageError) return res.status(400).json({ error: e.message });
    throw e;
  } finally { fs.rm(req.file.path, { force: true }); }
}));

// ---- pages ---------------------------------------------------------------------------------------
const linkTarget = (fromPage, href) => {
  if (!href || /^(https?:|mailto:|tel:|#|javascript:)/i.test(href)) return null;
  const clean = href.split(/[?#]/)[0];
  const base = path.posix.dirname(fromPage) === '.' ? '' : path.posix.dirname(fromPage);
  let t = path.posix.normalize(path.posix.join(base, clean || ''));
  if (t === '.' || t.endsWith('/') || clean === './' || clean === '') t = path.posix.join(t === '.' ? '' : t, 'index.html');
  return t.replace(/^\.\//, '');
};

async function editPages(meta, fn) {
  for (const page of meta.pages) {
    const f = store.safeJoin(store.draftDir(meta.id), page);
    const $ = cheerio.load(await fs.readFile(f, 'utf8'));
    if (fn($, page) !== false) await fs.writeFile(f, tag($.html()));
  }
}

/** Colour palettes the site can switch between (from its theme) + colours used, for the style swatches. */
app.get('/api/sites/:id/palettes', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  const theme = meta.theme ? await getTheme(meta.theme.id) : null;
  const palettes = theme?.palettes || [];
  const current = palettes.find((p) => p.id === meta.palette) || null;
  const swatches = current ? [...new Set(Object.values(current.colors))] : (await sitePalette(store.draftDir(meta.id))).slice(0, 8);
  res.json({ palettes, current: current?.id || null, swatches });
}));

/** Switch the site's palette. Body: { palette } */
app.post('/api/sites/:id/palette', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  const theme = meta.theme ? await getTheme(meta.theme.id) : null;
  const pal = theme?.palettes.find((p) => p.id === req.body.palette);
  if (!pal) return res.status(404).json({ error: 'Palette not found' });
  await applyPalette(store.draftDir(meta.id), meta.pages, pal);
  meta.palette = pal.id; meta.updatedAt = new Date().toISOString(); meta.dirty = true;
  await store.writeMeta(meta.id, meta);
  res.json({ ok: true, current: pal.id });
}));

/** Templates the site can use (from its theme). */
app.get('/api/sites/:id/templates', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  const theme = meta.theme ? await getTheme(meta.theme.id) : null;
  res.json(theme ? theme.templates.map(({ id, name, path: p }) => ({ id, name, path: p })) : []);
}));

/** Add a page. Body: { title, from: 'blank'|'duplicate'|'template', source?, template?, menu?: true } */
app.post('/api/sites/:id/pages', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  const title = String(req.body.title || '').trim().slice(0, 60);
  if (!title) return res.status(400).json({ error: 'Give the page a name' });
  let file = store.slugify(title) + '.html';
  for (let n = 2; meta.pages.includes(file) || file === 'index.html'; n++) file = `${store.slugify(title)}-${n}.html`;
  const dir = store.draftDir(meta.id);
  const from = ['blank', 'duplicate', 'template'].includes(req.body.from) ? req.body.from : 'blank';
  const source = meta.pages.includes(req.body.source) ? req.body.source : 'index.html';
  let html;
  if (from === 'template') {
    const theme = meta.theme ? await getTheme(meta.theme.id) : null;
    const tpl = theme?.templates.find((t) => t.id === req.body.template);
    if (!tpl) return res.status(404).json({ error: 'Template not found' });
    html = await fs.readFile(path.join(theme.dir, tpl.file), 'utf8');
    html = adoptForms(html)?.html || html; // a form in the template becomes the Contact module
  } else {
    const $ = cheerio.load(await fs.readFile(store.safeJoin(dir, source), 'utf8'));
    if (from === 'blank') {
      const keep = (el) => /^(header|footer|nav|script)$/i.test(el.tagName) || $(el).find('nav').length > 0;
      const body = $('body');
      const kids = body.children().toArray();
      const footer = kids.find((k) => k.tagName === 'footer');
      kids.forEach((k) => { if (!keep(k)) $(k).remove(); });
      const section = `<main><section style="padding: 72px 24px; max-width: 1100px; margin: 0 auto"><h1>${title.replace(/[<>&"]/g, '')}</h1><p>Write your content here, or select this text and ask Wren.</p></section></main>`;
      if (footer) $(footer).before(section); else body.append(section);
    }
    $('title').first().text(`${title} · ${meta.name}`);
    html = $.html();
  }
  await fs.writeFile(store.safeJoin(dir, file), tag(html));
  meta.pages.push(file);
  if (from === 'template' && meta.palette) {
    const th = await getTheme(meta.theme.id); const pal = th?.palettes.find((p) => p.id === meta.palette);
    if (pal) await applyPalette(dir, [file], pal);
  }
  if (from === 'template' && meta.brief) {
    try { await personalise(dir, [file], meta.brief); } catch (e) { console.warn('[pages] template personalisation skipped:', e.message); }
  }
  const html2 = await fs.readFile(store.safeJoin(dir, file), 'utf8');
  if (!/<title>/i.test(html2) || from === 'template') { const $ = cheerio.load(html2); $('title').first().text(`${title} · ${meta.name}`); await fs.writeFile(store.safeJoin(dir, file), tag($.html())); }

  if (req.body.menu !== false) {
    await editPages(meta, ($, page) => {
      const nav = $('nav').filter((_, n) => $(n).find('a').length > 0).first();
      if (!nav.length) return false;
      const links = nav.find('a');
      if (links.toArray().some((a) => linkTarget(page, $(a).attr('href')) === file)) return false;
      const last = links.last();
      const clone = last.clone();
      clone.removeAttr('data-ili-id').removeAttr('data-ili-slot').removeAttr('data-ili-type').removeAttr('aria-current');
      clone.attr('href', path.posix.relative(path.posix.dirname(page) === '.' ? '' : path.posix.dirname(page), file));
      clone.text(title);
      last.after(clone);
    });
  }
  meta.updatedAt = new Date().toISOString(); meta.dirty = true;
  await store.writeMeta(meta.id, meta);
  res.json({ page: file, pages: meta.pages });
}));

/** Rename a page (its title and its menu links). Body: { page, title } */
app.patch('/api/sites/:id/pages', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  const page = String(req.body.page || ''); const title = String(req.body.title || '').trim().slice(0, 60);
  if (!meta.pages.includes(page) || !title) return res.status(400).json({ error: 'Page and new name required' });
  await editPages(meta, ($, p) => {
    if (p === page) $('title').first().text(page === 'index.html' ? $('title').first().text() : `${title} · ${meta.name}`);
    $('nav a').each((_, a) => { if (linkTarget(p, $(a).attr('href')) === page && $(a).children().length === 0) $(a).text(title); });
  });
  meta.updatedAt = new Date().toISOString(); meta.dirty = true;
  await store.writeMeta(meta.id, meta);
  res.json({ ok: true });
}));

/** Delete a page (not the home page) and its menu links. */
app.delete('/api/sites/:id/pages', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  const page = String(req.query.page || '');
  if (!meta.pages.includes(page)) return res.status(404).json({ error: 'Page not found' });
  if (page === 'index.html') return res.status(400).json({ error: 'The home page cannot be deleted' });
  await fs.rm(store.safeJoin(store.draftDir(meta.id), page), { force: true });
  meta.pages = meta.pages.filter((p) => p !== page);
  await editPages(meta, ($, p) => {
    $('nav a, header a, footer a').each((_, a) => { if (linkTarget(p, $(a).attr('href')) === page) $(a).remove(); });
  });
  meta.updatedAt = new Date().toISOString(); meta.dirty = true;
  await store.writeMeta(meta.id, meta);
  res.json({ pages: meta.pages });
}));

// ---- photo library (Pixabay) ---------------------------------------------------------------
app.get('/api/images/status', requireAuth, (req, res) => res.json(bankStatus()));
app.get('/api/images/search', requireAuth, wrap(async (req, res) => {
  try {
    const orientation = ['horizontal', 'vertical', 'all'].includes(req.query.orientation) ? req.query.orientation : 'all';
    res.json({ results: await searchPhotos(String(req.query.q || ''), { orientation }) });
  } catch (e) { if (e instanceof ImageError) return res.status(400).json({ error: e.message }); throw e; }
}));

/** Put a library photo into the site. Body: { page, photo: {id, full, preview, tags, author, page} } */
app.post('/api/sites/:id/images/library', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  const page = String(req.body.page || 'index.html');
  const ph = req.body.photo || {};
  try {
    const saved = await importPhoto({ full: String(ph.full || ''), preview: String(ph.preview || '') }, path.join(store.draftDir(meta.id), 'ili-uploads'));
    meta.imageCredits = [...(meta.imageCredits || []), { file: 'ili-uploads/' + saved.name, source: 'pixabay', author: String(ph.author || '').slice(0, 80), page: String(ph.page || '').slice(0, 200) }].slice(-500);
    await store.writeMeta(meta.id, meta);
    res.json({ src: relFromPage(page, 'ili-uploads/' + saved.name), alt: String(ph.tags || '').split(',')[0].trim() });
  } catch (e) { if (e instanceof ImageError) return res.status(400).json({ error: e.message }); throw e; }
}));

/** Wren suggests a photo search for the selected image, from the page and the brief. Body: { page, id } */
app.post('/api/sites/:id/images/suggest', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  const page = String(req.body.page || 'index.html');
  if (!meta.pages.includes(page)) return res.status(404).json({ error: 'Page not found' });
  const html = await fs.readFile(store.safeJoin(store.draftDir(meta.id), page), 'utf8');
  let el; try { el = elementForAi(html, String(req.body.id || '')); } catch (e) { return res.status(400).json({ error: e.message }); }
  try {
    const { data } = await askJson({
      system: 'You choose stock photos for small business websites. Suggest search queries for a free photo library.',
      user: `Business brief: ${JSON.stringify(meta.brief || {})}\nPage text: ${el.context.slice(0, 1200)}\nThe image to replace: ${el.html.slice(0, 400)}\nReturn {"queries": ["2-4 English words", "...", "..."]} with 3 different concrete queries.`,
      mock: () => ({ queries: [`${meta.brief?.trade || 'business'} at work`, 'happy customer', 'tools'] }),
    });
    const queries = (Array.isArray(data.queries) ? data.queries : []).map((q) => String(q).slice(0, 60)).filter(Boolean).slice(0, 3);
    res.json({ queries });
  } catch (e) { if (e instanceof AiError) return res.status(502).json({ error: aiMsg(e, req.user) }); throw e; }
}));

// ---- themes ------------------------------------------------------------------------------------
app.get('/themes', requireAdmin, (req, res) => send(res, 'themes.html'));
app.get('/api/themes', requireAuth, wrap(async (req, res) => res.json((await listThemes({ includeHidden: req.query.all === '1' && req.user.role === 'admin' })).map(publicTheme))));
app.post('/api/themes', requireAdmin, upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a theme .zip file' });
  try { res.json(publicTheme(await installTheme(req.file.path, req.file.originalname))); }
  catch (e) { if (e instanceof ImportError) return res.status(400).json({ error: e.message }); throw e; }
  finally { fs.rm(req.file.path, { force: true }); }
}));
app.post('/api/themes/:id/restore', requireAdmin, wrap(async (req, res) => {
  try { await restoreTheme(req.params.id); res.json({ ok: true }); }
  catch (e) { if (e instanceof ImportError) return res.status(400).json({ error: e.message }); throw e; }
}));
app.delete('/api/themes/:id', requireAdmin, wrap(async (req, res) => {
  try { await removeTheme(req.params.id); res.json({ ok: true }); }
  catch (e) { if (e instanceof ImportError) return res.status(400).json({ error: e.message }); throw e; }
}));
// theme files for previews (public: themes are not secret), sandboxed like site content
app.get('/theme-files/:id/{*path}', wrap(async (req, res) => {
  const t = await getTheme(req.params.id);
  if (!t) return res.status(404).send('Not found');
  let file = store.safeJoin(t.dir, (req.params.path || []).join('/') || 'index.html');
  if (fss.existsSync(file) && fss.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fss.existsSync(file) || path.basename(file) === 'theme.json') return res.status(404).send('Not found');
  res.setHeader('Content-Security-Policy', SANDBOX); corsOk(res); res.setHeader('Cache-Control', 'public, max-age=300');
  res.sendFile(file);
}));

/** Create a site from a theme and personalise it from the brief (background job). Body: { theme, brief } */
app.post('/api/sites/from-theme', requireAuth, wrap(async (req, res) => {
  const theme = await getTheme(String(req.body.theme || ''));
  if (!theme || theme.hidden) return res.status(404).json({ error: 'Theme not found' });
  const brief = cleanBrief(req.body.brief);
  if (!brief.business || !brief.trade) return res.status(400).json({ error: 'Business name and trade are required' });
  const limit = await siteLimit(req.user);
  if (limit) return res.status(403).json({ error: limit, code: 'site_limit' });
  const id = store.newId();
  await fs.mkdir(store.draftDir(id), { recursive: true });
  await copyThemeTo(theme, store.draftDir(id));
  const palette = theme.palettes.find((p) => p.id === req.body.palette) || theme.palettes[0] || null;
  if (palette) await applyPalette(store.draftDir(id), theme.pages, palette);
  let slug = store.slugify(brief.business);
  for (let n = 2; await store.slugTaken(slug); n++) slug = `${store.slugify(brief.business)}-${n}`;
  const now = new Date().toISOString();
  const meta = { id, owner: req.user.id, name: brief.business, slug, pages: theme.pages, theme: { id: theme.id, version: theme.version }, palette: palette?.id || null, brief, createdAt: now, updatedAt: now, publishedAt: null, source: 'theme:' + theme.id, personalising: true };
  // the theme's own contact form becomes the Contact module, switched on with the theme's fields
  let themeForm = null;
  for (const p of theme.pages) {
    const f = store.safeJoin(store.draftDir(id), p);
    const r = adoptForms(await fs.readFile(f, 'utf8'));
    if (r) { await fs.writeFile(f, r.html); themeForm ||= r.form; }
  }
  meta.contact = contactFromTheme(brief, themeForm);
  await store.writeMeta(id, meta);

  const jobId = store.newId();
  const job = { status: 'working', site: id, owner: req.user.id, at: Date.now() };
  jobs.set(jobId, job);
  res.status(202).json({ id, job: jobId });

  (async () => {
    try {
      const out = await personalise(store.draftDir(id), theme.pages, brief, { log: (m) => console.log(`[theme] ${id} ${m}`) });
      const m = await store.readMeta(id);
      m.personalising = false; m.updatedAt = new Date().toISOString();
      m.imageCredits = out.credits;
      m.aiUsage = { calls: 1, input: out.usage?.input || 0, output: out.usage?.output || 0 };
      await store.writeMeta(id, m);
      Object.assign(job, { status: 'done', note: `${out.images} photos added` });
    } catch (e) {
      console.error('[theme] personalise failed:', e.message);
      // keep the site: the owner can still edit the theme by hand
      const m = await store.readMeta(id); m.personalising = false;
      for (const p of m.pages) { const f = store.safeJoin(store.draftDir(id), p); await fs.writeFile(f, tag(await fs.readFile(f, 'utf8'))); }
      await store.writeMeta(id, m);
      Object.assign(job, { status: 'error', error: aiMsg(e, req.user, 'Personalisation failed, the theme is ready to edit by hand.') });
    }
  })();
}));

app.get('/api/jobs/:job', requireAuth, (req, res) => {
  const job = jobs.get(req.params.job);
  if (!job || (job.owner !== req.user.id && req.user.role !== 'admin')) return res.status(404).json({ error: 'Unknown task' });
  res.json({ status: job.status, error: job.error, note: job.note, site: job.site });
});

// ---- publishing ----------------------------------------------------------------------------
const SUB_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
/** Is this free address available for this site? Returns an error message or null. */
async function addressProblem(sub, siteId) {
  if (!SUB_RE.test(sub)) return 'Use 3 to 40 letters, digits or dashes (no dash at the start or end).';
  if (RESERVED.has(sub) || /^xn--/.test(sub)) return 'This address is reserved. Try another one.';
  const taken = (await store.listSites()).some((s) => s.id !== siteId && (s.subdomain === sub || (!s.subdomain && s.publishedAt && s.slug === sub)));
  return taken ? 'This address is already taken. Try another one.' : null;
}
const freeUrl = (sub) => `https://${sub}.${FREE_DOMAIN}/`;
/** The address visitors use: the own domain once it is live, otherwise the free address. */
const siteUrl = (meta, sub = meta.subdomain || meta.slug) => (liveDomain(meta) ? `https://${liveDomain(meta)}/` : freeUrl(sub));

/** Which pages a plan publishes: the home page first, then the others in order, up to the plan limit. */
function publishable(meta, user) {
  const plan = user.role === 'admin' ? { pages: null } : planOf(user);
  const extra = meta.pages.filter((p) => /^thanks\.html?$/i.test(p)); // the form's thank-you page never counts as a page
  const ordered = ['index.html', ...meta.pages.filter((p) => p !== 'index.html' && !extra.includes(p))].filter((p) => meta.pages.includes(p));
  const live = [...(plan.pages ? ordered.slice(0, plan.pages) : ordered), ...extra];
  return { live, locked: ordered.filter((p) => !live.includes(p)) };
}

app.get('/api/sites/:id/address', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  const sub = store.slugify(String(req.query.sub ?? meta.subdomain ?? meta.slug)).slice(0, 40);
  const problem = await addressProblem(sub, meta.id);
  const { live, locked } = publishable(meta, req.user);
  res.json({ sub, ok: !problem, error: problem, url: freeUrl(sub), freeDomain: FREE_DOMAIN, current: meta.subdomain || null, live, locked, plan: req.user.role === 'admin' ? null : planOf(req.user) });
}));

app.post('/api/sites/:id/publish', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  const sub = store.slugify(String(req.body.sub ?? meta.subdomain ?? meta.slug)).slice(0, 40);
  const problem = await addressProblem(sub, meta.id);
  if (problem) return res.status(409).json({ error: problem });
  if (req.user.role !== 'admin') {
    const others = (await store.listSites()).filter((s) => s.owner === req.user.id && s.id !== meta.id && s.publishedAt).length;
    const maxLive = planOf(req.user).sites;
    if (others >= maxLive) return res.status(403).json({ error: `Your ${planOf(req.user).name} plan can have ${maxLive} published site${maxLive > 1 ? 's' : ''}. Unpublish the other one first, or choose a plan.`, code: 'publish_limit' });
  }
  const { live, locked } = publishable(meta, req.user);
  const ui = await uiOf(meta);
  const seo = [];
  const src = store.draftDir(meta.id);
  const tmp = store.publishedDir(meta.id) + '.tmp';
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.cp(src, tmp, { recursive: true });
  for (const page of meta.pages) {
    const f = store.safeJoin(tmp, page);
    if (!live.includes(page)) { await fs.rm(f, { force: true }); continue; }
    let html = strip(renderModules(await fs.readFile(f, 'utf8'), { contact: contactOf(meta), ui }));
    if (locked.length) html = unlinkPages(html, page, locked);
    html = prepareForms(html);
    if (req.user.role !== 'admin' && planOf(req.user).id === 'free') html = addBadge(html, sub);
    const s = seoPage(html, { site: meta, base: siteUrl(meta, sub), page });
    if (typeof s === 'object') { html = s.html; seo.push(s); }
    await fs.writeFile(f, html);
  }
  await seoFiles(tmp, siteUrl(meta, sub), seo);
  const publishedAt = new Date().toISOString();
  const oldSub = meta.publishedAt ? meta.subdomain || meta.slug : null;
  try { await pushSite(tmp, sub, meta, publishedAt); }
  catch (e) {
    await fs.rm(tmp, { recursive: true, force: true });
    console.error(`[publish] ${meta.id} → ili-sites failed:`, e.message);
    return res.status(502).json({ error: 'Publishing is not available right now. Your changes are saved, please try again in a minute.' });
  }
  if (oldSub && oldSub !== sub) removeSite(oldSub, meta.id).catch((e) => console.error(`[publish] old address ${oldSub}:`, e.message));
  await fs.rm(store.publishedDir(meta.id), { recursive: true, force: true });
  await fs.rename(tmp, store.publishedDir(meta.id));
  meta.publishedAt = publishedAt; meta.dirty = false;
  meta.subdomain = sub; meta.livePages = live;
  await store.writeMeta(meta.id, meta);
  invalidateSites();
  await versions.create(meta, { kind: 'publish', label: '', keep: keepVersions(req.user) }).catch((e) => console.error(`[versions] ${meta.id}:`, e.message));
  res.json({ ok: true, url: siteUrl(meta, sub), preview: `/s/${sub}/`, publishedAt: meta.publishedAt, live, locked });
}));

app.post('/api/sites/:id/unpublish', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  if (meta.publishedAt) {
    try { await removeSite(meta.subdomain || meta.slug, meta.id); }
    catch (e) { console.error(`[unpublish] ${meta.id}:`, e.message); return res.status(502).json({ error: 'Could not take the site offline right now. Please try again in a minute.' }); }
  }
  await fs.rm(store.publishedDir(meta.id), { recursive: true, force: true });
  meta.publishedAt = null; meta.livePages = [];
  await store.writeMeta(meta.id, meta);
  invalidateSites();
  res.json({ ok: true });
}));

// ---- own domain (paid plans) -----------------------------------------------------------------
// The client points their domain to us (A + www), we check the DNS, and once it is right the site answers on it.
const domainAllowed = (u) => u.role === 'admin' || !!planOf(u).customDomain;
/** The free domain can be registered here (paid plan, Blesta and the registrar set up, the admin registers in Blesta). */
const canRegister = (u) => u.role !== 'admin' && !!planOf(u).customDomain && billingEnabled() && registrarEnabled() && SITES_IPS.length > 0;
/** Write the DNS records of a domain we registered; remembered so the check retries it until it works. */
async function setupRegistered(meta) {
  const d = meta.domain;
  if (!d?.registered || d.dnsSet) return;
  try { await pointDomain(d.name, SITES_IPS[0], CNAME_TARGET); d.dnsSet = true; console.log(`[domains] DNS set for ${d.name}`); }
  catch (e) { console.error(`[domains] DNS for ${d.name} not set yet:`, e.message); }
}
async function domainInfo(meta, user, dnsNow = null) {
  const d = meta.domain || null;
  return {
    domain: d, allowed: domainAllowed(user), url: siteUrl(meta), published: !!meta.publishedAt, dirty: !!meta.dirty,
    records: d ? dnsRecords(d.name) : [], dns: dnsNow, ip: SITES_IPS[0] || null,
    register: { ready: canRegister(user), tlds: [...FREE_TLDS].sort((a, b) => ['.co.uk', '.uk', '.org.uk'].indexOf(a) - ['.co.uk', '.uk', '.org.uk'].indexOf(b)), used: user.freeDomain?.name || null, name: user.name || '' },
  };
}
/** Look at the DNS of one site's domain and switch it live (or back) when needed. Saves the meta. */
async function refreshDomain(meta, owner, { notify = true } = {}) {
  const d = meta.domain;
  if (!d) return null;
  await setupRegistered(meta);
  const was = d.status;
  let check = null;
  if (owner && !domainAllowed(owner)) d.status = 'paused';
  else {
    check = await checkDns(d.name);
    d.checkedAt = new Date().toISOString();
    if (check.ok) { d.status = 'live'; d.error = null; }
    else if (d.status !== 'live') { d.status = 'pending'; d.error = !check.apexOk ? 'domain' : 'www'; }
    // a live domain whose DNS moved away stays live: we never take a site offline because of a DNS hiccup
  }
  if (d.status !== was) {
    try { await setRemoteDomain(meta); }
    catch (e) { console.error(`[domains] ${d.name}:`, e.message); d.status = was; return check; }
    if (d.status === 'live') { d.liveAt = new Date().toISOString(); if (notify && owner) sendDomainLive(owner, meta, d.name); }
    if (meta.publishedAt) meta.dirty = true; // links for Google (canonical, sitemap) use the new address at the next publish
    console.log(`[domains] ${d.name} (${meta.id}): ${was} → ${d.status}`);
  }
  await store.writeMeta(meta.id, meta);
  invalidateSites();
  return check;
}
startDomainCheck(async () => {
  for (const s of await store.listSites()) {
    if (!s.domain || (s.domain.status === 'live' && (!s.domain.registered || s.domain.dnsSet) && domainAllowed(await users.get(s.owner) || { role: 'admin' }))) continue;
    const meta = await store.readMeta(s.id).catch(() => null);
    if (meta?.domain) await refreshDomain(meta, await users.get(meta.owner));
  }
});

// ---- the free domain of a paid plan: search, then register in the client's name ----------------
const PREFER = ['.co.uk', '.uk', '.org.uk'];
app.get('/api/domains/search', requireAuth, wrap(async (req, res) => {
  if (!canRegister(req.user)) return res.status(403).json({ error: 'Free domains come with every paid plan.' });
  if (req.user.freeDomain) return res.status(409).json({ error: `Your plan's free domain is ${req.user.freeDomain.name}.` });
  if (limit('dsearch:' + req.user.id, 40, 600000, 600000)) return res.status(429).json({ error: 'Too many searches. Try again in a few minutes.' });
  const label = String(req.query.q || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[./]/)[0].replace(/\s+/g, '').replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 63);
  if (label.length < 2) return res.status(400).json({ error: 'Type at least 2 letters or numbers.' });
  const rank = (t) => (PREFER.includes(t) ? PREFER.indexOf(t) : 99);
  const tlds = [...FREE_TLDS].sort((a, b) => rank(a) - rank(b));
  const used = new Set((await store.listSites()).map((s2) => s2.domain?.name).filter(Boolean));
  const results = await Promise.all(tlds.map(async (t) => {
    const name = label + t;
    return { name, tld: t, available: used.has(name) ? false : await isAvailable(name) };
  }));
  res.json({ label, results });
}));
app.post('/api/sites/:id/domain/register', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  const u = req.user;
  if (!canRegister(u)) return res.status(403).json({ error: 'Free domains come with every paid plan.' });
  if (u.freeDomain) return res.status(409).json({ error: `Your plan's free domain is already ${u.freeDomain.name}. You can connect it to this site instead.` });
  if (limit('dreg:' + u.id, 5, 3600000, 3600000)) return res.status(429).json({ error: 'Too many tries. Try again in an hour.' });
  const name = cleanDomainInput(req.body.domain);
  if (!name || !tldOf(name)) return res.status(400).json({ error: `Choose a name ending in ${FREE_TLDS.join(', ')}.` });
  const w = req.body.who || {};
  const t = (v, n = 120) => String(v ?? '').trim().slice(0, n);
  const who = {
    firstName: t(w.firstName, 60), lastName: t(w.lastName, 60), company: t(w.company), address1: t(w.address1), address2: t(w.address2),
    city: t(w.city, 60), postcode: t(w.postcode, 10).toUpperCase(), phone: t(w.phone, 20).replace(/[^\d+]/g, ''),
    type: ['IND', 'STRA', 'LTD'].includes(w.type) ? w.type : 'IND', companyNumber: t(w.companyNumber, 10).toUpperCase(),
  };
  const missing = [['firstName', 'first name'], ['lastName', 'last name'], ['address1', 'address'], ['city', 'town or city'], ['postcode', 'postcode'], ['phone', 'phone number']].filter(([k]) => !who[k]).map(([, l]) => l);
  if (missing.length) return res.status(400).json({ error: `Please fill in your ${missing.join(', ')}.` });
  if (!/^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/.test(who.postcode)) return res.status(400).json({ error: 'This does not look like a UK postcode.' });
  if (who.phone.replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'Please check your phone number.' });
  if (who.type === 'LTD' && !/^[A-Z0-9]{8}$/.test(who.companyNumber)) return res.status(400).json({ error: 'Your company number has 8 characters, like 01234567 or SC123456.' });
  if ((who.type === 'LTD' || who.type === 'STRA') && !who.company) return res.status(400).json({ error: 'Please give the name of your business.' });
  if ((await store.listSites()).some((s2) => s2.domain?.name === name)) return res.status(409).json({ error: 'This domain is already used by another website.' });
  if ((await isAvailable(name)) !== true) return res.status(409).json({ error: `${name} is not available. Try another name.` });
  try { await registerDomain(u, name, who, NAMESERVERS); }
  catch (e) { return res.status(e instanceof BillingError ? 400 : 502).json({ error: e instanceof BillingError ? e.message : 'Registration is not available right now. Please try again in a few minutes.' }); }
  if (liveDomain(meta)) { meta.domain.status = 'pending'; await setRemoteDomain(meta).catch(() => {}); }
  meta.domain = { name, status: 'pending', registered: true, dnsSet: false, addedAt: new Date().toISOString(), checkedAt: null, error: null };
  const check = await refreshDomain(meta, u);
  res.json(await domainInfo(meta, u, check));
}));

app.get('/api/sites/:id/domain', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  res.json(await domainInfo(meta, req.user, meta.domain ? await checkDns(meta.domain.name) : null));
}));
app.post('/api/sites/:id/domain', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  if (!domainAllowed(req.user)) return res.status(403).json({ error: 'Your own domain comes with every paid plan.', code: 'plan' });
  const name = cleanDomainInput(req.body.domain);
  if (!name) return res.status(400).json({ error: 'This does not look like a domain name. Type it like yourbusiness.co.uk' });
  const taken = (await store.listSites()).find((s) => s.id !== meta.id && s.domain?.name === name);
  if (taken) return res.status(409).json({ error: 'This domain is already used by another website.' });
  if (meta.domain?.name !== name) {
    if (liveDomain(meta)) { meta.domain.status = 'pending'; await setRemoteDomain(meta).catch(() => {}); }
    meta.domain = { name, status: 'pending', addedAt: new Date().toISOString(), checkedAt: null, error: null };
  }
  const check = await refreshDomain(meta, req.user);
  res.json(await domainInfo(meta, req.user, check));
}));
app.post('/api/sites/:id/domain/check', requireAuth, wrap(async (req, res) => {
  if (limit('dns:' + req.user.id, 30, 600000, 600000)) return res.status(429).json({ error: 'Too many checks. Try again in a few minutes.' });
  const meta = await siteFor(req);
  if (!meta.domain) return res.status(404).json({ error: 'No domain on this site' });
  const check = await refreshDomain(meta, req.user);
  res.json(await domainInfo(meta, req.user, check));
}));
app.delete('/api/sites/:id/domain', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  if (meta.domain) {
    const had = liveDomain(meta);
    meta.domain = null;
    if (had) {
      if (meta.publishedAt) meta.dirty = true;
      try { await setRemoteDomain(meta); }
      catch (e) { console.error('[domains] remove:', e.message); return res.status(502).json({ error: 'Could not remove the domain right now. Please try again in a minute.' }); }
    }
    await store.writeMeta(meta.id, meta);
    invalidateSites();
  }
  res.json(await domainInfo(meta, req.user));
}));

// ---- versions: go back to an earlier state, download the site --------------------------------
const keepVersions = (u) => (u.role === 'admin' ? 30 : planOf(u).versions || 1);
const zipName = (meta, extra = '') => `${store.slugify(meta.name || meta.slug)}${extra}.zip`;
app.get('/api/sites/:id/versions', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  res.json({ versions: await versions.list(meta.id), keep: keepVersions(req.user), plan: req.user.role === 'admin' ? null : planOf(req.user).name });
}));
app.post('/api/sites/:id/versions', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  res.json(await versions.create(meta, { kind: 'manual', label: req.body.label, keep: keepVersions(req.user) }));
}));
app.post('/api/sites/:id/versions/:vid/restore', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  const v = await versions.restore(meta, req.params.vid, keepVersions(req.user));
  if (!v) return res.status(404).json({ error: 'This version no longer exists' });
  const m = await store.readMeta(meta.id);
  m.pages = v.pages; m.dirty = true; m.updatedAt = new Date().toISOString();
  await store.writeMeta(meta.id, m);
  res.json({ ok: true, pages: m.pages });
}));
app.delete('/api/sites/:id/versions/:vid', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  res.status((await versions.remove(meta.id, req.params.vid)) ? 200 : 404).json({ ok: true });
}));
app.get('/api/sites/:id/versions/:vid/download', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  const r = await versions.zipVersion(meta.id, req.params.vid);
  if (!r) return res.status(404).json({ error: 'This version no longer exists' });
  res.attachment(zipName(meta, '-' + r.v.at.slice(0, 10))).type('application/zip').send(r.zip);
}));
/** The client's site as it is now in the editor, as clean HTML files they can host anywhere (data portability). */
app.get('/api/sites/:id/download', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  res.attachment(zipName(meta)).type('application/zip').send(await versions.zipFolder(store.draftDir(meta.id)));
}));

/** Free sites carry a small "Made with ili studio by Ilidweb" bar at the very bottom (removed on paid plans). */
function addBadge(html, sub) {
  const badge = `<div id="ili-badge" style="all:initial;display:block;background:#0D1221;text-align:center;padding:10px 16px;font:500 13px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif">`
    + `<a href="https://ilidweb.uk/ili-studio/?utm_source=free-site&amp;utm_medium=badge&amp;utm_campaign=${encodeURIComponent(sub)}" target="_blank" rel="noopener" `
    + `style="all:initial;cursor:pointer;color:#F6F7F9;font:500 13px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;text-decoration:none">`
    + `Website made with <b style="all:initial;color:#C8F031;font:700 13px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif">ili studio</b> by Ilidweb · Create yours for free →</a></div>`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, badge + '</body>') : html + badge;
}

/** Remove links to pages that are not published (their menu entries disappear instead of leading to a 404). */
function unlinkPages(html, page, locked) {
  const $ = cheerio.load(html);
  const dir = path.posix.dirname('/' + page);
  $('a[href]').each((_, a) => {
    const href = String($(a).attr('href') || '').split('#')[0].split('?')[0];
    if (!href || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) return;
    const target = path.posix.normalize(href.startsWith('/') ? href : path.posix.join(dir, href)).replace(/^\//, '').replace(/\/$/, '/index.html') || 'index.html';
    const file = /\.html?$/i.test(target) ? target : `${target}.html`;
    if (!locked.includes(file)) return;
    const li = $(a).parent('li');
    if (li.length && li.children().length === 1) li.remove(); else $(a).remove();
  });
  return $.html();
}

// ---- editor frame: draft files with the editor script (token-protected, sandboxed) ------
app.get('/frame/:id/:token/{*path}', wrap(async (req, res) => {
  const { id, token } = req.params;
  if (!checkFrameToken(id, token)) return res.status(403).send('Forbidden');
  const base = store.draftDir(id);
  let file = store.safeJoin(base, (req.params.path || []).join('/') || 'index.html');
  if (fss.existsSync(file) && fss.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fss.existsSync(file)) return res.status(404).send('Not found');
  res.setHeader('Content-Security-Policy', SANDBOX);
  res.setHeader('Cache-Control', 'no-store');
  corsOk(res);
  if (/\.html?$/i.test(file)) {
    const meta = await store.readMeta(id).catch(() => null);
    let html = await fs.readFile(file, 'utf8');
    if (meta) html = renderModules(html, { contact: contactOf(meta), ui: await uiOf(meta), preview: true });
    return res.type('html').send(injectEditor(html, VERSION));
  }
  res.sendFile(file);
}));

// ---- published sites ---------------------------------------------------------------
// published sites by address, kept in memory (rebuilt at most every 15 s, or right after a publish)
let siteIndex = { at: 0, map: new Map() };
export function invalidateSites() { siteIndex.at = 0; }
async function publishedSite(sub) {
  if (Date.now() - siteIndex.at > 15000) {
    const map = new Map();
    for (const s of await store.listSites()) if (s.publishedAt) map.set(s.subdomain || s.slug, s);
    siteIndex = { at: Date.now(), map };
  }
  return siteIndex.map.get(sub) || null;
}
async function serveSite(sub, parts, res, req = null) {
  const site = await publishedSite(sub);
  if (!site) return res.status(404).send('Site not found');
  const base = store.publishedDir(site.id);
  let file = store.safeJoin(base, (parts || []).join('/') || 'index.html');
  if (fss.existsSync(file) && fss.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fss.existsSync(file) && fss.existsSync(file + '.html')) file += '.html';
  if (!fss.existsSync(file)) return res.status(404).send('Page not found');
  res.setHeader('Content-Security-Policy', SANDBOX);
  // pages are always fresh; images, styles and fonts are kept by the browser for a day
  res.setHeader('Cache-Control', /\.html?$/i.test(file) ? 'no-cache' : 'public, max-age=86400');
  corsOk(res);
  if (req && localStats && req.method === 'GET' && /\.html?$/i.test(file)) localStats.record(site, req, path.relative(base, file), clientIp(req));
  res.sendFile(file);
}
// ---- visitor statistics ---------------------------------------------------------------------------
// Counted where the sites are served: on ili-sites, or here when ili studio serves them itself.
const localStats = remote() ? null : createStats(store.DATA_DIR);
if (localStats) startGeo(store.DATA_DIR);
const statsDaysOf = (u) => (u.role === 'admin' ? 730 : planOf(u).statsDays || 30);
const getStats = (id, days) => (localStats ? (id ? localStats.query(id, days) : allLocal(days)) : remoteStats(id, days));
async function allLocal(days) {
  const sites = {};
  for (const id of await localStats.ids()) { const q = await localStats.query(id, days); if (q.views) sites[id] = q; }
  return { sites };
}
/** Contact-form messages per day for the given sites (spam left out). */
async function messagesPerDay(siteIds, from) {
  const per = {};
  for (const m of await listMessages(siteIds)) if (!m.spam && m.at.slice(0, 10) >= from) per[m.at.slice(0, 10)] = (per[m.at.slice(0, 10)] || 0) + 1;
  return per;
}
function shape(q, msgs, days) {
  const prevWindow = q.days.slice(0, q.days.length - days), cur = q.days.slice(-days);
  const sum = (arr, k) => arr.reduce((n, d) => n + d[k], 0);
  const messages = cur.reduce((n, d) => n + (msgs[d.date] || 0), 0);
  const prevMessages = prevWindow.reduce((n, d) => n + (msgs[d.date] || 0), 0);
  return {
    days: cur.map((d) => ({ ...d, messages: msgs[d.date] || 0 })),
    totals: { visitors: sum(cur, 'visitors'), views: sum(cur, 'views'), messages },
    previous: prevWindow.length === days ? { visitors: sum(prevWindow, 'visitors'), views: sum(prevWindow, 'views'), messages: prevMessages } : null,
    pages: top(q.pages, 10), sources: top(q.sources, 8), countries: top(q.countries, 8), devices: top(q.devices, 3),
  };
}
const RANGES = [7, 30, 90, 180, 365, 730];
app.get('/stats', requireAuth, (req, res) => send(res, 'stats.html'));
app.get('/api/sites/:id/stats', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  const max = statsDaysOf(req.user);
  const days = Math.min(max, RANGES.includes(+req.query.days) ? +req.query.days : 30);
  const wantPrev = days * 2 <= max;
  let q;
  try { q = await getStats(meta.id, wantPrev ? days * 2 : days); }
  catch (e) { console.error('[stats]', e.message); return res.status(502).json({ error: 'Statistics are not available right now. Please try again in a minute.' }); }
  const msgs = await messagesPerDay([meta.id], q.days[0]?.date || '');
  res.json({ ...shape(q, msgs, days), range: days, max, ranges: RANGES.filter((r) => r <= max), plan: req.user.role === 'admin' ? null : planOf(req.user).name, live: !!meta.publishedAt });
}));
// Admin: every site together, and which sites get the most visitors.
app.get('/api/admin/stats', requireAdmin, wrap(async (req, res) => {
  const days = RANGES.includes(+req.query.days) ? +req.query.days : 30;
  let all;
  try { all = await getStats(null, days * 2); }
  catch (e) { console.error('[stats]', e.message); return res.status(502).json({ error: 'Statistics are not available right now.' }); }
  const sites = await store.listSites();
  const byId = new Map(sites.map((s) => [s.id, s]));
  const owners = new Map((await users.list()).map((u) => [u.id, u.email]));
  const merged = { days: [], pages: {}, sources: {}, countries: {}, devices: {} };
  const ranking = [];
  for (const [id, q] of Object.entries(all.sites || {})) {
    q.days.forEach((d, i) => { const m = merged.days[i] || (merged.days[i] = { date: d.date, views: 0, visitors: 0 }); m.views += d.views; m.visitors += d.visitors; });
    for (const k of ['sources', 'countries', 'devices']) for (const [n, c] of Object.entries(q[k])) merged[k][n] = (merged[k][n] || 0) + c;
    const cur = q.days.slice(-days);
    const s = byId.get(id);
    ranking.push({ id, name: s?.name || '(deleted site)', owner: s ? owners.get(s.owner) || '' : '', address: s?.publishedAt ? `${s.subdomain || s.slug}.${FREE_DOMAIN}` : null, visitors: cur.reduce((n, d) => n + d.visitors, 0), views: cur.reduce((n, d) => n + d.views, 0) });
  }
  if (!merged.days.length) for (let i = days * 2 - 1; i >= 0; i--) merged.days.push({ date: new Date(Date.now() - i * 86400000).toISOString().slice(0, 10), views: 0, visitors: 0 });
  const msgs = await messagesPerDay(sites.map((s) => s.id), merged.days[0].date);
  ranking.sort((a, b) => b.visitors - a.visitors);
  res.json({ ...shape(merged, msgs, days), pages: [], sites: ranking.filter((r) => r.views).slice(0, 50), range: days, max: 730, ranges: RANGES, all: true });
}));

// ---- SEO tool: audits of ili studio sites and of any public website -------------------------------
const SEO_DIR = path.join(store.DATA_DIR, 'seo');
const extFile = (uid) => path.join(SEO_DIR, 'external', `${uid}.json`);
const auditFile = (key) => path.join(SEO_DIR, 'audits', `${key.replace(/[^\w-]/g, '')}.json`);
const readJson = async (f, d) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return d; } };
const writeJson = async (f, v) => { await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f + '.tmp', JSON.stringify(v)); await fs.rename(f + '.tmp', f); };
const extLimit = (u) => (u.role === 'admin' ? 100 : u.plan === 'free' ? 1 : 5);
const auditing = new Map(); // key -> started at

app.get('/seo', requireAuth, (req, res) => send(res, 'seo.html'));
app.get('/api/seo', requireAuth, wrap(async (req, res) => {
  const sites = (await store.listSites()).filter((s) => req.user.role === 'admin' || s.owner === req.user.id);
  const ext = await readJson(extFile(req.user.id), []);
  const sum = async (key) => { const a = await readJson(auditFile(key), null); return a ? { at: a.at, score: a.score, counts: a.counts } : null; };
  res.json({
    sites: await Promise.all(sites.map(async (s) => ({ id: s.id, name: s.name, publishedAt: s.publishedAt, subdomain: s.subdomain || null, pages: s.pages.length, audit: await sum('s-' + s.id) }))),
    external: await Promise.all(ext.map(async (e) => ({ ...e, audit: await sum('x-' + e.id) }))),
    limit: extLimit(req.user),
  });
}));
app.post('/api/seo/external', requireAuth, wrap(async (req, res) => {
  let raw = String(req.body.url || '').trim();
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  let u; try { u = new URL(raw); } catch { return res.status(400).json({ error: 'Enter a website address, like yourbusiness.co.uk' }); }
  if (!/^https?:$/.test(u.protocol) || !/\.[a-z]{2,}$/i.test(u.hostname)) return res.status(400).json({ error: 'Enter a website address, like yourbusiness.co.uk' });
  const list = await readJson(extFile(req.user.id), []);
  if (list.some((e) => new URL(e.url).hostname === u.hostname)) return res.status(409).json({ error: 'This website is already in your list.' });
  if (list.length >= extLimit(req.user)) return res.status(403).json({ error: req.user.plan === 'free' ? 'The Free plan can check 1 other website. Choose a plan to check more.' : 'You have reached the number of websites you can check.', code: 'ext_limit' });
  const item = { id: store.newId(), url: u.origin + (u.pathname === '/' ? '/' : u.pathname), host: u.hostname, addedAt: new Date().toISOString() };
  list.push(item); await writeJson(extFile(req.user.id), list);
  res.json(item);
}));
app.delete('/api/seo/external/:id', requireAuth, wrap(async (req, res) => {
  const list = (await readJson(extFile(req.user.id), [])).filter((e) => e.id !== req.params.id);
  await writeJson(extFile(req.user.id), list);
  await fs.rm(auditFile('x-' + req.params.id), { force: true });
  res.json({ ok: true });
}));
app.get('/api/seo/audit/:kind/:id', requireAuth, wrap(async (req, res) => {
  const key = await auditKey(req);
  res.json(await readJson(auditFile(key), null));
}));
async function auditKey(req) {
  if (req.params.kind === 'site') { await siteFor(req, req.params.id); return 's-' + req.params.id; }
  const list = await readJson(extFile(req.user.id), []);
  if (!list.some((e) => e.id === req.params.id)) throw new HttpError(404, 'Website not found');
  return 'x-' + req.params.id;
}
/** Audit of an ili studio site: its draft pages (what will be published). */
async function auditSite(meta, withSpeed) {
  const pages = [];
  for (const p of meta.pages) {
    const html = await fs.readFile(store.safeJoin(store.draftDir(meta.id), p), 'utf8').catch(() => null);
    if (html) pages.push({ path: p, url: p, html });
  }
  const speed = withSpeed && meta.publishedAt && meta.subdomain ? await pagespeed(freeUrl(meta.subdomain)) : null;
  return { ...analyse(pages, { kind: 'ili', auto: true, speed }), speed };
}
app.post('/api/seo/audit/:kind/:id', requireAuth, wrap(async (req, res) => {
  const key = await auditKey(req);
  const last = auditing.get(key);
  if (last && Date.now() - last < 30000) return res.status(429).json({ error: 'An audit is already running for this website. Try again in a moment.' });
  auditing.set(key, Date.now());
  try {
    let out;
    if (req.params.kind === 'site') {
      const meta = await siteFor(req, req.params.id);
      out = { kind: 'site', name: meta.name, ...(await auditSite(meta, true)) };
    } else {
      const item = (await readJson(extFile(req.user.id), [])).find((e) => e.id === req.params.id);
      const c = await crawl(item.url, req.user.plan === 'free' ? 5 : 20);
      const speed = await pagespeed(c.pages[0]?.url || item.url);
      out = { kind: 'external', name: item.host, url: item.url, ...analyse(c.pages, { kind: 'external', https: c.https, robots: c.robots, sitemap: c.sitemap, statuses: c.statuses, speed }), speed };
    }
    out.at = new Date().toISOString();
    await writeJson(auditFile(key), out);
    res.json(out);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.warn('[seo] audit failed:', e.message);
    res.status(400).json({ error: e.message || 'The audit failed. Try again.' });
  } finally { auditing.delete(key); }
}));
/** Quick score for the publish dialog (no speed test). */
app.get('/api/sites/:id/seo-score', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  const a = await auditSite(meta, false);
  res.json({ score: a.score, counts: a.counts, top: a.issues.slice(0, 3).map((i) => i.title) });
}));
/** Set a page's title and description (ili studio sites). */
app.post('/api/sites/:id/seo-meta', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  const page = String(req.body.page || '');
  if (!meta.pages.includes(page)) return res.status(404).json({ error: 'Page not found' });
  const title = String(req.body.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 90);
  const description = String(req.body.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!title) return res.status(400).json({ error: 'The title cannot be empty' });
  const f = store.safeJoin(store.draftDir(meta.id), page);
  const before = await fs.readFile(f, 'utf8');
  const $ = cheerio.load(before);
  if (!$('head title').length) $('head').append('<title></title>');
  $('head title').first().text(title);
  let m = $('head meta[name="description"]');
  if (!m.length) { m = $('<meta name="description">'); $('head').append(m); }
  m.attr('content', description);
  await store.pushHistory(meta.id, page, before);
  await fs.writeFile(f, $.html());
  meta.dirty = true; meta.updatedAt = new Date().toISOString();
  await store.writeMeta(meta.id, meta);
  res.json({ ok: true, title, description });
}));
/** Wren writes a title and description for a page (1 AI credit). */
app.post('/api/sites/:id/seo-write', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  const page = String(req.body.page || '');
  if (!meta.pages.includes(page)) return res.status(404).json({ error: 'Page not found' });
  if (!users.canSpend(req.user, 1)) return res.status(402).json({ error: 'You have used all your AI credits.', code: 'no_credits' });
  const $ = cheerio.load(await fs.readFile(store.safeJoin(store.draftDir(meta.id), page), 'utf8'));
  $('script, style, noscript').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 3000);
  const b = meta.brief || {};
  try {
    const { data } = await askJson({
      system: 'You are an SEO copywriter for small UK businesses. British English. Write a page title (50-60 characters: main service + town + business name) and a meta description (130-155 characters, specific, with a call to action). Never invent facts, prices, awards or reviews.',
      user: `Business: ${b.business || meta.name}\nTrade: ${b.trade || ''}\nTown/area: ${b.town || ''}\nServices: ${b.services || ''}\nPage file: ${page}\nPage text:\n${text}\n\nReturn {"title": "...", "description": "..."}`,
      mock: () => ({ title: `${b.trade || 'Services'} in ${b.town || 'your area'} | ${b.business || meta.name}`.slice(0, 60), description: `${b.business || meta.name}: ${b.services || b.trade || 'local services'}${b.town ? ' in ' + b.town : ''}. Get in touch today for a free quote.`.slice(0, 155) }),
    });
    const payer = await users.spend(req.user.id, 1);
    res.json({ title: String(data.title || '').slice(0, 90), description: String(data.description || '').slice(0, 200), credits: payer?.role === 'admin' ? null : payer?.credits });
  } catch (e) { res.status(400).json({ error: aiMsg(e, req.user, 'Wren could not write this. Try again.') }); }
}));

// ---- modules ------------------------------------------------------------------------------------
/** The theme's own class names for buttons, forms and sections (theme.json "ui"), so modules look native. */
async function uiOf(meta) {
  if (!meta?.theme?.id) return {};
  const t = await getTheme(meta.theme.id).catch(() => null);
  return t?.ui && typeof t.ui === 'object' ? t.ui : {};
}
const planRank = { free: 0, essential: 1, plus: 2, pro: 3 };
app.get('/api/sites/:id/modules', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  const plan = req.user.role === 'admin' ? 'pro' : planOf(req.user).id;
  const on = { contact: [], reviews: [] };
  for (const p of meta.pages) {
    const html = await fs.readFile(store.safeJoin(store.draftDir(meta.id), p), 'utf8').catch(() => '');
    if (/data-ili-module="contact"|data-ili-form=/.test(html)) on.contact.push(p);
    if (hasReviewsBlock(html)) on.reviews.push(p);
  }
  res.json({
    modules: MODULES.map((m) => ({ ...m, allowed: planRank[plan] >= planRank[m.plan], pages: on[m.id] || [] })),
    contact: contactOf(meta), ownerEmail: req.user.email, themeLook: (await uiOf(meta)).contactLook || 'buttons',
    legacyForm: on.contact.length > 0 && !(await Promise.all(on.contact.map(async (p) => /data-ili-module="contact"/.test(await fs.readFile(store.safeJoin(store.draftDir(meta.id), p), 'utf8'))))).some(Boolean),
  });
}));
app.post('/api/sites/:id/contact', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  let c;
  try { c = keepVerified(cleanContact(req.body, req.user.email), meta.contact); } catch (e) { return res.status(400).json({ error: e.message }); }
  const known = new Set((meta.contact?.recipients || []).map((r) => r.email));
  for (const r of c.recipients) if (!r.verified && !known.has(r.email)) sendRecipientConfirm(meta, r.email, req.user);
  const m = await store.readMeta(meta.id);
  m.contact = c; m.updatedAt = new Date().toISOString(); if (m.publishedAt) m.dirty = true;
  await store.writeMeta(meta.id, m);
  invalidateSites();
  res.json({ ok: true, contact: c });
}));
/** Turn the theme's own contact forms into the Contact module, keeping their fields (sites made before modules). */
app.post('/api/sites/:id/modules/adopt', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  let form = null, changed = 0;
  for (const p of meta.pages) {
    const f = store.safeJoin(store.draftDir(meta.id), p);
    const before = await fs.readFile(f, 'utf8');
    const r = adoptForms(before);
    if (!r) continue;
    await store.pushHistory(meta.id, p, before);
    await fs.writeFile(f, tag(r.html)); changed++;
    form ||= r.form;
  }
  if (!changed) return res.status(400).json({ error: 'No theme form found on your pages' });
  const m = await store.readMeta(meta.id);
  if (!m.contact) m.contact = contactFromTheme(m.brief, form);
  m.updatedAt = new Date().toISOString(); m.dirty = true;
  await store.writeMeta(meta.id, m);
  res.json({ ok: true, pages: changed });
}));

/** Add a module section to a page, after the selected element's section, or before the footer. Body: { type, page, after } */
app.post('/api/sites/:id/modules/add', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  const page = String(req.body.page || 'index.html');
  if (!meta.pages.includes(page)) return res.status(404).json({ error: 'Page not found' });
  const mod = MODULES.find((x) => x.id === req.body.type);
  if (!mod || !mod.ready) return res.status(400).json({ error: 'This module is not available yet' });
  const plan = req.user.role === 'admin' ? 'pro' : planOf(req.user).id;
  if (planRank[plan] < planRank[mod.plan]) return res.status(403).json({ error: `${mod.name} comes with the ${mod.plan[0].toUpperCase() + mod.plan.slice(1)} plan.`, code: 'plan' });
  const f = store.safeJoin(store.draftDir(meta.id), page);
  const before = await fs.readFile(f, 'utf8');
  const $ = cheerio.load(before);
  const block = sectionHtml(mod.id, await uiOf(meta));
  const after = String(req.body.after || '');
  let anchor = after && /^[\w-]{1,40}$/.test(after) ? $(`[${ID_ATTR}="${after}"]`).first() : null;
  if (anchor?.length) { while (anchor.parent().length && !['body', 'main'].includes(anchor.parent()[0].tagName)) anchor = anchor.parent(); anchor.after(block); }
  else if ($('body > footer, main + footer').last().length) $('body > footer, main + footer').last().before(block);
  else ($('main').length ? $('main') : $('body')).append(block);
  let html = $.html();
  if (mod.id === 'reviews' && meta.reviews) html = renderReviews(html, meta.reviews);
  await store.pushHistory(meta.id, page, before);
  await fs.writeFile(f, tag(html));
  const m = await store.readMeta(meta.id);
  m.updatedAt = new Date().toISOString(); m.dirty = true;
  if (mod.id === 'contact' && !m.contact) m.contact = contactDefaults(m.brief);
  await store.writeMeta(meta.id, m);
  res.json({ ok: true, undo: await store.historyCount(meta.id, page) });
}));

// ---- reviews -----------------------------------------------------------------------------------
app.get('/api/sites/:id/reviews', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  const pages = [];
  for (const p of meta.pages) { if (hasReviewsBlock(await fs.readFile(store.safeJoin(store.draftDir(meta.id), p), 'utf8').catch(() => ''))) pages.push(p); }
  res.json({ reviews: meta.reviews || null, pages, platforms: Object.fromEntries(Object.entries(PLATFORMS).map(([k, v]) => [k, v.name])) });
}));
app.post('/api/sites/:id/reviews', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  let rv;
  try { rv = cleanReviews(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
  let changed = 0;
  for (const p of meta.pages) {
    const f = store.safeJoin(store.draftDir(meta.id), p);
    const before = await fs.readFile(f, 'utf8');
    const after = tag(renderReviews(before, rv));
    if (after !== before) { await store.pushHistory(meta.id, p, before); await fs.writeFile(f, after); changed++; }
  }
  const m = await store.readMeta(meta.id);
  m.reviews = rv; m.updatedAt = new Date().toISOString(); if (changed) m.dirty = true;
  await store.writeMeta(meta.id, m);
  res.json({ ok: true, reviews: rv, pages: changed });
}));

// ---- contact forms ---------------------------------------------------------------------------
/** Keep a form message and e-mail the owner. Returns what to show the visitor: { status, html } or { redirect }. */
async function processForm(site, body, ip) {
  let r;
  const contact = site.contact || null;
  const def = body?._m === 'contact' && contact?.form?.on ? contact.form.fields : null;
  try { r = await receive(site, body, ip, def); }
  catch (e) { return { status: 400, html: thanksPage(site, e.message) }; }
  if (!r.spam) {
    const owner = site.owner ? await users.get(site.owner) : null;
    // the account address, plus any extra address the owner added and confirmed
    const extra = (contact?.recipients || []).filter((x) => x.verified).map((x) => x.email);
    const to = [owner && owner.role !== 'admin' ? owner.email : process.env.ADMIN_NOTIFY_EMAIL, ...extra].filter(Boolean).join(', ');
    if (to) {
      const f = r.message.fields;
      sendMail({ to, subject: `New message from your website${f.name ? ': ' + f.name.slice(0, 60) : ''}`, text: emailText(site, r.message, process.env.APP_URL), replyTo: f.email })
        .then((sent) => { if (sent) console.log(`[form] ${site.id} message e-mailed to owner`); })
        .catch((e) => console.error(`[form] ${site.id} e-mail failed:`, e.message));
    }
  } else console.warn(`[form] ${site.id} spam ignored`);
  if (fss.existsSync(path.join(store.publishedDir(site.id), 'thanks.html'))) return { redirect: 'thanks.html' };
  return { status: 200, html: thanksPage(site) };
}
async function handleForm(sub, req, res) {
  const site = await publishedSite(sub);
  res.setHeader('Content-Security-Policy', SANDBOX);
  if (!site) return res.status(404).send('Site not found');
  const r = await processForm(site, req.body, clientIp(req));
  if (r.redirect) return res.redirect(303, r.redirect);
  res.status(r.status).type('html').send(r.html);
}
// ili-sites passes the forms of the sites it serves to this endpoint (authenticated with SITES_SECRET).
app.post('/_internal/form', wrap(async (req, res) => {
  const secret = internalSecret();
  const got = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''));
  if (!secret || got.length !== secret.length || !crypto.timingSafeEqual(got, Buffer.from(secret))) return res.status(404).send('Not found');
  const { sub, id, ip, body } = req.body || {};
  const site = await publishedSite(String(sub || ''));
  if (!site || site.id !== id) return res.status(404).json({ status: 404, html: 'Site not found' });
  res.json(await processForm(site, body && typeof body === 'object' ? body : {}, String(ip || '')));
}));
app.post('/s/:slug/_form', wrap(async (req, res) => handleForm(req.params.slug, req, res)));

app.get('/messages', requireAuth, (req, res) => send(res, 'messages.html'));
app.get('/api/messages', requireAuth, wrap(async (req, res) => {
  const sites = (await store.listSites()).filter((s) => req.user.role === 'admin' || s.owner === req.user.id);
  const names = new Map(sites.map((s) => [s.id, s.name]));
  const list = await listMessages(sites.map((s) => s.id));
  res.json({ mail: mailEnabled(), email: req.user.role === 'admin' ? process.env.ADMIN_NOTIFY_EMAIL || null : req.user.email, messages: list.map((m) => ({ ...m, siteName: names.get(m.site) })) });
}));
app.patch('/api/messages/:id/:msg', requireAuth, wrap(async (req, res) => {
  await siteFor(req);
  try { res.json(await updateMessage(req.params.id, req.params.msg, { read: !!req.body.read })); } catch { res.status(404).json({ error: 'Message not found' }); }
}));
app.delete('/api/messages/:id/:msg', requireAuth, wrap(async (req, res) => {
  await siteFor(req);
  try { await deleteMessage(req.params.id, req.params.msg); res.json({ ok: true }); } catch { res.status(404).json({ error: 'Message not found' }); }
}));

app.get('/s/:slug', (req, res, next) => (req.originalUrl.endsWith('/') ? next() : res.redirect(301, `/s/${req.params.slug}/`)));
app.get('/s/:slug/{*path}', wrap(async (req, res) => serveSite(req.params.slug, req.params.path, res)));

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong' });
});

await store.init();
startSync();
startCleanup();
startBillingSync();
app.listen(PORT, () => console.log(`ili studio running on http://localhost:${PORT} (data: ${store.DATA_DIR})`));
