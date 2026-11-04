// ili studio prototype server.
import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import { importUpload, ImportError } from './importer.js';
import { tag } from './html.js';
import * as cheerio from 'cheerio';
import { applyOps, injectEditor, strip, title, elementForAi, STYLE_OK } from './html.js';
import { wren, aiStatus, AiError, ping, askJson } from './ai.js';
import { searchPhotos, importPhoto, saveImage, bankStatus, ImageError } from './images.js';
import { listThemes, getTheme, publicTheme, installTheme, removeTheme, restoreTheme, copyThemeTo, applyPalette } from './themes.js';
import { personalise, cleanBrief } from './personalise.js';
import { requireAuth, requireAdmin, login, signup, logout, currentUser, frameToken, checkFrameToken } from './auth.js';
import * as users from './users.js';
import { PLANS, planOf, COSTS, FREE_DOMAIN, RESERVED } from './plans.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 3000);

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
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
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).send('Method not allowed');
  const sub = host.slice(0, -FREE_DOMAIN.length - 1);
  const parts = decodeURIComponent(req.path).split('/').filter(Boolean);
  serveSite(sub, parts, res).catch(next);
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
  if (r.ok) return res.redirect('/');
  res.redirect('/login?error=' + encodeURIComponent(r.error) + '&email=' + encodeURIComponent(String(req.body.email || '').slice(0, 120)));
}));
app.post('/signup', wrap(async (req, res) => {
  const r = await signup(req, res, { email: req.body.email, password: req.body.password, name: req.body.name });
  if (r.ok) return res.redirect('/welcome');
  res.redirect('/signup?error=' + encodeURIComponent(r.error) + '&email=' + encodeURIComponent(String(req.body.email || '').slice(0, 120)));
}));
app.post('/logout', (req, res) => { logout(res); res.redirect('/login'); });

// ---- account, plans and credits --------------------------------------------------------
app.get('/api/plans', (req, res) => res.json({ plans: PLANS, freeDomain: FREE_DOMAIN, costs: COSTS }));
app.get('/api/me', requireAuth, (req, res) => res.json({ ...users.publicUser(req.user), planInfo: planOf(req.user) }));
/** The client's choice on the offers screen. Paid plans are recorded until card payment is switched on. */
app.post('/api/me/choice', requireAuth, wrap(async (req, res) => {
  const plan = PLANS.find((p) => p.id === req.body.plan);
  if (!plan) return res.status(400).json({ error: 'Unknown plan' });
  const u = req.user;
  u.planChosen = true;
  if (plan.id !== 'free') u.wantsPlan = plan.id;
  await users.save(u);
  res.json({ ...users.publicUser(u), payments: false });
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
  res.json(all.filter((s) => s.owner === req.user.id));
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
  await siteFor(req);
  await fs.rm(store.siteDir(req.params.id), { recursive: true, force: true });
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
app.get('/api/ai', requireAuth, (req, res) => res.json(aiStatus()));
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
      Object.assign(job, { status: 'error', error: e instanceof AiError ? e.message : 'Wren hit a problem. Try again.' });
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
  } catch (e) { if (e instanceof AiError) return res.status(502).json({ error: e.message }); throw e; }
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
      Object.assign(job, { status: 'error', error: e instanceof AiError ? e.message : 'Personalisation failed, the theme is ready to edit by hand.' });
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

/** Which pages a plan publishes: the home page first, then the others in order, up to the plan limit. */
function publishable(meta, user) {
  const plan = user.role === 'admin' ? { pages: null } : planOf(user);
  const ordered = ['index.html', ...meta.pages.filter((p) => p !== 'index.html')].filter((p) => meta.pages.includes(p));
  const live = plan.pages ? ordered.slice(0, plan.pages) : ordered;
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
  const src = store.draftDir(meta.id);
  const tmp = store.publishedDir(meta.id) + '.tmp';
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.cp(src, tmp, { recursive: true });
  for (const page of meta.pages) {
    const f = store.safeJoin(tmp, page);
    if (!live.includes(page)) { await fs.rm(f, { force: true }); continue; }
    let html = strip(await fs.readFile(f, 'utf8'));
    if (locked.length) html = unlinkPages(html, page, locked);
    if (req.user.role !== 'admin' && planOf(req.user).id === 'free') html = addBadge(html, sub);
    await fs.writeFile(f, html);
  }
  await fs.rm(store.publishedDir(meta.id), { recursive: true, force: true });
  await fs.rename(tmp, store.publishedDir(meta.id));
  meta.publishedAt = new Date().toISOString(); meta.dirty = false;
  meta.subdomain = sub; meta.livePages = live;
  await store.writeMeta(meta.id, meta);
  res.json({ ok: true, url: freeUrl(sub), preview: `/s/${sub}/`, publishedAt: meta.publishedAt, live, locked });
}));

app.post('/api/sites/:id/unpublish', requireAuth, wrap(async (req, res) => {
  const meta = await siteFor(req);
  await fs.rm(store.publishedDir(meta.id), { recursive: true, force: true });
  meta.publishedAt = null; meta.livePages = [];
  await store.writeMeta(meta.id, meta);
  res.json({ ok: true });
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
  if (/\.html?$/i.test(file)) return res.type('html').send(injectEditor(await fs.readFile(file, 'utf8'), VERSION));
  res.sendFile(file);
}));

// ---- published sites ---------------------------------------------------------------
async function serveSite(sub, parts, res) {
  const site = (await store.listSites()).find((s) => s.publishedAt && (s.subdomain === sub || (!s.subdomain && s.slug === sub)));
  if (!site) return res.status(404).send('Site not found');
  const base = store.publishedDir(site.id);
  let file = store.safeJoin(base, (parts || []).join('/') || 'index.html');
  if (fss.existsSync(file) && fss.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fss.existsSync(file) && fss.existsSync(file + '.html')) file += '.html';
  if (!fss.existsSync(file)) return res.status(404).send('Page not found');
  res.setHeader('Content-Security-Policy', SANDBOX);
  res.setHeader('Cache-Control', 'no-cache');
  corsOk(res);
  res.sendFile(file);
}
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
app.listen(PORT, () => console.log(`ili studio running on http://localhost:${PORT} (data: ${store.DATA_DIR})`));
