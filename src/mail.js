// Outgoing e-mail (form notifications). Any SMTP account works, e.g. noreply@ilidweb.uk on the DirectAdmin server.
//   SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASS, SMTP_FROM ("ili studio <noreply@ilidweb.uk>"), SMTP_SECURE (true for port 465)
import nodemailer from 'nodemailer';

const cfg = {
  host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true' || Number(process.env.SMTP_PORT) === 465,
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
};
const FROM = process.env.SMTP_FROM || (process.env.SMTP_USER ? `ili studio <${process.env.SMTP_USER}>` : '');
let transport = null;
if (cfg.host && FROM) transport = nodemailer.createTransport({ ...cfg, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 });

export const mailEnabled = () => !!transport;

/** Send a plain-text e-mail. Returns true when sent, false when e-mail is not configured. Throws on SMTP errors. */
export async function sendMail({ to, subject, text, replyTo }) {
  if (!transport) return false;
  await transport.sendMail({ from: FROM, to, subject, text, replyTo: replyTo || undefined });
  return true;
}
