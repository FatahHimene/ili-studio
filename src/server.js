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
import { applyOps, injectEditor, strip, title, elementForAi } from './html.js';
import { wren, aiStatus, AiError, ping } from './ai.js';
import { requireAuth, login, logout, isAuthed, frameToken, checkFrameToken } from './auth.js';

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

// Site content (draft in the editor, published sites) runs in an opaque origin, so its scripts
// can never reach the admin API or cookies.
const SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads';

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
app.get('/login', (req, res) => (isAuthed(req) ? res.redirect('/') : send(res, 'login.html')));
app.post('/login', (req, res) => {
  const r = login(req, res, req.body.password);
  if (r.ok) return res.redirect('/');
  res.redirect('/login?error=' + encodeURIComponent(r.error));
});
app.post('/logout', (req, res) => { logout(res); res.redirect('/login'); });

// ---- dashboard & editor pages -------------------------------------------------------------
app.get('/', requireAuth, (req, res) => send(res, 'dashboard.html'));
app.get('/editor/:id', requireAuth, (req, res) => send(res, 'editor.html'));

// ---- API -------------------------------------------------------------------------
app.get('/api/sites', requireAuth, wrap(async (req, res) => res.json(await store.listSites())));

app.post('/api/sites', requireAuth, upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a .zip or .html file' });
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
    const meta = { id, name: name.slice(0, 80), slug, pages, createdAt: now, updatedAt: now, publishedAt: null, source: req.file.originalname };
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
  const meta = await store.readMeta(req.params.id);
  const page = req.query.page || 'index.html';
  res.json({ ...meta, frameToken: frameToken(meta.id), undo: await store.historyCount(meta.id, page) });
}));

app.patch('/api/sites/:id', requireAuth, wrap(async (req, res) => {
  const meta = await store.readMeta(req.params.id);
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
  await fs.rm(store.siteDir(req.params.id), { recursive: true, force: true });
  res.json({ ok: true });
}));

