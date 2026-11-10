// The e-mails ili studio sends, in British English. Links are signed and expire (see makeToken in auth.js).
import { layout, sendQuiet, APP_URL } from './mail.js';
import { makeToken } from './auth.js';

const first = (u) => (u.name ? u.name.split(' ')[0] : '');
const hi = (u) => (first(u) ? `Hi ${first(u)},` : 'Hello,');

/** The bit of the password hash a reset link is tied to: once the password changes, old links stop working. */
export const pwBind = (u) => String(u.password || '').slice(-16);

export function sendWelcome(u) {
  const m = layout({
    title: 'Welcome to ili studio',
    paras: [hi(u), 'Your account is ready. Pick a design, tell us about your business, and our AI writes your website for you. You can then change anything yourself, and publish it in one click.',
      'Your free site gets its own address on yela.uk, a contact form and visitor statistics, at no cost.'],
    button: { label: 'Open ili studio', url: APP_URL },
    after: ['Any question? Just reply to this e-mail.'],
  });
  return sendQuiet({ to: u.email, subject: 'Welcome to ili studio', replyTo: 'hello@ilidweb.uk', ...m }, `welcome to ${u.id}`);
}

export function sendReset(u) {
  const url = `${APP_URL}/reset?t=${makeToken({ k: 'reset', u: u.id }, 60, pwBind(u))}`;
  const m = layout({
    title: 'Choose a new password',
    paras: [hi(u), 'Someone (we hope you) asked to reset the password of your ili studio account. Click the button to choose a new one.'],
    button: { label: 'Choose a new password', url },
    after: ['This link works once and expires in 1 hour.', 'If you did not ask for this, ignore this e-mail: your password stays the same.'],
  });
  return sendQuiet({ to: u.email, subject: 'Reset your ili studio password', ...m }, `reset to ${u.id}`);
}

export function sendRecipientConfirm(site, email, owner) {
  const url = `${APP_URL}/confirm/recipient?t=${makeToken({ k: 'rcpt', s: site.id, e: email }, 7 * 24 * 60)}`;
  const who = owner?.name || owner?.email || 'The owner';
  const m = layout({
    title: 'Receive messages from a website?',
    paras: [`${who} would like the messages sent through the contact form of “${site.name}” to be copied to this address (${email}).`,
      'Click the button to confirm. Nothing is sent to this address until you do.'],
    button: { label: 'Yes, send me the messages', url },
    after: ['This link expires in 7 days.', 'If you do not know this website, ignore this e-mail and you will not hear from us again.'],
  });
  return sendQuiet({ to: email, subject: `Confirm: receive messages from ${site.name}`, ...m }, `recipient confirm ${site.id}`);
}

export function sendEmailChange(u, next) {
  const url = `${APP_URL}/confirm/email?t=${makeToken({ k: 'email', u: u.id, e: next }, 24 * 60, u.email)}`;
  const m = layout({
    title: 'Confirm your new e-mail address',
    paras: [hi(u), `You asked to use ${next} for your ili studio account. Click the button to confirm it. Until then, keep signing in with ${u.email}.`],
    button: { label: 'Confirm my new address', url },
    after: ['This link expires in 24 hours.', 'If you did not ask for this, ignore this e-mail.'],
  });
  return sendQuiet({ to: next, subject: 'Confirm your new e-mail address', ...m }, `email change ${u.id}`);
}

export function sendEmailChanged(u, old) {
  const m = layout({
    title: 'Your e-mail address was changed',
    paras: [hi(u), `Your ili studio account now uses ${u.email} instead of ${old}.`, 'If you did not do this, reply to this e-mail straight away.'],
  });
  return sendQuiet({ to: old, subject: 'Your ili studio e-mail address was changed', replyTo: 'hello@ilidweb.uk', ...m }, `email changed notice ${u.id}`);
}
