// The registrar, for what Blesta's module does not do: checking availability quickly and writing the DNS records
// of the domains we register (the domains use the registrar's own DNS). Today: Internet.bs.
// To change registrar, only this file changes (plus the module in Blesta).
//
// Settings (Coolify, ili-studio app):
//   INTERNETBS_API_KEY / INTERNETBS_PASSWORD   from Internet.bs → My account → API settings.
//   The VPS IP must be in Internet.bs's list of allowed IPs for the API.
//   INTERNETBS_TEST=1                           use Internet.bs's test API (no real registration)
//   REG_NAMESERVERS   default ns-uk.topdns.com,ns-usa.topdns.com,ns-canada.topdns.com (Internet.bs DNS)

const KEY = process.env.INTERNETBS_API_KEY || '';
const PASS = process.env.INTERNETBS_PASSWORD || '';
const BASE = process.env.INTERNETBS_URL || (process.env.INTERNETBS_TEST === '1' ? 'https://testapi.internet.bs' : 'https://api.internet.bs');
export const NAMESERVERS = String(process.env.REG_NAMESERVERS || 'ns-uk.topdns.com,ns-usa.topdns.com,ns-canada.topdns.com').split(',').map((s) => s.trim()).filter(Boolean);
export const registrarEnabled = () => !!(KEY && PASS);
if (!registrarEnabled()) console.warn('[registrar] INTERNETBS_API_KEY / INTERNETBS_PASSWORD are not set: free domains cannot be registered.');

export class RegistrarError extends Error {}

async function call(command, params = {}) {
  const q = new URLSearchParams({ ApiKey: KEY, Password: PASS, ResponseFormat: 'JSON', ...params });
  const r = await fetch(`${BASE}/${command}`, { method: 'POST', body: q, signal: AbortSignal.timeout(20000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.status === 'FAILURE') throw new RegistrarError(d.message || `Internet.bs ${command}: ${r.status}`);
  return d;
}

/** true / false, or null when the registrar could not say. */
export async function isAvailable(domain) {
  try { const d = await call('Domain/Check', { Domain: domain }); return d.status === 'AVAILABLE'; }
  catch (e) { console.error('[registrar] check', domain, e.message); return null; }
}

/**
 * Point a domain we registered to the websites server: A @ → ip, CNAME www → cname.
 * Removes the registrar's default records on @ and www first. Throws if it did not work (the caller retries later).
 */
export async function pointDomain(domain, ip, cname) {
  const list = await call('Domain/DnsRecord/List', { Domain: domain });
  for (const r of list.records || []) {
    const name = String(r.name || '').toLowerCase().replace(/\.$/, '');
    const onApex = name === domain, onWww = name === 'www.' + domain;
    const keep = (onApex && r.type === 'A' && r.value === ip) || (onWww && r.type === 'CNAME' && String(r.value).replace(/\.$/, '') === cname);
    if (!keep && ((onApex && ['A', 'AAAA', 'CNAME'].includes(r.type)) || onWww)) {
      await call('Domain/DnsRecord/Remove', { FullRecordName: name, Type: r.type, Value: r.value }).catch(() => {});
    }
  }
  const has = (n, t, v) => (list.records || []).some((r) => String(r.name).replace(/\.$/, '').toLowerCase() === n && r.type === t && String(r.value).replace(/\.$/, '') === v);
  if (!has(domain, 'A', ip)) await call('Domain/DnsRecord/Add', { FullRecordName: domain, Type: 'A', Value: ip, Ttl: '3600' });
  if (!has('www.' + domain, 'CNAME', cname)) await call('Domain/DnsRecord/Add', { FullRecordName: 'www.' + domain, Type: 'CNAME', Value: cname, Ttl: '3600' });
}
