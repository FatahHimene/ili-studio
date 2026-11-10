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
  const info = Buffer.from(JSON.stringify({ id: meta.id, name: meta.name, publishedAt, domain: liveDomain(meta) })).toString('base64');
  await call('PUT', '/sites/' + encodeURIComponent(sub), { body: zip.toBuffer(), headers: { 'content-type': 'application/zip', 'x-ili-site': info }, timeout: 180000 });
}

/** The own domain a site answers on, once its DNS is ready (null otherwise). */
export const liveDomain = (meta) => (meta.domain?.status === 'live' ? meta.domain.name : null);

/** Put the own domain on a published site at ili-sites, or take it off. */
export async function setRemoteDomain(meta) {
  if (!remote() || !meta.publishedAt) return;
  await call('PUT', '/domains/' + encodeURIComponent(meta.subdomain || meta.slug), { body: JSON.stringify({ id: meta.id, domain: liveDomain(meta) }), headers: { 'content-type': 'application/json' }, timeout: 20000 });
}

/** Take a site offline on ili-sites (only if that address still belongs to this site). */
export async function removeSite(sub, id, purge = false) {
  if (!remote() || !sub) return;
  await call('DELETE', '/sites/' + encodeURIComponent(sub) + '?' + new URLSearchParams({ ...(id ? { id } : {}), ...(purge ? { purge: '1' } : {}) }));
}

/** Visitor statistics of one site (or of all sites when id is null), from ili-sites. */
export async function remoteStats(id, days) {
  return call('GET', '/stats' + (id ? '/' + id : '') + '?days=' + days, { timeout: 20000 });
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
      } else if ((t.domain || null) !== liveDomain(s)) {
        try { await setRemoteDomain(s); pushed++; } catch (e) { console.error(`[sync] domain ${sub}:`, e.message); }
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
