// Paid plans through Blesta (my.ilidweb.uk). The client never creates a second account:
//  1. "Choose Essential" in ili studio → we find or create their Blesta client (same e-mail), add a pending
//     service for the plan's package and an invoice, then send them to the invoice's payment page,
//     already signed in (Blesta's Shared Login plugin).
//  2. PayPal tells Blesta, Blesta activates the service and calls our webhook; we then read the client's
//     services back from Blesta and set the plan (and AI credits). The webhook is only a "go and check":
//     what it says is never trusted, the Blesta API is.
//  3. "My invoices" / "Support" open Blesta signed in, on the right page.
//
// Settings (Coolify, ili-studio app):
//   BLESTA_URL          https://my.ilidweb.uk
//   BLESTA_API_USER     API user from Settings → System → API Access
//   BLESTA_API_KEY      its key
//   BLESTA_SHARED_KEY   key of the Shared Login plugin (Settings → Company → Plugins → Shared Login → Manage)
//   BLESTA_PACKAGES     essential:25,plus:26,pro:27   (Blesta package id of each plan)
//   BLESTA_WEBHOOK_KEY  long random text, also in the URL given to Blesta's Webhooks plugin
//   BLESTA_DOMAIN_PACKAGES  .uk:10,.co.uk:11,.org.uk:12  (Blesta TLD package of each extension offered free with a paid plan)
import crypto from 'node:crypto';
import * as users from './users.js';
import { PLANS } from './plans.js';

const URL_ = (process.env.BLESTA_URL || '').replace(/\/$/, '');
const API_USER = process.env.BLESTA_API_USER || '';
const API_KEY = process.env.BLESTA_API_KEY || '';
const SHARED = process.env.BLESTA_SHARED_KEY || '';
export const WEBHOOK_KEY = process.env.BLESTA_WEBHOOK_KEY || '';
const PACKAGES = Object.fromEntries(String(process.env.BLESTA_PACKAGES || '').split(',').map((x) => x.trim().split(':')).filter(([k, v]) => k && /^\d+$/.test(v || '')).map(([k, v]) => [k, Number(v)]));
const PLAN_OF_PACKAGE = Object.fromEntries(Object.entries(PACKAGES).map(([k, v]) => [v, k]));
const RANK = { free: 0, essential: 1, plus: 2, pro: 3 };
const DOMAIN_PACKAGES = Object.fromEntries(String(process.env.BLESTA_DOMAIN_PACKAGES || '.uk:10,.co.uk:11,.org.uk:12').split(',').map((x) => x.trim().split(':')).filter(([k, v]) => /^\.[a-z.]+$/.test(k || '') && /^\d+$/.test(v || '')).map(([k, v]) => [k, Number(v)]));
/** Extensions offered free with a paid plan, longest first (".co.uk" before ".uk"). */
export const FREE_TLDS = Object.keys(DOMAIN_PACKAGES).sort((a, b) => b.length - a.length);
export const tldOf = (domain) => FREE_TLDS.find((t) => domain.endsWith(t) && /^[a-z0-9-]+$/.test(domain.slice(0, -t.length))) || null;

export const billingEnabled = () => !!(URL_ && API_USER && API_KEY && SHARED && Object.keys(PACKAGES).length);
if (!billingEnabled()) console.warn('[billing] Blesta is not set up (BLESTA_URL, BLESTA_API_USER, BLESTA_API_KEY, BLESTA_SHARED_KEY, BLESTA_PACKAGES): plans can only be chosen, not paid.');

export class BillingError extends Error {}

/** Flatten { vars: { a: 1, b: { c: 2 } } } into vars[a]=1&vars[b][c]=2, as Blesta (PHP) expects. */
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? form(x, `${key}[${i}]`, out) : out.append(`${key}[]`, String(x))));
    else if (typeof v === 'object') form(v, key, out);
    else out.append(key, typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v));
  }
  return out;
}

