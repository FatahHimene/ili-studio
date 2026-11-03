// Accounts and sessions.
// - Clients sign up with email + password (stored as scrypt hashes, see users.js).
// - The owner (admin) signs in with ADMIN_EMAIL (default "admin") + ADMIN_PASSWORD from the environment.
import crypto from 'node:crypto';
import * as users from './users.js';

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
let PASSWORD = process.env.ADMIN_PASSWORD;
if (!PASSWORD) {
  PASSWORD = crypto.randomBytes(9).toString('base64url');
  console.warn(`\n[ili studio] ADMIN_PASSWORD is not set. Temporary password for this run: ${PASSWORD}\n`);
}
const ADMIN_EMAIL = users.normEmail(process.env.ADMIN_EMAIL || 'admin');
const ADMIN_ID = 'admin00000';
const COOKIE = 'ili_s';
const TTL = 1000 * 60 * 60 * 24 * 30; // 30 days

const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const sameSecret = (a, b) => eq(crypto.createHash('sha256').update(String(a)).digest('hex'), crypto.createHash('sha256').update(String(b)).digest('hex'));

/** Capability token for the editor frame (the sandboxed frame cannot send cookies). */
export const frameToken = (siteId) => sign('frame:' + siteId).slice(0, 24);
export const checkFrameToken = (siteId, t) => typeof t === 'string' && eq(t, frameToken(siteId));

function readCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

/** The signed-in user, or null. Cookie: <uid>.<expiry>.<signature> */
export async function currentUser(req) {
  if (req._user !== undefined) return req._user;
  req._user = null;
  const c = readCookie(req, COOKIE);
  const [uid, exp, sig] = (c || '').split('.');
  if (uid && exp && sig && eq(sig, sign(`${uid}.${exp}`)) && Number(exp) > Date.now()) req._user = await users.get(uid);
  return req._user;
}

function startSession(req, res, uid) {
  const exp = String(Date.now() + TTL);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${uid}.${exp}.${sign(`${uid}.${exp}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL / 1000}${secure ? '; Secure' : ''}`);
}

export function logout(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// simple per-IP throttles
const throttles = new Map(); // key -> {n, until, since}
function throttled(key, max, windowMs, lockMs) {
  const now = Date.now();
  const a = throttles.get(key) || { n: 0, until: 0, since: now };
  if (a.until > now) return true;
  if (now - a.since > windowMs) { a.n = 0; a.since = now; }
  a.n += 1;
  if (a.n > max) { a.until = now + lockMs; a.n = 0; }
  throttles.set(key, a);
  return a.until > now;
}

export async function login(req, res, email, password) {
  if (throttled('login:' + req.ip, 8, 10 * 60 * 1000, 10 * 60 * 1000)) return { ok: false, error: 'Too many attempts. Try again in a few minutes.' };
  const e = users.normEmail(email);
  if (typeof password !== 'string' || !password) return { ok: false, error: 'Wrong email or password' };
  if (e === ADMIN_EMAIL && sameSecret(password, PASSWORD)) {
    let admin = await users.get(ADMIN_ID);
    if (!admin) admin = await users.create({ id: ADMIN_ID, email: ADMIN_EMAIL, name: 'Admin', role: 'admin' });
    startSession(req, res, admin.id);
    return { ok: true, user: admin };
  }
  const u = await users.byEmail(e);
  if (!u || u.role === 'admin' || !users.checkPassword(password, u.password)) return { ok: false, error: 'Wrong email or password' };
  startSession(req, res, u.id);
  return { ok: true, user: u };
}

export async function signup(req, res, { email, password, name }) {
  const e = users.normEmail(email);
  if (!users.EMAIL_RE.test(e) || e === ADMIN_EMAIL) return { ok: false, error: 'Enter a valid email address' };
  if (typeof password !== 'string' || password.length < 8) return { ok: false, error: 'Choose a password of at least 8 characters' };
  if (password.length > 200) return { ok: false, error: 'This password is too long' };
  if (throttled('signup:' + req.ip, 5, 60 * 60 * 1000, 60 * 60 * 1000)) return { ok: false, error: 'Too many new accounts from this connection. Try again later.' };
  if (await users.byEmail(e)) return { ok: false, error: 'An account already exists with this email. Sign in instead.' };
  const u = await users.create({ email: e, password, name });
  startSession(req, res, u.id);
  return { ok: true, user: u };
}

function sameOrigin(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const origin = req.headers.origin;
  return !origin || origin === `${req.protocol}://${req.headers.host}` || origin === `https://${req.headers.host}`;
}

/** Express middleware: pages redirect to /login, API calls get 401. Also blocks cross-origin writes. Sets req.user. */
export function requireAuth(req, res, next) {
  if (!sameOrigin(req)) return res.status(403).json({ error: 'Cross-origin request refused' });
  currentUser(req).then((u) => {
    if (u) { req.user = u; return next(); }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
    res.redirect('/login');
  }, next);
}

/** Like requireAuth, for the owner only (themes admin, AI diagnostics). */
export function requireAdmin(req, res, next) {
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    if (req.user.role === 'admin') return next();
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Only the ili studio team can do this' });
    res.redirect('/');
  });
}
