// Own domains for client websites (paid plans).
//
// A site's domain lives in its meta: meta.domain = { name, status, addedAt, checkedAt, error }
//   status 'pending'  the client added it; we wait until the DNS points to us
//          'live'     DNS is right: ili-sites answers on it and Traefik gets the HTTPS certificate
//          'paused'   the owner's plan no longer includes a domain: back on the free address
//
// "Points to us" means: the domain AND www.<domain> resolve to SITES_IP (the VPS address,
// comma-separated if there are several). We ask for both, because the HTTPS certificate covers both.
import dns from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import { FREE_DOMAIN } from './plans.js';

export const SITES_IPS = String(process.env.SITES_IP || '').split(',').map((s) => s.trim()).filter(Boolean);
export const CNAME_TARGET = process.env.SITES_CNAME || `connect.${FREE_DOMAIN}`;
const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const OURS = [FREE_DOMAIN, 'ilidweb.uk', 'yela.uk'];

/** "https://www.My-Shop.co.uk/contact" → "my-shop.co.uk". Returns null if it is not a usable domain. */
export function cleanDomainInput(input) {
  let d = String(input || '').trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '').split(/[/?#:\s]/)[0].replace(/\.$/, '').replace(/^www\./, '');
  d = domainToASCII(d);
  if (!d || !DOMAIN_RE.test(d)) return null;
  if (OURS.some((o) => d === o || d.endsWith('.' + o))) return null;
  return d;
}

// Ask public resolvers, like visitors do, instead of the VPS's own resolver, which can keep an old answer
// (or an old error) for a while after the client fixes their DNS. The system resolver is the last resort.
const PUBLIC_DNS = String(process.env.DNS_SERVERS || '1.1.1.1,8.8.8.8').split(',').map((s) => s.trim()).filter(Boolean);
const resolvers = PUBLIC_DNS.map((ip) => { const r = new dns.Resolver({ timeout: 4000, tries: 2 }); r.setServers([ip]); return r; });
async function addresses(name) {
  for (const r of [...resolvers, dns]) {
    try { const ips = await r.resolve4(name); if (ips.length) return ips; } catch { /* next */ }
  }
  return [];
}

/** Where the domain and its www point today. */
export async function checkDns(name) {
  const [apex, www] = await Promise.all([addresses(name), addresses('www.' + name)]);
  const ours = (ips) => ips.length > 0 && ips.every((ip) => SITES_IPS.includes(ip));
  return { apex, www, apexOk: ours(apex), wwwOk: ours(www), ok: SITES_IPS.length > 0 && ours(apex) && ours(www) };
}

/** What the client must put in their DNS. */
export function dnsRecords(name) {
  return [
    { type: 'A', host: '@', value: SITES_IPS[0] || '(not configured)', note: name },
    { type: 'CNAME', host: 'www', value: CNAME_TARGET, note: 'www.' + name },
  ];
}

/**
 * Check every waiting domain now and then. `each` is called with (meta) for every site that has a domain;
 * the caller decides (plan, DNS) and saves. Every 10 minutes.
 */
export function startDomainCheck(run) {
  const tick = () => run().catch((e) => console.error('[domains]', e.message));
  setTimeout(tick, 20000);
  setInterval(tick, 10 * 60 * 1000).unref();
}
