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
import { listThemes, getTheme, publicTheme, installTheme, removeTheme, copyThemeTo } from './themes.js';
import { personalise, cleanBrief } from './personalise.js';
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
  if (el.html.length > 60000) return res.status(400).json({ error: 'This part is too big for Wren. Select a smaller element.' });
  const mode = req.body.mode === 'text' ? 'text' : 'block';
  const look = typeof req.body.style === 'string' ? req.body.style.slice(0, 400) : '';
  const current = req.body.current && typeof req.body.current === 'object' ? req.body.current : {};
  const palette = await sitePalette(store.draftDir(meta.id));

  const jobId = store.newId();
  const job = { status: 'working', site: meta.id, at: Date.now() };
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
      Object.assign(job, { status: 'done', note: out.note, undo: await store.historyCount(meta.id, page) });
    } catch (e) {
      if (!(e instanceof AiError)) console.error('[wren] job failed:', e);
      Object.assign(job, { status: 'error', error: e instanceof AiError ? e.message : 'Wren hit a problem. Try again.' });
    }
  })();
}));

app.get('/api/sites/:id/wren/:job', requireAuth, (req, res) => {
  const job = jobs.get(req.params.job);
  if (!job || job.site !== req.params.id) return res.status(404).json({ error: 'Unknown Wren task' });
  res.json({ status: job.status, error: job.error, note: job.note, undo: job.undo });
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
  const meta = await store.readMeta(req.params.id);
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

/** Templates the site can use (from its theme). */
app.get('/api/sites/:id/templates', requireAuth, wrap(async (req, res) => {
  const meta = await store.readMeta(req.params.id);
  const theme = meta.theme ? await getTheme(meta.theme.id) : null;
  res.json(theme ? theme.templates.map(({ id, name, path: p }) => ({ id, name, path: p })) : []);
}));

/** Add a page. Body: { title, from: 'blank'|'duplicate'|'template', source?, template?, menu?: true } */
app.post('/api/sites/:id/pages', requireAuth, wrap(async (req, res) => {
  const meta = await store.readMeta(req.params.id);
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
  const meta = await store.readMeta(req.params.id);
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
  const meta = await store.readMeta(req.params.id);
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
  const meta = await store.readMeta(req.params.id);
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
  const meta = await store.readMeta(req.params.id);
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
app.get('/themes', requireAuth, (req, res) => send(res, 'themes.html'));
app.get('/api/themes', requireAuth, wrap(async (req, res) => res.json((await listThemes()).map(publicTheme))));
app.post('/api/themes', requireAuth, upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a theme .zip file' });
  try { res.json(publicTheme(await installTheme(req.file.path, req.file.originalname))); }
  catch (e) { if (e instanceof ImportError) return res.status(400).json({ error: e.message }); throw e; }
  finally { fs.rm(req.file.path, { force: true }); }
}));
app.delete('/api/themes/:id', requireAuth, wrap(async (req, res) => {
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
  if (!theme) return res.status(404).json({ error: 'Theme not found' });
  const brief = cleanBrief(req.body.brief);
  if (!brief.business || !brief.trade) return res.status(400).json({ error: 'Business name and trade are required' });
  const id = store.newId();
  await fs.mkdir(store.draftDir(id), { recursive: true });
  await copyThemeTo(theme, store.draftDir(id));
  let slug = store.slugify(brief.business);
  for (let n = 2; await store.slugTaken(slug); n++) slug = `${store.slugify(brief.business)}-${n}`;
  const now = new Date().toISOString();
  const meta = { id, name: brief.business, slug, pages: theme.pages, theme: { id: theme.id, version: theme.version }, brief, createdAt: now, updatedAt: now, publishedAt: null, source: 'theme:' + theme.id, personalising: true };
  await store.writeMeta(id, meta);

  const jobId = store.newId();
  const job = { status: 'working', site: id, at: Date.now() };
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
  if (!job) return res.status(404).json({ error: 'Unknown task' });
  res.json({ status: job.status, error: job.error, note: job.note, site: job.site });
});

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
  corsOk(res);
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
  corsOk(res);
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
