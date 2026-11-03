// Images: free photo bank (Pixabay) + processing of uploaded / downloaded images.
//   PIXABAY_API_KEY=...   (free key from pixabay.com/api/docs)
//   IMAGES_MOCK=1         (tests: fake results, no network)
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export class ImageError extends Error {}

export const bankStatus = () => ({ enabled: !!process.env.PIXABAY_API_KEY || process.env.IMAGES_MOCK === '1', provider: 'pixabay' });

// Pixabay asks API users to cache search results for 24 hours.
const cache = new Map(); // key -> { at, data }
const CACHE_MS = 24 * 60 * 60 * 1000;
const calls = []; // stay well under 100 requests / 60 s

/**
 * Search free photos. Returns [{ id, thumb, preview, full, width, height, tags, author, page }].
 * @param {string} q search words
 * @param {'horizontal'|'vertical'|'all'} orientation
 */
export async function searchPhotos(q, { orientation = 'all', perPage = 24 } = {}) {
  const query = String(q || '').trim().slice(0, 100);
  if (!query) return [];
  if (process.env.IMAGES_MOCK === '1') return mockResults(query);
  if (!process.env.PIXABAY_API_KEY) throw new ImageError('The photo library is not set up yet (PIXABAY_API_KEY).');
  const key = `${query.toLowerCase()}|${orientation}|${perPage}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const now = Date.now(); while (calls.length && now - calls[0] > 60000) calls.shift();
  if (calls.length >= 80) throw new ImageError('Too many photo searches right now. Wait a minute.');
  calls.push(now);

  const url = new URL('https://pixabay.com/api/');
  url.search = new URLSearchParams({
    key: process.env.PIXABAY_API_KEY, q: query, image_type: 'photo', orientation, safesearch: 'true',
    per_page: String(Math.min(Math.max(perPage, 3), 60)), lang: 'en',
  }).toString();
  let r;
  try { r = await fetch(url, { signal: AbortSignal.timeout(15000) }); }
  catch (e) { console.error('[images] pixabay network error', e.message); throw new ImageError('The photo library could not be reached.'); }
  if (r.status === 429) throw new ImageError('Too many photo searches right now. Wait a minute.');
  if (r.status === 400 || r.status === 401 || r.status === 403) throw new ImageError('The photo library refused the key (PIXABAY_API_KEY).');
  if (!r.ok) throw new ImageError(`Photo library error (${r.status})`);
  const d = await r.json();
  const data = (d.hits || []).map((h) => ({
    id: String(h.id), thumb: h.previewURL, preview: h.webformatURL, full: h.largeImageURL,
    width: h.imageWidth, height: h.imageHeight, tags: h.tags || '', author: h.user || '', page: h.pageURL,
  }));
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return data;
}

function mockResults(q) {
  const colours = ['#1E3A6E', '#C8F031', '#F4B23E', '#5A6275', '#0D1221', '#E11D48'];
  const svg = (c) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><rect width="300" height="200" fill="${c}"/></svg>`)}`;
  return colours.map((c, i) => ({
    id: `mock-${i}`, thumb: svg(c), preview: svg(c), full: `mock:${c}`, width: 1280, height: 853,
    tags: `${q}, test ${i}`, author: 'Mock', page: 'https://pixabay.com/',
  }));
}

/** Only fetch photo files from the photo library's own servers. */
const ALLOWED_HOSTS = /(^|\.)pixabay\.com$/i;

async function fetchBytes(src) {
  if (String(src).startsWith('mock:')) {
    return sharp({ create: { width: 1280, height: 853, channels: 3, background: src.slice(5) } }).jpeg().toBuffer();
  }
  let u; try { u = new URL(src); } catch { throw new ImageError('Bad image address'); }
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.test(u.hostname)) throw new ImageError('This image source is not allowed');
  const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new ImageError(`Could not download the photo (${r.status})`);
  const len = Number(r.headers.get('content-length') || 0);
  if (len > 25 * 1024 * 1024) throw new ImageError('Photo too large');
  return Buffer.from(await r.arrayBuffer());
}

/**
 * Resize + compress an image into the site's ili-uploads folder.
 * Returns the file name (relative to ili-uploads/).
 */
export async function saveImage(buffer, destDir, { maxWidth = 2000, keepFormat = false } = {}) {
  await fs.mkdir(destDir, { recursive: true });
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  let meta;
  try { meta = await sharp(buffer, { animated: false }).metadata(); } catch { throw new ImageError('This file is not a valid image'); }
  if (meta.format === 'svg' || (keepFormat && meta.format === 'gif')) {
    const name = `${id}.${meta.format}`;
    if (meta.format === 'svg' && /<script|on\w+\s*=|javascript:/i.test(buffer.toString('utf8'))) throw new ImageError('This SVG contains scripts and was refused');
    await fs.writeFile(path.join(destDir, name), buffer);
    return { name, width: meta.width, height: meta.height };
  }
  const name = `${id}.webp`;
  const out = await sharp(buffer).rotate().resize({ width: maxWidth, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
  await fs.writeFile(path.join(destDir, name), out.data);
  return { name, width: out.info.width, height: out.info.height };
}

/** Download a photo from the library and store it in the site. */
export async function importPhoto(photo, destDir) {
  const buf = await fetchBytes(photo.full || photo.preview);
  return saveImage(buf, destDir);
}
