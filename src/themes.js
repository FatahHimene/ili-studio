// Themes: designer-made website templates that Wren personalises from a brief.
//
// A theme is a folder (or a ZIP of it) with:
//   theme.json          { id, name, category, subcategory?, tags?, description, version, preview?, pages?, templates?, palettes? }
//   index.html …        the theme's pages (any .html at the top level, or the list in "pages")
//   assets/ …           css, fonts, images, scripts used by the pages
//   templates/*.html    optional page templates ("About", "Contact"…) the owner can add later
//   preview.(png|jpg|webp) optional screenshot for the gallery
//
// Inside the HTML, editable content is marked with slots:
//   data-ili-slot="hero.title"                text the AI writes (data-ili-hint, data-ili-max help it)
//   data-ili-slot="contact.phone" data-ili-type="phone|email|business|town|address"   facts from the brief, never invented
//   <img data-ili-slot="hero.image" data-ili-query="plumber at work" data-ili-orientation="horizontal">   photo from the library
//
// Built-in themes ship in /themes of this repository; themes uploaded in the admin live in DATA_DIR/themes.
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './store.js';
import { readArchive, writeFiles, ImportError } from './importer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN = path.join(__dirname, '..', 'themes');
const UPLOADED = path.join(DATA_DIR, 'themes');

const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
// Built-in themes live in the app image and cannot be removed from disk: deleting one hides it instead.
const HIDDEN = path.join(DATA_DIR, 'themes-hidden.json');
async function readHidden() { try { return new Set(JSON.parse(await fs.readFile(HIDDEN, 'utf8'))); } catch { return new Set(); } }
async function writeHidden(set) { await fs.mkdir(DATA_DIR, { recursive: true }); await fs.writeFile(HIDDEN, JSON.stringify([...set])); }

async function readTheme(dir, source) {
  try {
    const t = JSON.parse(await fs.readFile(path.join(dir, 'theme.json'), 'utf8'));
    if (!ID_RE.test(t.id || '') || !fss.existsSync(path.join(dir, 'index.html'))) return null;
    const files = await fs.readdir(dir);
    const pages = Array.isArray(t.pages) && t.pages.length ? t.pages.filter((p) => fss.existsSync(path.join(dir, p)))
      : files.filter((f) => /\.html?$/i.test(f)).sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));
    const preview = t.preview && fss.existsSync(path.join(dir, t.preview)) ? t.preview : files.find((f) => /^preview\.(png|jpe?g|webp)$/i.test(f)) || null;
    const templates = (Array.isArray(t.templates) ? t.templates : [])
      .filter((x) => x && x.file && fss.existsSync(path.join(dir, x.file)))
      .map((x) => ({ id: String(x.id || path.basename(x.file, '.html')), name: String(x.name || x.id), file: x.file, path: x.path || path.basename(x.file) }));
    const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/i;
    const palettes = (Array.isArray(t.palettes) ? t.palettes : []).slice(0, 6).map((p, i) => ({
      id: String(p.id || `p${i + 1}`).replace(/[^a-z0-9-]/gi, '').slice(0, 30) || `p${i + 1}`, name: String(p.name || `Palette ${i + 1}`).slice(0, 40),
      colors: Object.fromEntries(Object.entries(p.colors || {}).filter(([k, v]) => /^--[a-z0-9-]{1,40}$/i.test(k) && COLOR.test(String(v).trim())).map(([k, v]) => [k, String(v).trim()])),
    })).filter((p) => Object.keys(p.colors).length);
    return {
      id: t.id, name: String(t.name || t.id), category: String(t.category || 'General'), subcategory: String(t.subcategory || '').slice(0, 60),
      tags: (Array.isArray(t.tags) ? t.tags : []).map((x) => String(x).trim().toLowerCase().slice(0, 30)).filter(Boolean).slice(0, 20),
      description: String(t.description || ''),
      version: String(t.version || '1.0.0'), preview, pages, templates, palettes, source, dir,
      // class names the modules (contact, reviews…) use so they look like the theme
      ui: Object.fromEntries(['button', 'buttonAlt', 'form', 'section', 'container', 'contactLook'].filter((k) => typeof t.ui?.[k] === 'string').map((k) => [k, t.ui[k].replace(/[^\w\s-]/g, '').trim().slice(0, 80)])),
    };
  } catch { return null; }
}

