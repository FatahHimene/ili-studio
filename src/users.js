// Client accounts, stored as DATA_DIR/users/<id>.json (kept in memory once loaded).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, newId } from './store.js';
import { PLANS } from './plans.js';

const DIR = path.join(DATA_DIR, 'users');
const cache = new Map();
let loading = null;

async function load() {
  if (!loading) loading = (async () => {
    await fs.mkdir(DIR, { recursive: true });
    for (const f of await fs.readdir(DIR)) {
      if (!f.endsWith('.json')) continue;
      try { const u = JSON.parse(await fs.readFile(path.join(DIR, f), 'utf8')); cache.set(u.id, u); } catch { /* skip broken */ }
    }
  })();
  return loading;
}

export const normEmail = (e) => String(e || '').trim().toLowerCase();
export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
export function checkPassword(pw, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 64);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export async function get(id) { await load(); return cache.get(id) || null; }
export async function byEmail(email) { await load(); const e = normEmail(email); for (const u of cache.values()) if (u.email === e) return u; return null; }
export async function list() { await load(); return [...cache.values()]; }

export async function save(u) {
  await load();
  const f = path.join(DIR, `${u.id}.json`);
  await fs.writeFile(f + '.tmp', JSON.stringify(u, null, 2));
  await fs.rename(f + '.tmp', f);
  cache.set(u.id, u);
  return u;
}

export async function create({ email, password, name = '', role = 'client', id }) {
  const now = new Date().toISOString();
  const free = PLANS[0];
  return save({
    id: id || newId(), email: normEmail(email), name: String(name).trim().slice(0, 80), role,
    password: password ? hashPassword(password) : null,
    plan: 'free', planChosen: role === 'admin', wantsPlan: null,
    credits: role === 'admin' ? 0 : free.credits, createdAt: now,
  });
}

/** What the browser may see about a user. */
export const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, plan: u.plan, planChosen: !!u.planChosen, wantsPlan: u.wantsPlan || null, credits: u.role === 'admin' ? null : u.credits });

export const canSpend = (u, n) => u.role === 'admin' || (u.credits || 0) >= n;
export async function spend(id, n) {
  const u = await get(id);
  if (!u || u.role === 'admin' || !n) return u;
  u.credits = Math.max(0, (u.credits || 0) - n);
  return save(u);
}
