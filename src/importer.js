// Safe import of a ZIP or single HTML file into a site's draft folder.
import AdmZip from 'adm-zip';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tag } from './html.js';

const LIMITS = { files: 3000, totalBytes: 300 * 1024 * 1024, fileBytes: 50 * 1024 * 1024 };
const ALLOWED = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'txt', 'xml', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif',
  'ico', 'bmp', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp4', 'webm', 'ogg', 'mp3', 'wav', 'pdf', 'map', 'webmanifest', 'csv', 'md']);

const ext = (p) => path.extname(p).slice(1).toLowerCase();
const isHtml = (p) => ['html', 'htm'].includes(ext(p));

export class ImportError extends Error {}

/** Normalise a path from an archive; returns null if it must be skipped, throws if hostile. */
function cleanEntry(name) {
  const p = name.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) throw new ImportError('Archive contains absolute paths');
  const norm = path.posix.normalize(p);
  if (norm.startsWith('..') || norm.includes('/../')) throw new ImportError('Archive contains unsafe paths');
  const parts = norm.split('/');
  if (parts.some((s) => s === '__MACOSX' || s.startsWith('.') || s === 'node_modules')) return null;
  if (!ALLOWED.has(ext(norm))) return null;
  return norm;
}

/** Choose the folder that holds the site (index.html at root, or inside dist/, build/, a single folder...). */
function findRoot(files) {
  const htmls = files.filter(isHtml);
  if (!htmls.length) throw new ImportError('No HTML file found in the archive');
  const indexes = htmls.filter((f) => /(^|\/)index\.html?$/i.test(f)).sort((a, b) => a.split('/').length - b.split('/').length);
  const entry = indexes[0] ?? htmls.sort((a, b) => a.split('/').length - b.split('/').length)[0];
  const dir = path.posix.dirname(entry);
  return { root: dir === '.' ? '' : dir + '/', entry: path.posix.basename(entry) };
}

/** Turn root-absolute URLs ("/img/a.png") into relative ones, so the site works in any folder. */
function relativise(html, pagePath, exists) {
  const pageDir = path.posix.dirname(pagePath);
  const fix = (url) => {
    if (!url || !url.startsWith('/') || url.startsWith('//')) return url;
    const m = url.match(/^([^?#]*)(.*)$/);
    const target = m[1].replace(/^\/+/, '');
    const candidates = [target, target + '.html', path.posix.join(target, 'index.html')];
    const hit = target === '' ? 'index.html' : candidates.find(exists);
    if (!hit) return url;
    let rel = path.posix.relative(pageDir === '.' ? '' : pageDir, hit);
    if (target === '' || hit.endsWith('index.html') && target !== hit) rel = path.posix.dirname(rel) === '.' ? './' : path.posix.dirname(rel) + '/';
    return (rel || './') + m[2];
  };
  return html.replace(/\b(src|href|poster|data-src|action)=(["'])(\/[^"']*)\2/gi, (_, a, q, u) => `${a}=${q}${fix(u)}${q}`)
    .replace(/\bsrcset=(["'])([^"']*)\1/gi, (_, q, v) => `srcset=${q}${v.split(',').map((s) => { const [u, ...r] = s.trim().split(/\s+/); return [fix(u), ...r].join(' '); }).join(', ')}${q}`);
}

function relativiseCss(css, cssPath, exists) {
  const dir = path.posix.dirname(cssPath);
  return css.replace(/url\((['"]?)(\/[^)'"]+)\1\)/g, (m, q, u) => {
    if (u.startsWith('//')) return m;
    const target = u.replace(/^\/+/, '').split(/[?#]/)[0];
    if (!exists(target)) return m;
    return `url(${q}${path.posix.relative(dir === '.' ? '' : dir, target)}${q})`;
  });
}

/**
 * Import an uploaded file into destDir. Returns { pages, entry }.
 * @param {string} filePath temporary upload path
 * @param {string} originalName name of the uploaded file
 */
export async function importUpload(filePath, originalName, destDir) {
  const files = new Map(); // relative path -> Buffer
  if (/\.zip$/i.test(originalName)) {
    let zip;
    try { zip = new AdmZip(filePath); } catch { throw new ImportError('This ZIP file could not be read'); }
    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    if (entries.length > LIMITS.files) throw new ImportError(`Too many files (max ${LIMITS.files})`);
    let total = 0;
    for (const e of entries) {
      const p = cleanEntry(e.entryName);
      if (!p) continue;
      const size = e.header.size;
      if (size > LIMITS.fileBytes) throw new ImportError(`File too large: ${p}`);
      total += size;
      if (total > LIMITS.totalBytes) throw new ImportError('Site is too large once unzipped (max 300 MB)');
      files.set(p, e.getData());
    }
  } else if (/\.html?$/i.test(originalName)) {
    files.set('index.html', await fs.readFile(filePath));
  } else {
    throw new ImportError('Please upload a .zip or .html file');
  }

  const { root, entry } = findRoot([...files.keys()]);
  const site = new Map();
  for (const [p, buf] of files) if (p.startsWith(root)) site.set(p.slice(root.length), buf);
  // make sure the entry page is index.html, so the site has a home page
  let entryName = entry;
  if (!site.has('index.html') && entry !== 'index.html') { site.set('index.html', site.get(entry)); site.delete(entry); entryName = 'index.html'; }

  const exists = (p) => site.has(p);
  const pages = [];
  for (const [p, buf] of site) {
    let out = buf;
    if (isHtml(p)) {
      const html = relativise(buf.toString('utf8'), p, exists);
      out = Buffer.from(tag(html), 'utf8');
      pages.push(p);
    } else if (ext(p) === 'css') {
      out = Buffer.from(relativiseCss(buf.toString('utf8'), p, exists), 'utf8');
    }
    const target = path.join(destDir, p);
    if (!target.startsWith(destDir + path.sep)) throw new ImportError('Unsafe path');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, out);
  }
  pages.sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));
  return { pages, entry: entryName };
}
