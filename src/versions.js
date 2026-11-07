// Site versions: copies of a site's draft that the client can go back to or download.
//   DATA_DIR/sites/<id>/versions/index.json        [{ id, at, kind, label, pages, bytes }]   newest first
//   DATA_DIR/sites/<id>/versions/<vid>/...          the files of that version
// A version is made at every publish (kind "publish"), when the client saves one (kind "manual"),
// and just before a restore (kind "auto"), so a restore can itself be undone.
// Versions never change once made, so a file identical to the one in the previous version is
// hard-linked instead of copied: ten versions of a site with the same photos take the space of one.
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import * as store from './store.js';
import { strip } from './html.js';

const vDir = (id) => path.join(store.siteDir(id), 'versions');
const idxFile = (id) => path.join(vDir(id), 'index.json');
const VID = /^[a-z0-9]{10}$/;

export async function list(siteId) {
  try { return JSON.parse(await fs.readFile(idxFile(siteId), 'utf8')); } catch { return []; }
}
async function writeIndex(siteId, list) {
  await fs.mkdir(vDir(siteId), { recursive: true });
  await fs.writeFile(idxFile(siteId) + '.tmp', JSON.stringify(list, null, 1));
  await fs.rename(idxFile(siteId) + '.tmp', idxFile(siteId));
}

async function files(dir, rel = '') {
  const out = [];
  for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await files(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}
const hashOf = async (f) => crypto.createHash('sha1').update(await fs.readFile(f)).digest('hex');

/** Make a version from the site's current draft. Keeps at most `keep` versions (oldest removed first). */
export async function create(meta, { kind = 'manual', label = '', keep = 5 } = {}) {
  const versions = await list(meta.id);
  const vid = store.newId();
  const dest = path.join(vDir(meta.id), vid);
  const src = store.draftDir(meta.id);
  const prev = versions[0] ? path.join(vDir(meta.id), versions[0].id) : null;
  let bytes = 0;
  for (const rel of await files(src)) {
    const from = path.join(src, rel), to = path.join(dest, rel);
    await fs.mkdir(path.dirname(to), { recursive: true });
    const old = prev && path.join(prev, rel);
    if (old && fss.existsSync(old) && (await fs.stat(old)).size === (await fs.stat(from)).size && await hashOf(old) === await hashOf(from)) {
      await fs.link(old, to);
    } else {
      await fs.copyFile(from, to);
      bytes += (await fs.stat(to)).size;
    }
  }
  const v = { id: vid, at: new Date().toISOString(), kind, label: String(label || '').trim().slice(0, 80), pages: [...meta.pages], bytes };
  versions.unshift(v);
  const removed = versions.splice(Math.max(1, keep));
  await writeIndex(meta.id, versions);
  for (const r of removed) await fs.rm(path.join(vDir(meta.id), r.id), { recursive: true, force: true });
  return v;
}

async function find(siteId, vid) {
  if (!VID.test(String(vid))) return null;
  return (await list(siteId)).find((v) => v.id === vid) || null;
}

/**
 * Put a version back as the draft. The current draft is saved first as an "auto" version,
 * so the client can change their mind. The live site does not change until they publish.
 */
export async function restore(meta, vid, keep) {
  const v = await find(meta.id, vid);
  if (!v) return null;
  const tmp = store.draftDir(meta.id) + '.restore';
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.cp(path.join(vDir(meta.id), v.id), tmp, { recursive: true }); // real copies, never links: the draft is edited in place
  await create(meta, { kind: 'auto', label: `Before going back to ${v.label || 'the ' + new Date(v.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' version'}`, keep: Math.max(2, keep + 1) });
  const old = store.draftDir(meta.id) + '.old';
  await fs.rm(old, { recursive: true, force: true });
  await fs.rename(store.draftDir(meta.id), old);
  await fs.rename(tmp, store.draftDir(meta.id));
  await fs.rm(old, { recursive: true, force: true });
  await fs.rm(path.join(store.siteDir(meta.id), 'history'), { recursive: true, force: true }); // page undo steps belonged to the old draft
  return v;
}

export async function remove(siteId, vid) {
  const versions = await list(siteId);
  const i = versions.findIndex((v) => v.id === vid);
  if (i < 0 || !VID.test(vid)) return false;
  versions.splice(i, 1);
  await writeIndex(siteId, versions);
  await fs.rm(path.join(vDir(siteId), vid), { recursive: true, force: true });
  return true;
}

/** A ZIP of a folder, with the editor's markers removed from every page, ready to host anywhere. */
export async function zipFolder(dir) {
  const zip = new AdmZip();
  for (const rel of await files(dir)) {
    const f = path.join(dir, rel);
    const data = /\.html?$/i.test(rel) ? Buffer.from(strip(await fs.readFile(f, 'utf8'))) : await fs.readFile(f);
    zip.addFile(rel, data);
  }
  return zip.toBuffer();
}
export async function zipVersion(siteId, vid) {
  const v = await find(siteId, vid);
  return v ? { v, zip: await zipFolder(path.join(vDir(siteId), v.id)) } : null;
}
