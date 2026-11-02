// File-based storage. One folder per site:
//   DATA_DIR/sites/<id>/meta.json
//   DATA_DIR/sites/<id>/draft/...      (editable copy, elements tagged with ids)
//   DATA_DIR/sites/<id>/published/...  (clean copy served to visitors)
//   DATA_DIR/sites/<id>/history/<page>/<timestamp>.html
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const SITES = path.join(DATA_DIR, 'sites');
const HISTORY_MAX = 50;

export const siteDir = (id) => {
  if (!/^[a-z0-9]{10}$/.test(id)) throw new Error('Bad site id');
  return path.join(SITES, id);
};
export const draftDir = (id) => path.join(siteDir(id), 'draft');
export const publishedDir = (id) => path.join(siteDir(id), 'published');

/** Resolve a page path inside a folder, refusing anything outside it. */
export function safeJoin(base, rel) {
  const p = path.resolve(base, '.' + path.posix.normalize('/' + String(rel || '')));
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error('Unsafe path');
  return p;
}

export async function init() { await fs.mkdir(SITES, { recursive: true }); }

export const newId = () => crypto.randomBytes(8).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(10, '0').slice(0, 10);

export async function readMeta(id) { return JSON.parse(await fs.readFile(path.join(siteDir(id), 'meta.json'), 'utf8')); }
export async function writeMeta(id, meta) {
  const f = path.join(siteDir(id), 'meta.json');
  await fs.writeFile(f + '.tmp', JSON.stringify(meta, null, 2));
  await fs.rename(f + '.tmp', f);
}

export async function listSites() {
  const ids = await fs.readdir(SITES).catch(() => []);
  const out = [];
  for (const id of ids) { try { out.push(await readMeta(id)); } catch { /* skip broken */ } }
  return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function slugTaken(slug, exceptId) {
  return (await listSites()).some((s) => s.slug === slug && s.id !== exceptId);
}

export function slugify(name) {
  return String(name).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'site';
}

// ---- page history (undo) ------------------------------------------------------
const histDir = (id, page) => path.join(siteDir(id), 'history', page.replace(/[^a-zA-Z0-9._-]/g, '_'));

export async function pushHistory(id, page, html) {
  const dir = histDir(id, page);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${Date.now()}-${crypto.randomBytes(2).toString('hex')}.html`), html);
  const files = (await fs.readdir(dir)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - HISTORY_MAX))) await fs.rm(path.join(dir, f));
}

export async function popHistory(id, page) {
  const dir = histDir(id, page);
  const files = (await fs.readdir(dir).catch(() => [])).sort();
  if (!files.length) return null;
  const last = path.join(dir, files[files.length - 1]);
  const html = await fs.readFile(last, 'utf8');
  await fs.rm(last);
  return html;
}

export async function historyCount(id, page) {
  return (await fs.readdir(histDir(id, page)).catch(() => [])).length;
}
