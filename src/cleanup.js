// Deleting things properly, and the nightly clean-up.
// One place that knows everything a site or an account leaves behind, so nothing is forgotten:
//   site:    DATA_DIR/sites/<id>/ (draft, published, history, versions, messages), its copy and statistics on ili-sites,
//            DATA_DIR/seo/audits/s-<id>.json, DATA_DIR/stats/<id>/
//   account: all its sites, DATA_DIR/seo/external/<uid>.json + audits x-<id>.json, DATA_DIR/users/<uid>.json
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as store from './store.js';
import * as users from './users.js';
import { removeSite } from './sitesync.js';

const SEO_DIR = path.join(store.DATA_DIR, 'seo');
const AUDITS = path.join(SEO_DIR, 'audits');
const EXTERNAL = path.join(SEO_DIR, 'external');
const readJson = async (f, d) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return d; } };

/** Delete a site and everything it left behind. Throws (and keeps the site) if it cannot be taken offline. */
export async function deleteSite(meta) {
  if (meta.publishedAt) await removeSite(meta.subdomain || meta.slug, meta.id, true);
  await fs.rm(path.join(store.DATA_DIR, 'stats', meta.id), { recursive: true, force: true }); // when ili studio serves the sites itself
  await fs.rm(store.siteDir(meta.id), { recursive: true, force: true });
  await fs.rm(path.join(AUDITS, `s-${meta.id}.json`), { force: true });
}

/** Delete an account with all its sites and data (UK GDPR: right to erasure). Returns the number of sites removed. */
export async function deleteAccount(user) {
  if (!user || user.role === 'admin') throw new Error('This account cannot be deleted');
  const mine = (await store.listSites()).filter((s) => s.owner === user.id);
  for (const s of mine) await deleteSite(s); // stops here if a site cannot be taken offline: nothing is half-deleted
  for (const e of await readJson(path.join(EXTERNAL, `${user.id}.json`), [])) await fs.rm(path.join(AUDITS, `x-${String(e.id).replace(/[^\w-]/g, '')}.json`), { force: true });
  await fs.rm(path.join(EXTERNAL, `${user.id}.json`), { force: true });
  await users.remove(user.id);
  console.log(`[account] ${user.id} deleted with ${mine.length} site(s)`);
  return mine.length;
}

/** Size of a folder in bytes. */
export async function diskUsage(dir) {
  let total = 0;
  const walk = async (d) => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) total += (await fs.stat(p).catch(() => ({ size: 0 }))).size;
    }
  };
  await walk(dir);
  return total;
}

/**
 * Nightly clean-up: removes what nothing points to any more.
 * - sites whose owner account no longer exists
 * - SEO audits of sites or external websites that are gone
 * - half-finished publish folders (published.tmp) and old uploads in the temp folder
 */
export async function nightly() {
  const report = { orphanSites: 0, audits: 0, tmp: 0, uploads: 0 };
  try {
    const all = await store.listSites();
    for (const s of all) {
      if (s.owner && !(await users.get(s.owner))) {
        try { await deleteSite(s); report.orphanSites++; } catch (e) { console.error(`[cleanup] site ${s.id}:`, e.message); }
      }
      await fs.rm(store.publishedDir(s.id) + '.tmp', { recursive: true, force: true }).then(() => {}, () => {});
    }
    const siteIds = new Set((await store.listSites()).map((s) => s.id));
    const extIds = new Set();
    for (const f of await fs.readdir(EXTERNAL).catch(() => [])) {
      const uid = f.replace(/\.json$/, '');
      if (!(await users.get(uid))) { await fs.rm(path.join(EXTERNAL, f), { force: true }); continue; }
      for (const e of await readJson(path.join(EXTERNAL, f), [])) extIds.add(e.id);
    }
    for (const f of await fs.readdir(AUDITS).catch(() => [])) {
      const m = f.match(/^([sx])-(.+)\.json$/);
      if (!m || (m[1] === 's' ? siteIds.has(m[2]) : extIds.has(m[2]))) continue;
      await fs.rm(path.join(AUDITS, f), { force: true }); report.audits++;
    }
    const up = path.join(os.tmpdir(), 'ili-uploads');
    for (const f of await fs.readdir(up).catch(() => [])) {
      const p = path.join(up, f);
      const st = await fs.stat(p).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 24 * 3600 * 1000) { await fs.rm(p, { recursive: true, force: true }); report.uploads++; }
    }
    console.log(`[cleanup] done: ${report.orphanSites} orphan site(s), ${report.audits} old audit(s), ${report.uploads} old upload(s) removed`);
  } catch (e) { console.error('[cleanup] failed:', e.message); }
  return report;
}

/** Run the clean-up 10 minutes after start, then every night at about 04:00 (after the 03:30 backup). */
export function startCleanup() {
  setTimeout(nightly, 10 * 60 * 1000).unref();
  const next = () => {
    const t = new Date(); t.setHours(4, 0, 0, 0);
    if (t <= new Date()) t.setDate(t.getDate() + 1);
    setTimeout(() => { nightly().finally(next); }, t - Date.now()).unref();
  };
  next();
}