export async function listThemes({ includeHidden = false } = {}) {
  const hidden = await readHidden();
  const out = new Map();
  for (const [base, source] of [[BUILTIN, 'built-in'], [UPLOADED, 'uploaded']]) {
    const ids = await fs.readdir(base).catch(() => []);
    for (const id of ids) {
      const t = await readTheme(path.join(base, id), source);
      if (t) out.set(t.id, t); // an uploaded theme with the same id replaces the built-in one
    }
  }
  for (const [id, t] of out) {
    if (!hidden.has(id)) continue;
    if (includeHidden) t.hidden = true; else out.delete(id);
  }
  return [...out.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

export async function getTheme(id) {
  if (!ID_RE.test(String(id))) return null;
  // hidden themes still resolve, so sites already made from them keep their palettes and page templates
  return (await listThemes({ includeHidden: true })).find((t) => t.id === id) || null;
}

export const publicTheme = ({ dir, ...t }) => t;

/** Install (or update) a theme from an uploaded ZIP. */
export async function installTheme(filePath, originalName) {
  if (!/\.zip$/i.test(originalName)) throw new ImportError('Upload the theme as a .zip file');
  const files = await readArchive(filePath, originalName);
  const manifest = [...files.keys()].filter((p) => p.endsWith('theme.json')).sort((a, b) => a.length - b.length)[0];
  if (!manifest) throw new ImportError('theme.json is missing');
  const root = manifest.slice(0, -'theme.json'.length);
  let t;
  try { t = JSON.parse(files.get(manifest).toString('utf8')); } catch { throw new ImportError('theme.json is not valid JSON'); }
  if (!ID_RE.test(t.id || '')) throw new ImportError('theme.json needs an "id" made of lowercase letters, digits and dashes');
  if (!files.has(root + 'index.html')) throw new ImportError('The theme needs an index.html next to theme.json');
  const own = new Map([...files].filter(([p]) => p.startsWith(root)).map(([p, b]) => [p.slice(root.length), b]));
  const dest = path.join(UPLOADED, t.id);
  const tmp = dest + '.tmp';
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp, { recursive: true });
  await writeFiles(own, tmp);
  await fs.rm(dest, { recursive: true, force: true });
  await fs.rename(tmp, dest);
  const hidden = await readHidden();
  if (hidden.delete(t.id)) await writeHidden(hidden); // uploading a theme again makes it visible
  return readTheme(dest, 'uploaded');
}

/** Delete an uploaded theme, and hide any built-in theme with the same id (sites made from it keep working). */
export async function removeTheme(id) {
  if (!ID_RE.test(String(id))) throw new ImportError('Theme not found');
  const t = (await listThemes({ includeHidden: true })).find((x) => x.id === id);
  if (!t) throw new ImportError('Theme not found');
  await fs.rm(path.join(UPLOADED, id), { recursive: true, force: true });
  if (fss.existsSync(path.join(BUILTIN, id, 'theme.json'))) {
    const hidden = await readHidden(); hidden.add(id); await writeHidden(hidden);
  }
}

/** Show a hidden built-in theme again. */
export async function restoreTheme(id) {
  const hidden = await readHidden();
  if (!hidden.delete(String(id))) throw new ImportError('Theme not found');
  await writeHidden(hidden);
}

/** Copy a theme's site files (not templates, previews or theme.json) into a site's draft folder. */
export async function copyThemeTo(theme, destDir) {
  const skip = new Set(['theme.json', 'templates', 'sections']);
  const entries = await fs.readdir(theme.dir, { withFileTypes: true });
  for (const e of entries) {
    if (skip.has(e.name) || /^preview\.(png|jpe?g|webp)$/i.test(e.name) || e.name.startsWith('.')) continue;
    await fs.cp(path.join(theme.dir, e.name), path.join(destDir, e.name), { recursive: true });
  }
}

/** Write a palette (CSS variables) into pages: <style id="ili-palette"> at the end of <head>. */
export async function applyPalette(dir, pages, palette) {
  if (!palette || !Object.keys(palette.colors || {}).length) return;
  const css = `:root{${Object.entries(palette.colors).map(([k, v]) => `${k}:${v}`).join(';')}}`;
  for (const page of pages) {
    const f = path.join(dir, page);
    let html = await fs.readFile(f, 'utf8');
    html = html.replace(/<style id="ili-palette"[^>]*>[\s\S]*?<\/style>/i, '');
    const tagStr = `<style id="ili-palette" data-palette="${palette.id}">${css}</style>`;
    html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, tagStr + '</head>') : tagStr + html;
    await fs.writeFile(f, html);
  }
}