/** Call the Blesta API: api('clients', 'create', { vars: {...} }, 'POST'). Returns `response`. */
async function api(model, method, params = {}, httpMethod = 'GET') {
  const body = form(params);
  const url = `${URL_}/api/${model}/${method}.json${httpMethod === 'GET' && [...body].length ? '?' + body : ''}`;
  const r = await fetch(url, {
    method: httpMethod,
    headers: { authorization: 'Basic ' + Buffer.from(`${API_USER}:${API_KEY}`).toString('base64'), ...(httpMethod === 'GET' ? {} : { 'content-type': 'application/x-www-form-urlencoded' }) },
    body: httpMethod === 'GET' ? undefined : body,
    signal: AbortSignal.timeout(20000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const errs = data.errors ? JSON.stringify(data.errors) : data.message || r.status;
    throw new BillingError(`Blesta ${model}/${method}: ${errs}`);
  }
  return data.response;
}

/** Signed link that opens Blesta signed in as this client, on `path` (Shared Login plugin). */
export function blestaLink(u, path = '/client/') {
  const t = Math.floor(Date.now() / 1000);
  const name = u.blesta?.username || u.email;
  const r = URL_ + path;
  const h = crypto.createHmac('sha256', SHARED).update(`${t}${name}${r}`).digest('hex');
  return `${URL_}/plugin/shared_login/?${new URLSearchParams({ u: name, t: String(t), r, h })}`;
}

/** The Blesta client of this ili studio account, created the first time (same e-mail, no second password to remember). */
export async function ensureClient(u) {
  if (u.blesta?.clientId) return u.blesta;
  let user = await api('users', 'getByUsername', { username: u.email }).catch(() => null);
  let client = user?.id ? await api('clients', 'getByUserId', { user_id: user.id }).catch(() => null) : null;
  if (!client) {
    const [first, ...rest] = String(u.name || '').trim().split(/\s+/);
    const pw = crypto.randomBytes(18).toString('base64url') + 'A1!';
    client = await api('clients', 'create', {
      vars: {
        username: u.email, new_password: pw, confirm_password: pw, email: u.email,
        first_name: first || u.email.split('@')[0], last_name: rest.join(' ') || '-',
        country: 'GB', client_group_id: Number(process.env.BLESTA_CLIENT_GROUP || 1),
        send_registration_email: 'false', settings: { language: 'en_us' },
      },
    }, 'POST');
  }
  u.blesta = { clientId: Number(client.id), username: client.username || u.email };
  await users.save(u);
  return u.blesta;
}

const pricingOf = async (packageId) => {
  const p = await api('packages', 'get', { package_id: packageId });
  const yearly = (p?.pricing || []).find((x) => x.period === 'year' && x.term == 1 && x.currency === 'GBP') || p?.pricing?.[0];
  if (!yearly) throw new BillingError(`Blesta package ${packageId} has no price`);
  return yearly;
};
const servicesOf = async (clientId, status) => (await api('services', 'getAllByClient', { client_id: clientId, status }).catch(() => [])) || [];

/**
 * Start paying for a plan: returns the link to send the client to.
 * Reuses an unpaid invoice for the same plan instead of creating a new one each click.
 */
export async function checkout(u, planId) {
  const pkg = PACKAGES[planId];
  if (!pkg) throw new BillingError('Unknown plan');
  const b = await ensureClient(u);
  const active = (await servicesOf(b.clientId, 'active')).filter((s) => PLAN_OF_PACKAGE[s.package?.id || s.package_id]);
  if (active.length) return { url: blestaLink(u, `/client/services/manage/${active[0].id}/`), existing: true }; // upgrade from Blesta's service page
  // the invoice made the last time this plan was clicked, if it is still unpaid: pay that one
  let invoiceId = null;
  const last = b.pending;
  if (last?.plan === planId && last.invoiceId) {
    const inv = await api('invoices', 'get', { invoice_id: last.invoiceId }).catch(() => null);
    if (inv && inv.status === 'active' && !inv.date_closed && Number(inv.client_id) === b.clientId) invoiceId = inv.id;
  }
  if (!invoiceId) {
    // another plan was clicked before and not paid: cancel that service so only one is waiting
    if (last?.serviceId) await api('services', 'cancel', { service_id: last.serviceId, vars: { date_canceled: 'now', use_module: 'false' } }, 'POST').catch(() => {});
    const price = await pricingOf(pkg);
    const serviceId = await api('services', 'add', {
      vars: { pricing_id: price.id, client_id: b.clientId, status: 'pending', use_module: 'false', qty: 1 },
    }, 'POST');
    invoiceId = await api('invoices', 'createFromServices', {
      client_id: b.clientId, service_ids: [Number(serviceId)], currency: 'GBP', due_date: new Date().toISOString().slice(0, 10),
    }, 'POST');
    u.blesta.pending = { plan: planId, serviceId: Number(serviceId), invoiceId: Number(invoiceId), at: new Date().toISOString() };
    await users.save(u);
  }
  return { url: blestaLink(u, `/client/pay/method/${invoiceId}/`) };
}

/**
 * Register the free domain of a paid plan, in the client's name, through Blesta (which asks the registrar).
 * `who` = { firstName, lastName, company, address1, address2, city, postcode, phone, type: IND|STRA|LTD, companyNumber }.
 * The service is free (price override 0) and renews with the plan. Throws BillingError with a readable message.
 */
export async function registerDomain(u, domain, who, nameservers) {
  const tld = tldOf(domain);
  if (!tld) throw new BillingError('This extension is not included with your plan.');
  const b = await ensureClient(u);
  const client = await api('clients', 'get', { client_id: b.clientId });
  // the client's contact details are the domain's legal owner (Nominet needs a real UK address)
  await api('contacts', 'edit', {
    contact_id: client.contact_id,
    vars: {
      first_name: who.firstName, last_name: who.lastName, company: who.company || '',
      address1: who.address1, address2: who.address2 || '', city: who.city, zip: who.postcode, country: 'GB',
      numbers: [{ number: who.phone, type: 'phone', location: 'work' }],
    },
  }, 'POST');
  const price = await pricingOf(DOMAIN_PACKAGES[tld]);
  const vars = {
    client_id: b.clientId, pricing_id: price.id, status: 'active', use_module: 'true', qty: 1,
    domain, override_price: 0, override_currency: 'GBP',
    DotUkOrgType: who.type, ...(who.type === 'LTD' && who.companyNumber ? { DotUkRegistrationNumber: who.companyNumber } : {}),
  };
  nameservers.slice(0, 5).forEach((ns, i) => { vars['ns' + (i + 1)] = ns; });
  let serviceId;
  try { serviceId = await api('services', 'add', { vars }, 'POST'); }
  catch (e) {
    console.error(`[billing] register ${domain} for ${u.id}:`, e.message);
    throw new BillingError('The registry did not accept this registration. Check your details, or try another name. If it keeps failing, contact us.');
  }
  u.freeDomain = { name: domain, serviceId: Number(serviceId), at: new Date().toISOString() };
  await users.save(u);
  console.log(`[billing] ${u.id}: registered ${domain} (service ${serviceId})`);
  return u.freeDomain;
}

/**
 * Read the client's ili studio services from Blesta and set their plan:
 * the best active package wins; none active → Free (sites and content are kept, only the limits change).
 * Paid plans get their monthly AI credits topped up.
 */
export async function syncUser(u) {
  if (!u.blesta?.clientId) return u;
  const active = (await servicesOf(u.blesta.clientId, 'active')).map((s) => PLAN_OF_PACKAGE[s.package?.id || s.package_id]).filter(Boolean);
  const best = active.sort((a, b) => RANK[b] - RANK[a])[0] || 'free';
  const before = u.plan || 'free';
  if (best !== 'free' && u.blesta.pending?.plan === best) delete u.blesta.pending;
  if (best !== before) {
    u.plan = best; u.planChosen = true;
    if (u.wantsPlan === best || best === 'free') u.wantsPlan = null;
    console.log(`[billing] ${u.id}: ${before} → ${best}`);
    // the free domain stays theirs; it renews free only while a paid plan is active: flag it for the admin
    if (best === 'free' && u.freeDomain && !u.freeDomain.planEndedAt) { u.freeDomain.planEndedAt = new Date().toISOString(); console.warn(`[billing] ${u.id}: plan ended, free domain ${u.freeDomain.name} (service ${u.freeDomain.serviceId}) should renew at the normal price`); }
    if (best !== 'free' && u.freeDomain?.planEndedAt) delete u.freeDomain.planEndedAt;
  }
  const plan = PLANS.find((p) => p.id === u.plan);
  if (plan && plan.price > 0) {
    const last = Date.parse(u.creditsRefilledAt || 0) || 0;
    if (best !== before || Date.now() - last > 30 * 86400000) { u.credits = Math.max(u.credits || 0, plan.credits); u.creditsRefilledAt = new Date().toISOString(); }
  }
  await users.save(u);
  return u;
}

/** Blesta called our webhook: find which client it is about, and check their services. Anything unknown → check everyone. */
export async function onWebhook(payload) {
  const ids = new Set();
  const walk = (o) => { if (!o || typeof o !== 'object') return; for (const [k, v] of Object.entries(o)) { if (k === 'client_id' && /^\d+$/.test(String(v))) ids.add(Number(v)); else walk(v); } };
  walk(payload);
  const all = (await users.list()).filter((x) => x.blesta?.clientId);
  const targets = ids.size ? all.filter((x) => ids.has(x.blesta.clientId)) : all;
  for (const x of targets) await syncUser(x).catch((e) => console.error(`[billing] sync ${x.id}:`, e.message));
  return targets.length;
}

/** Safety net: check every paying client every 6 hours (in case a webhook was missed). */
export function startBillingSync() {
  if (!billingEnabled()) return;
  const run = () => onWebhook({}).catch((e) => console.error('[billing] sync:', e.message));
  setTimeout(run, 60000).unref();
  setInterval(run, 6 * 3600000).unref();
}
