// Outgoing e-mail. Any SMTP account works, e.g. noreply@ilidweb.uk on the DirectAdmin server, or Brevo, Postmark…
//   SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASS, SMTP_FROM ("ili studio <noreply@ilidweb.uk>"), SMTP_SECURE (true for port 465)
//   APP_URL (https://studio.ilidweb.uk): used for links in e-mails
import nodemailer from 'nodemailer';

const cfg = {
  host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true' || Number(process.env.SMTP_PORT) === 465,
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
};
const FROM = process.env.SMTP_FROM || (process.env.SMTP_USER ? `ili studio <${process.env.SMTP_USER}>` : '');
export const APP_URL = (process.env.APP_URL || 'https://studio.ilidweb.uk').replace(/\/$/, '');
let transport = null;
if (cfg.host && FROM) transport = nodemailer.createTransport({ ...cfg, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 });
if (!transport) console.warn('[mail] SMTP is not set up: e-mails (password reset, copies of messages…) are not sent.');

export const mailEnabled = () => !!transport;
export const mailFrom = () => FROM;

/** Send an e-mail. Returns true when sent, false when e-mail is not configured. Throws on SMTP errors. */
export async function sendMail({ to, subject, text, html, replyTo }) {
  if (!transport) return false;
  await transport.sendMail({ from: FROM, to, subject, text, html: html || undefined, replyTo: replyTo || undefined });
  return true;
}
/** Same, but never throws: logs instead. For e-mails that must not break the request (welcome…). */
export function sendQuiet(msg, what) {
  return sendMail(msg).then((ok) => { if (ok) console.log(`[mail] ${what} sent`); return ok; }).catch((e) => { console.error(`[mail] ${what} failed:`, e.message); return false; });
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * A simple e-mail in the ili studio style, as HTML and plain text.
 * paras: array of paragraphs (plain text). button: { label, url }. after: small paragraphs under the button.
 */
export function layout({ title, paras = [], button = null, after = [] }) {
  const p = (t) => `<p style="margin:0 0 14px;font:16px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#16181d">${esc(t)}</p>`;
  const small = (t) => `<p style="margin:0 0 10px;font:13px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#5b6474">${esc(t)}</p>`;
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;background:#f4f5f2;padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #16181d;border-radius:14px">
<tr><td style="padding:26px 28px 6px;font:700 20px -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#16181d">ili studio</td></tr>
<tr><td style="padding:10px 28px 22px">
<h1 style="margin:0 0 16px;font:700 24px/1.25 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#16181d">${esc(title)}</h1>
${paras.map(p).join('')}
${button ? `<p style="margin:22px 0"><a href="${esc(button.url)}" style="display:inline-block;background:#16181d;color:#ffffff;text-decoration:none;font:600 16px -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:13px 22px;border-radius:10px">${esc(button.label)}</a></p>
${small('If the button does not work, copy this link into your browser:')}<p style="margin:0 0 16px;font:13px monospace;color:#5b6474;word-break:break-all">${esc(button.url)}</p>` : ''}
${after.map(small).join('')}
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #e3e6ea;font:12px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#5b6474">ili studio by Ilidweb · <a href="https://ilidweb.uk" style="color:#5b6474">ilidweb.uk</a></td></tr>
</table></td></tr></table></body></html>`;
  const text = [title, '', ...paras.flatMap((t) => [t, '']), ...(button ? [`${button.label}: ${button.url}`, ''] : []), ...after.flatMap((t) => [t, '']), '--', 'ili studio by Ilidweb · https://ilidweb.uk'].join('\n');
  return { html, text };
}
