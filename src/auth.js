// Single-admin authentication for the prototype (password from ADMIN_PASSWORD).
import crypto from 'node:crypto';

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
let PASSWORD = process.env.ADMIN_PASSWORD;
if (!PASSWORD) {
  PASSWORD = crypto.randomBytes(9).toString('base64url');
  console.warn(`\n[ili studio] ADMIN_PASSWORD is not set. Temporary password for this run: ${PASSWORD}\n`);
}
const COOKIE = 'ili_s';
const TTL = 1000 * 60 * 60 * 24 * 7; // 7 days

const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/** Capability token for the editor frame (the sandboxed frame cannot send cookies). */
export const frameToken = (siteId) => sign('frame:' + siteId).slice(0, 24);
export const checkFrameToken = (siteId, t) => typeof t === 'string' && eq(t, frameToken(siteId));

function readCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

export function isAuthed(req) {
  const c = readCookie(req, COOKIE);
  if (!c) return false;
  const [exp, sig] = c.split('.');
  return !!exp && !!sig && eq(sig, sign(exp)) && Number(exp) > Date.now();
}

const attempts = new Map(); // ip -> {n, until}
export function login(req, res, password) {
  const ip = req.ip;
  const a = attempts.get(ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) return { ok: false, error: 'Too many attempts. Try again in a few minutes.' };
  if (typeof password !== 'string' || !eq(crypto.createHash('sha256').update(password).digest('hex'), crypto.createHash('sha256').update(PASSWORD).digest('hex'))) {
    a.n += 1; if (a.n >= 5) { a.until = Date.now() + 10 * 60 * 1000; a.n = 0; }
    attempts.set(ip, a);
    return { ok: false, error: 'Wrong password' };
  }
  attempts.delete(ip);
  const exp = String(Date.now() + TTL);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TTL / 1000}${secure ? '; Secure' : ''}`);
  return { ok: true };
}

export function logout(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

/** Express middleware: pages redirect to /login, API calls get 401. Also blocks cross-origin writes. */
export function requireAuth(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && origin !== `${req.protocol}://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
      return res.status(403).json({ error: 'Cross-origin request refused' });
    }
  }
  if (isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
  res.redirect('/login');
}
