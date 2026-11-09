// Contact forms on published sites.
// In a theme: <form data-ili-form="contact"> with named fields (name, email, phone, message…).
// On publish the form is pointed at "_form" (same host as the site); messages are kept in DATA_DIR/sites/<id>/messages
// and a copy is e-mailed to the site owner's account address when SMTP is configured.
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import * as store from './store.js';

const msgDir = (siteId) => path.join(store.siteDir(siteId), 'messages');
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;

/** Point every ili form of a published page at the site's form endpoint and add the spam trap. */
export function prepareForms(html) {
  if (!/data-ili-form/i.test(html)) return html;
  const $ = cheerio.load(html);
  $('form[data-ili-form]').each((_, f) => {
    const $f = $(f);
    $f.attr('action', '_form').attr('method', 'post').attr('accept-charset', 'utf-8').removeAttr('target').removeAttr('enctype');
    $f.find('input[name="_hp"], input[name="_form"]').remove();
    $f.prepend(`<input type="hidden" name="_form" value="${String($f.attr('data-ili-form') || 'contact').replace(/[^\w-]/g, '').slice(0, 30)}">`
      + '<div aria-hidden="true" style="position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden">'
      + '<label>Leave this field empty<input type="text" name="_hp" tabindex="-1" autocomplete="off"></label></div>');
  });
  return $.html();
}

// throttles: per IP and per site
const hits = new Map();
function tooMany(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now); hits.set(key, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  return list.length > max;
}

const LABELS = { name: 'Name', email: 'Email', phone: 'Phone', message: 'Message', subject: 'Subject', company: 'Company', postcode: 'Postcode', service: 'Service' };
const label = (k) => LABELS[k] || k.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Validate and keep a submission. Returns { ok, spam, message } or throws a user-facing Error. */
/** `def`: the fields of the contact module's form (from the site's settings), when the message comes from it. */
export async function receive(site, body, ip, def = null) {
  const b = body && typeof body === 'object' ? body : {};
  if (String(b._hp || '').trim()) return { ok: true, spam: true }; // the trap was filled: pretend it worked
  if (tooMany('ip:' + ip, 5, 10 * 60 * 1000)) throw new Error('Too many messages from your connection. Please try again later.');
  if (tooMany('site:' + site.id, 60, 24 * 60 * 60 * 1000)) throw new Error('This form is receiving too many messages right now. Please try again tomorrow, or call us.');
  const fields = {};
  if (def) {
    // contact module: only the fields the owner set up, with their own names
    const labels = {};
    for (const f of def) {
      const raw = b[f.id];
      const val = (Array.isArray(raw) ? raw.join(', ') : String(raw ?? '')).replace(/\r/g, '').trim().slice(0, f.type === 'textarea' ? 5000 : 300);
      if (f.required && !val) throw new Error(`Please fill in “${f.label}”.`);
      if (f.type === 'select' && val && !(f.options || []).includes(val)) throw new Error(`Please choose an option for “${f.label}”.`);
      if (val) { fields[f.id] = val; labels[f.id] = f.label; }
    }
    if (!Object.keys(fields).length) throw new Error('The form was empty.');
    if (fields.email && !EMAIL_RE.test(fields.email)) throw new Error('Please enter a valid email address.');
    const text = Object.values(fields).join(' ');
    const spam = (text.match(/https?:\/\//gi) || []).length > 3;
    const msg = { id: `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, form: 'contact', at: new Date().toISOString(), fields, labels, read: false, spam };
    await fs.mkdir(msgDir(site.id), { recursive: true });
    await fs.writeFile(path.join(msgDir(site.id), msg.id + '.json'), JSON.stringify(msg, null, 2));
    return { ok: true, spam, message: msg };
  }
  for (const [k, v] of Object.entries(b)) {
    if (k.startsWith('_') || !/^[a-z][\w-]{0,30}$/i.test(k) || Object.keys(fields).length >= 12) continue;
    const val = (Array.isArray(v) ? v.join(', ') : String(v ?? '')).replace(/\r/g, '').trim();
    if (val) fields[k.toLowerCase()] = val.slice(0, k.toLowerCase() === 'message' ? 5000 : 300);
  }
  if (!Object.keys(fields).length) throw new Error('The form was empty.');
  if (fields.email && !EMAIL_RE.test(fields.email)) throw new Error('Please enter a valid email address.');
  const links = ((fields.message || '').match(/https?:\/\//gi) || []).length;
  const spam = links > 3;
  const msg = { id: `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, form: String(b._form || 'contact').slice(0, 30), at: new Date().toISOString(), fields, read: false, spam };
  await fs.mkdir(msgDir(site.id), { recursive: true });
  await fs.writeFile(path.join(msgDir(site.id), msg.id + '.json'), JSON.stringify(msg, null, 2));
  return { ok: true, spam, message: msg };
}

export function emailText(site, msg, appUrl) {
  const name = (k) => msg.labels?.[k] || label(k);
  const lines = Object.entries(msg.fields).map(([k, v]) => (k === 'message' ? `\n${name(k)}:\n${v}\n` : `${name(k)}: ${v}`));
  return `New message from your website ${site.name}\n\n${lines.join('\n')}\n\n—\nReply to this e-mail to answer ${msg.fields.name || 'your visitor'} directly.\n${appUrl ? `All your messages: ${appUrl.replace(/\/$/, '')}/messages\n` : ''}Sent by ili studio · Ilidweb`;
}

export async function listMessages(siteIds) {
  const out = [];
  for (const id of siteIds) {
    const dir = msgDir(id);
    if (!fss.existsSync(dir)) continue;
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith('.json')) continue;
      try { out.push({ site: id, ...JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) }); } catch { /* skip */ }
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

const MSG_RE = /^\d{10,16}-[a-f0-9]{6}$/;
export async function updateMessage(siteId, msgId, patch) {
  if (!MSG_RE.test(msgId)) throw new Error('Message not found');
  const f = path.join(msgDir(siteId), msgId + '.json');
  const m = JSON.parse(await fs.readFile(f, 'utf8'));
  Object.assign(m, patch);
  await fs.writeFile(f, JSON.stringify(m, null, 2));
  return m;
}
export async function deleteMessage(siteId, msgId) {
  if (!MSG_RE.test(msgId)) throw new Error('Message not found');
  await fs.rm(path.join(msgDir(siteId), msgId + '.json'), { force: true });
}

/** Built-in thank-you page, used when the theme has no thanks.html. */
export function thanksPage(site, error) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${error ? 'Message not sent' : 'Thank you'} · ${esc(site.name)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:17px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;background:#f5f6f8;color:#16181d;padding:24px}
main{max-width:520px;background:#fff;border-radius:14px;padding:40px;box-shadow:0 10px 40px rgba(0,0,0,.08);text-align:center}h1{margin:0 0 10px;font-size:28px}p{margin:0 0 22px;color:#4a5160}
a{display:inline-block;background:#16181d;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600}</style></head>
<body><main><h1>${error ? 'Your message was not sent' : 'Thank you!'}</h1><p>${error ? esc(error) : `Your message has been sent to ${esc(site.name)}. They will get back to you soon.`}</p>
<a href="${error ? 'javascript:history.back()' : './'}">${error ? '← Go back' : '← Back to the website'}</a></main></body></html>`;
}
