// Themes: designer-made website templates that Wren personalises from a brief.
//
// A theme is a folder (or a ZIP of it) with:
//   theme.json          { id, name, category, description, version, preview?, pages?, templates?, sections? }
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
    return {
      id: t.id, name: String(t.name || t.id), category: String(t.category || 'General'), description: String(t.description || ''),
      version: String(t.version || '1.0.0'), preview, pages, templates, source, dir,
    };
  } catch { return null; }
}

export async function listThemes() {
  const out = new Map();
  for (const [base, source] of [[BUILTIN, 'built-in'], [UPLOADED, 'uploaded']]) {
    const ids = await fs.readdir(base).catch(() => []);
    for (const id of ids) {
      const t = await readTheme(path.join(base, id), source);
      if (t) out.set(t.id, t); // an uploaded theme with the same id replaces the built-in one
    }
  }
  return [...out.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

export async function getTheme(id) {
  if (!ID_RE.test(String(id))) return null;
  return (await listThemes()).find((t) => t.id === id) || null;
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
  return readTheme(dest, 'uploaded');
}

export async function removeTheme(id) {
  const t = await getTheme(id);
  if (!t) throw new ImportError('Theme not found');
  if (t.source !== 'uploaded') throw new ImportError('Built-in themes cannot be deleted here');
  await fs.rm(t.dir, { recursive: true, force: true });
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
