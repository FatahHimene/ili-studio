// ili studio → ili-sites. When SITES_URL is set, every publish is pushed to the ili-sites server
// (see sites.js) and unpublishing removes it there. Without SITES_URL, ili studio serves the sites itself, as before.
import AdmZip from 'adm-zip';
import fss from 'node:fs';
import * as store from './store.js';

const URL_ = (process.env.SITES_URL || '').replace(/\/$/, '');
const SECRET = process.env.SITES_SECRET || '';
export const remote = () => !!URL_;
export const internalSecret = () => (SECRET.length >= 24 ? SECRET : '');

async function call(method, path, opts = {}) {
  const r = await fetch(URL_ + '/_internal' + path, {
    method, ...opts,
    headers: { authorization: 'Bearer ' + SECRET, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeout || 60000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `ili-sites answered ${r.status}`);
  return data;
}

/** Send a published folder to ili-sites under <sub>. Throws if it did not work. */
export async function pushSite(dir, sub, meta, publishedAt = meta.publishedAt) {
  if (!remote()) return;
  const zip = new AdmZip();
  zip.addLocalFolder(dir);
  const info = Buffer.from(JSON.stringify({ id: meta.id, name: meta.name, publishedAt })).toString('base64');
  await call('PUT', '/sites/' + encodeURIComponent(sub), { body: zip.toBuffer(), headers: { 'content-type': 'application/zip', 'x-ili-site': info }, timeout: 180000 });
}

/** Take a site offline on ili-sites (only if that address still belongs to this site). */
export async function removeSite(sub, id) {
  if (!remote() || !sub) return;
  await call('DELETE', '/sites/' + encodeURIComponent(sub) + (id ? '?id=' + id : ''));
}

/**
 * Make ili-sites match ili studio: push sites that are missing or out of date, remove the ones
 * that are no longer published. Runs at start-up and every 6 hours, so a new or rebuilt ili-sites fills itself.
 */
export async function syncSites() {
  if (!remote()) return;
  try {
    const there = new Map((await call('GET', '/sites')).sites.map((s) => [s.sub, s]));
    const here = (await store.listSites()).filter((s) => s.publishedAt && fss.existsSync(store.publishedDir(s.id)));
    let pushed = 0, removed = 0;
    for (const s of here) {
      const sub = s.subdomain || s.slug;
      const t = there.get(sub);
      if (!t || t.id !== s.id || t.publishedAt !== s.publishedAt) {
        try { await pushSite(store.publishedDir(s.id), sub, s); pushed++; } catch (e) { console.error(`[sync] ${sub}:`, e.message); }
      }
      there.delete(sub);
    }
    for (const t of there.values()) { try { await removeSite(t.sub, t.id); removed++; } catch (e) { console.error(`[sync] remove ${t.sub}:`, e.message); } }
    console.log(`[sync] ili-sites up to date (${here.length} sites, ${pushed} sent, ${removed} removed)`);
  } catch (e) { console.error('[sync] ili-sites not reachable:', e.message); }
}

export function startSync() {
  if (!remote()) return;
  setTimeout(syncSites, 5000);
  setInterval(syncSites, 6 * 60 * 60 * 1000).unref();
}