/** Apply edit operations to one page. Body: { page, ops: [...] } */
app.post('/api/sites/:id/ops', requireAuth, wrap(async (req, res) => {
  const meta = await store.readMeta(req.params.id);
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
app.get('/api/ai/ping', requireAuth, wrap(async (req, res) => res.json(await ping())));

const aiCalls = []; // simple guard: max 20 AI calls per minute for the whole app
const jobs = new Map(); // jobId -> { status: 'working'|'done'|'error', error?, undo?, site, at }

/** Start a Wren job; the editor polls GET /api/sites/:id/wren/:job (avoids proxy time-outs on slow AI). */
app.post('/api/sites/:id/wren', requireAuth, wrap(async (req, res) => {
  const meta = await store.readMeta(req.params.id);
  const page = String(req.body.page || 'index.html');
  const elId = String(req.body.id || '');
  const instruction = String(req.body.instruction || '').trim().slice(0, 500);
  if (!meta.pages.includes(page)) return res.status(404).json({ error: 'Page not found' });
  if (!instruction) return res.status(400).json({ error: 'Tell Wren what to do' });
  const now = Date.now(); while (aiCalls.length && now - aiCalls[0] > 60000) aiCalls.shift();
  if (aiCalls.length >= 20) return res.status(429).json({ error: 'Wren is busy. Wait a minute and try again.' });
  aiCalls.push(now);

  const file = store.safeJoin(store.draftDir(meta.id), page);
  const snapshot = await fs.readFile(file, 'utf8');
  let el;
  try { el = elementForAi(snapshot, elId); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (el.html.length > 30000) return res.status(400).json({ error: 'This part is too big for Wren. Select a smaller element.' });
  const mode = req.body.mode === 'text' ? 'text' : 'block';

  const jobId = store.newId();
  const job = { status: 'working', site: meta.id, at: Date.now() };
  jobs.set(jobId, job);
  for (const [k, j] of jobs) if (Date.now() - j.at > 10 * 60 * 1000) jobs.delete(k);
  res.status(202).json({ job: jobId });

  (async () => {
    try {
      const out = await wren({ mode, html: mode === 'text' ? `<${el.tag}>${el.inner}</${el.tag}>` : el.html, instruction, context: el.context });
      let html = out.html;
      if (mode === 'text') html = html.replace(new RegExp(`^<${el.tag}[^>]*>([\\s\\S]*)</${el.tag}>$`, 'i'), '$1');
      const before = await fs.readFile(file, 'utf8'); // apply on the latest version of the page
      let result;
      try { result = applyOps(before, [mode === 'text' ? { type: 'html', id: elId, html } : { type: 'replace', id: elId, html }]); }
      catch { throw new AiError('Wren returned something unusable. Try again.'); }
      await store.pushHistory(meta.id, page, before);
      await fs.writeFile(file, result.html);
      const m = await store.readMeta(meta.id);
      m.updatedAt = new Date().toISOString(); m.dirty = true;
      m.aiUsage = { calls: (m.aiUsage?.calls || 0) + 1, input: (m.aiUsage?.input || 0) + out.usage.input, output: (m.aiUsage?.output || 0) + out.usage.output };
      await store.writeMeta(meta.id, m);
      Object.assign(job, { status: 'done', undo: await store.historyCount(meta.id, page) });
    } catch (e) {
      if (!(e instanceof AiError)) console.error('[wren] job failed:', e);
      Object.assign(job, { status: 'error', error: e instanceof AiError ? e.message : 'Wren hit a problem. Try again.' });
    }
  })();
}));

app.get('/api/sites/:id/wren/:job', requireAuth, (req, res) => {
  const job = jobs.get(req.params.job);
  if (!job || job.site !== req.params.id) return res.status(404).json({ error: 'Unknown Wren task' });
  res.json({ status: job.status, error: job.error, undo: job.undo });
});

app.post('/api/sites/:id/undo', requireAuth, wrap(async (req, res) => {
  const meta = await store.readMeta(req.params.id);
  const page = String(req.body.page || 'index.html');
  if (!meta.pages.includes(page)) return res.status(404).json({ error: 'Page not found' });
  const html = await store.popHistory(meta.id, page);
  if (html == null) return res.status(400).json({ error: 'Nothing to undo' });
  await fs.writeFile(store.safeJoin(store.draftDir(meta.id), page), html);
  meta.updatedAt = new Date().toISOString(); meta.dirty = true;
  await store.writeMeta(meta.id, meta);
  res.json({ ok: true, undo: await store.historyCount(meta.id, page) });
}));

/** Upload an image into the site; returns a path relative to the page. */
app.post('/api/sites/:id/images', requireAuth, imageUpload.single('image'), wrap(async (req, res) => {
  const meta = await store.readMeta(req.params.id);
  if (!req.file) return res.status(400).json({ error: 'Choose a PNG, JPG, GIF, WebP, AVIF or SVG image (max 10 MB)' });
  const page = String(req.body.page || 'index.html');
  const extMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg' };
  const name = `${Date.now().toString(36)}-${store.newId().slice(0, 4)}.${extMap[req.file.mimetype]}`;
  const dir = path.join(store.draftDir(meta.id), 'ili-uploads');
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(req.file.path, path.join(dir, name));
  await fs.rm(req.file.path, { force: true });
  const rel = path.posix.relative(path.posix.dirname(page) === '.' ? '' : path.posix.dirname(page), 'ili-uploads/' + name);
  res.json({ src: rel });
}));

app.post('/api/sites/:id/publish', requireAuth, wrap(async (req, res) => {
  const meta = await store.readMeta(req.params.id);
  const src = store.draftDir(meta.id);
  const tmp = store.publishedDir(meta.id) + '.tmp';
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.cp(src, tmp, { recursive: true });
  for (const page of meta.pages) {
    const f = store.safeJoin(tmp, page);
    await fs.writeFile(f, strip(await fs.readFile(f, 'utf8')));
  }
  await fs.rm(store.publishedDir(meta.id), { recursive: true, force: true });
  await fs.rename(tmp, store.publishedDir(meta.id));
  meta.publishedAt = new Date().toISOString(); meta.dirty = false;
  await store.writeMeta(meta.id, meta);
  res.json({ ok: true, url: `/s/${meta.slug}/`, publishedAt: meta.publishedAt });
}));

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
  if (/\.html?$/i.test(file)) return res.type('html').send(injectEditor(await fs.readFile(file, 'utf8'), VERSION));
  res.sendFile(file);
}));

// ---- published sites ---------------------------------------------------------------
app.get('/s/:slug', (req, res, next) => (req.originalUrl.endsWith('/') ? next() : res.redirect(301, `/s/${req.params.slug}/`)));
app.get('/s/:slug/{*path}', wrap(async (req, res) => {
  const site = (await store.listSites()).find((s) => s.slug === req.params.slug && s.publishedAt);
  if (!site) return res.status(404).send('Site not found');
  const base = store.publishedDir(site.id);
  let file = store.safeJoin(base, (req.params.path || []).join('/') || 'index.html');
  if (fss.existsSync(file) && fss.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fss.existsSync(file) && fss.existsSync(file + '.html')) file += '.html';
  if (!fss.existsSync(file)) return res.status(404).send('Page not found');
  res.setHeader('Content-Security-Policy', SANDBOX);
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(file);
}));

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong' });
});

await store.init();
app.listen(PORT, () => console.log(`ili studio running on http://localhost:${PORT} (data: ${store.DATA_DIR})`));
