// Modules: ready-made blocks (contact, reviews, later booking, payments, shop) that take the look of any theme.
//
// How a module looks like the theme without being written for it:
//  - Themes define standard CSS variables (--ili-primary, --ili-accent, --ili-ink, --ili-bg, --ili-soft,
//    --ili-font-head, --ili-font-body, --ili-radius). The module's own CSS (MODULE_CSS) only uses those.
//  - A theme can also name its own classes in theme.json "ui" (button, buttonAlt, form, section, container):
//    the module then uses the theme's real buttons and form styles.
//
// The contact module is not written into the page. The page keeps an empty slot
//   <div data-ili-module="contact"></div>
// that is filled from the site's settings (meta.contact) each time the page is shown in the editor or published,
// so it is always up to date and undo/versions never break it.
import * as cheerio from 'cheerio';

export const MODULES = [
  { id: 'contact', name: 'Contact', plan: 'free', ready: true, icon: '✉', text: 'WhatsApp, call and email buttons, and a contact form with the fields you choose.' },
  { id: 'reviews', name: 'Customer reviews', plan: 'free', ready: true, icon: '★', text: 'Your real reviews from Google, Trustpilot, Checkatrade… in your site’s design.' },
  { id: 'booking', name: 'Booking & schedule', plan: 'plus', ready: false, icon: '◷', text: 'Let customers book a time: services, opening hours, confirmations and reminders.' },
  { id: 'payments', name: 'Online payments', plan: 'plus', ready: false, icon: '£', text: 'Take deposits and payments with your own Stripe or PayPal account.' },
  { id: 'shop', name: 'Mini shop', plan: 'pro', ready: false, icon: '▦', text: 'Sell a few products: cart, card payment, orders and stock.' },
];

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cls = (s) => String(s || '').replace(/[^\w\s-]/g, '').trim().slice(0, 80);
export const FIELD_TYPES = ['text', 'email', 'tel', 'textarea', 'select', 'date'];
// the four usual fields keep fixed names, so messages, e-mails and "reply to" work the same everywhere
const STD = { name: 'text', email: 'email', phone: 'tel', message: 'textarea' };

/** Default contact settings for a site that has none yet, from its brief. */
export function contactDefaults(brief = {}) {
  return {
    title: '', intro: '',
    whatsapp: { on: !!brief.phone && /^(\+?44|0)7/.test(String(brief.phone).replace(/[\s()-]/g, '')), number: brief.phone || '', message: 'Hello, I found you on your website.' },
    phone: { on: !!brief.phone, number: brief.phone || '' },
    email: { on: !!brief.email, address: brief.email || '' },
    form: {
      on: true,
      fields: [
        { id: 'name', label: 'Your name', type: 'text', required: true },
        { id: 'phone', label: 'Phone', type: 'tel', required: false },
        { id: 'email', label: 'Email', type: 'email', required: true },
        { id: 'message', label: 'How can we help?', type: 'textarea', required: true },
      ],
      submit: 'Send message',
      note: 'We only use your details to reply to your enquiry.',
    },
    recipients: [],
    float: { on: false },
  };
}
export const contactOf = (meta) => meta.contact || contactDefaults(meta.brief);

const str = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const phoneOk = (p) => /^[+\d][\d\s().-]{5,24}$/.test(p);

/** Check and clean contact settings sent by the editor. Throws a user-facing Error. */
export function cleanContact(b, ownerEmail) {
  const c = contactDefaults();
  c.title = str(b.title, 120); c.intro = str(b.intro, 400);
  c.whatsapp = { on: !!b.whatsapp?.on, number: str(b.whatsapp?.number, 30), message: str(b.whatsapp?.message, 200) };
  c.phone = { on: !!b.phone?.on, number: str(b.phone?.number, 30) };
  c.email = { on: !!b.email?.on, address: str(b.email?.address, 200) };
  if (c.whatsapp.on && !phoneOk(c.whatsapp.number)) throw new Error('Enter the WhatsApp number, e.g. 07700 900123.');
  if (c.phone.on && !phoneOk(c.phone.number)) throw new Error('Enter the phone number, e.g. 01273 123456.');
  if (c.email.on && !EMAIL_RE.test(c.email.address)) throw new Error('Enter a valid email address for the Email button.');
  const f = b.form || {};
  const seen = new Set();
  const fields = (Array.isArray(f.fields) ? f.fields : []).slice(0, 12).map((x) => {
    const type = FIELD_TYPES.includes(x.type) ? x.type : 'text';
    let id = String(x.id || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24);
    if (!id || !(id in STD || /^f_[a-z0-9]{3,20}$/.test(id))) id = 'f_' + Math.random().toString(36).slice(2, 8);
    while (seen.has(id)) id = 'f_' + Math.random().toString(36).slice(2, 8);
    seen.add(id);
    const label = str(x.label, 80);
    if (!label) throw new Error('Every form field needs a name.');
    const options = type === 'select' ? (Array.isArray(x.options) ? x.options : String(x.options || '').split('\n')).map((o) => str(o, 80)).filter(Boolean).slice(0, 20) : undefined;
    if (type === 'select' && !options.length) throw new Error(`Add the choices for “${label}”, one per line.`);
    return { id, label, type, required: !!x.required, ...(options ? { options } : {}) };
  });
  c.form = { on: !!f.on, fields, submit: str(f.submit, 40) || 'Send message', note: str(f.note, 200) };
  if (c.form.on && !fields.length) throw new Error('Add at least one field to the form, or switch the form off.');
  if (c.form.on && !fields.some((x) => x.type === 'email' || x.type === 'tel')) throw new Error('The form needs an email or a phone field, so you can reply.');
  const rec = [];
  for (const r of Array.isArray(b.recipients) ? b.recipients.slice(0, 3) : []) {
    const email = str(r.email ?? r, 200).toLowerCase();
    if (!email || email === String(ownerEmail || '').toLowerCase() || rec.some((x) => x.email === email)) continue;
    if (!EMAIL_RE.test(email)) throw new Error(`“${email}” is not a valid email address.`);
    rec.push({ email, verified: !!r.verified });
  }
  c.recipients = rec;
  c.float = { on: !!b.float?.on && c.whatsapp.on };
  if (!c.whatsapp.on && !c.phone.on && !c.email.on && !c.form.on) throw new Error('Switch on at least one way to contact you.');
  return c;
}

/** Keep previous "verified" flags: an address cannot verify itself by being sent again. */
export function keepVerified(next, prev) {
  const ok = new Set((prev?.recipients || []).filter((r) => r.verified).map((r) => r.email));
  next.recipients = next.recipients.map((r) => ({ email: r.email, verified: ok.has(r.email) }));
  return next;
}

/** wa.me wants the number in international form, digits only. UK numbers starting with 0 become 44…. */
export function waNumber(n) {
  let d = String(n || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = '44' + d.slice(1);
  return d.replace(/\D/g, '');
}
const waLink = (c) => `https://wa.me/${waNumber(c.whatsapp.number)}${c.whatsapp.message ? '?text=' + encodeURIComponent(c.whatsapp.message) : ''}`;
const telLink = (n) => 'tel:' + String(n).replace(/[^\d+]/g, '');

const ICON = {
  whatsapp: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.1 5.1 0 0 0 1.1 2.7 11.7 11.7 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6a2.7 2.7 0 0 0 1.8-1.3 2.2 2.2 0 0 0 .1-1.3c0-.1-.2-.2-.5-.3Z"/></svg>',
  phone: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z"/></svg>',
  email: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>',
};

/** The inside of a contact slot. `ui` holds the theme's class names. */
export function contactHtml(c, ui = {}) {
  const btn = cls(ui.button), alt = cls(ui.buttonAlt || ui.button);
  const acts = [];
  if (c.whatsapp.on && waNumber(c.whatsapp.number)) acts.push(`<a class="ili-cbtn ili-cbtn-wa ${alt}" href="${esc(waLink(c))}" target="_blank" rel="noopener">${ICON.whatsapp}<span>WhatsApp</span></a>`);
  if (c.phone.on && c.phone.number) acts.push(`<a class="ili-cbtn ili-cbtn-tel ${alt}" href="${esc(telLink(c.phone.number))}">${ICON.phone}<span>Call ${esc(c.phone.number)}</span></a>`);
  if (c.email.on && c.email.address) acts.push(`<a class="ili-cbtn ili-cbtn-mail ${alt}" href="mailto:${esc(c.email.address)}">${ICON.email}<span>${esc(c.email.address)}</span></a>`);
  let form = '';
  if (c.form.on && c.form.fields.length) {
    const field = (x) => {
      const req = x.required ? ' required' : '';
      const star = x.required ? '' : ' <small class="ili-opt">(optional)</small>';
      const ac = { name: ' autocomplete="name"', email: ' autocomplete="email"', phone: ' autocomplete="tel"' }[x.id] || '';
      let input;
      if (x.type === 'textarea') input = `<textarea name="${x.id}" rows="5" maxlength="5000"${req}></textarea>`;
      else if (x.type === 'select') input = `<select name="${x.id}"${req}><option value="">Choose…</option>${(x.options || []).map((o) => `<option>${esc(o)}</option>`).join('')}</select>`;
      else input = `<input name="${x.id}" type="${x.type}" maxlength="${x.type === 'email' ? 200 : 300}"${ac}${req}>`;
      return `<label class="ili-cf-${x.type === 'textarea' ? 'wide' : 'field'}"><span>${esc(x.label)}${star}</span>${input}</label>`;
    };
    form = `<form class="ili-cform ${cls(ui.form)}" data-ili-form="contact"><input type="hidden" name="_m" value="contact">${c.form.fields.map(field).join('')}`
      + `<button class="ili-cbtn ili-cbtn-send ${btn}" type="submit">${esc(c.form.submit)}</button>`
      + `${c.form.note ? `<p class="ili-cnote">${esc(c.form.note)}</p>` : ''}</form>`;
  }
  return `${c.title ? `<h2 class="ili-ctitle">${esc(c.title)}</h2>` : ''}${c.intro ? `<p class="ili-cintro">${esc(c.intro)}</p>` : ''}`
    + `${acts.length ? `<div class="ili-cacts">${acts.join('')}</div>` : ''}${form}`;
}

/** Base styles of the modules. Low specificity (:where) so the theme's own styles always win. */
export const MODULE_CSS = `
:where(.ili-contact){display:grid;gap:22px;font-family:var(--ili-font-body,inherit)}
:where(.ili-ctitle){margin:0;font-family:var(--ili-font-head,inherit)}
:where(.ili-cintro){margin:0}
:where(.ili-cacts){display:flex;flex-wrap:wrap;gap:10px}
:where(.ili-cbtn){display:inline-flex;align-items:center;justify-content:center;gap:9px;padding:12px 20px;border-radius:var(--ili-radius,8px);font:inherit;font-weight:700;text-decoration:none;cursor:pointer;border:0;line-height:1.2;background:var(--ili-primary,#222);color:#fff}
.ili-cbtn{display:inline-flex;align-items:center;justify-content:center;gap:9px}
.ili-cbtn svg{width:20px;height:20px;flex:none}
:where(.ili-cbtn-send){justify-self:start}
:where(.ili-cform){display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;max-width:680px}
.ili-cform > label{display:grid;gap:6px;font-weight:600;font-size:.95em}
.ili-cform > .ili-cf-wide,.ili-cform > .ili-cbtn-send,.ili-cform > .ili-cnote{grid-column:1/-1}
:where(.ili-cform) :where(input,textarea,select){font:inherit;font-weight:400;padding:12px 14px;border:1px solid color-mix(in srgb,var(--ili-ink,#222) 25%,transparent);border-radius:var(--ili-radius,8px);background:var(--ili-bg,#fff);color:var(--ili-ink,#222);width:100%;box-sizing:border-box}
:where(.ili-cform) :where(input,textarea,select):focus{outline:2px solid var(--ili-primary,#222);outline-offset:1px}
.ili-opt{font-weight:400;opacity:.65}
:where(.ili-cnote){margin:0;font-size:.85em;opacity:.7}
@media (max-width:640px){.ili-cform{grid-template-columns:1fr}}
.ili-wa-float{position:fixed;right:18px;bottom:18px;z-index:2147483000;width:58px;height:58px;border-radius:50%;background:#25D366;color:#fff;display:grid;place-items:center;box-shadow:0 6px 20px rgba(0,0,0,.25);text-decoration:none}
.ili-wa-float svg{width:30px;height:30px}
:where(.ili-reviews){display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
:where(.ili-review){background:var(--ili-soft,#f4f4f4);border-radius:var(--ili-radius,8px);padding:20px}
:where(.ili-review-stars){color:var(--ili-accent,#e5a000);font-size:1.2em;letter-spacing:2px}
:where(.ili-review-who){font-size:.9em;margin:0}
.ili-review-who > :not([hidden]) ~ :not([hidden])::before{content:' · ';opacity:.5}
`.replace(/\n/g, '');

/** A new section with a module, to add to a page from the editor. Uses the theme's own classes when it has them. */
export function sectionHtml(type, ui = {}) {
  const sec = cls(ui.section), wrap = cls(ui.container);
  const inner = {
    contact: '<h2>Get in touch</h2><div data-ili-module="contact"></div>',
    reviews: '<h2>What our customers say</h2><p data-ili-reviews-summary hidden></p>'
      + '<div class="ili-reviews" data-ili-reviews><article class="ili-review" data-ili-review><span class="ili-review-stars" data-ili-review-rating>★★★★★</span>'
      + '<p data-ili-review-text>Your customers’ words appear here once you add your reviews.</p>'
      + '<p class="ili-review-who"><b data-ili-review-author>Customer name</b> <span data-ili-review-date hidden></span> <span data-ili-review-source>Google</span> <a data-ili-review-link href="#" hidden></a></p></article></div>'
      + `<p><a class="ili-cbtn ${cls(ui.buttonAlt || ui.button)}" data-ili-reviews-cta href="#" hidden>Leave us a review</a></p>`,
  }[type];
  if (!inner) return null;
  return `<section class="ili-msec ${sec}" style="padding:56px 0"><div class="${wrap}" style="${wrap ? '' : 'max-width:1100px;margin:0 auto;padding:0 24px'}">${inner}</div></section>`;
}

/**
 * Fill the module slots of a page and add what the modules need (styles, floating WhatsApp button).
 * Used when the page is shown in the editor and when it is published; the stored draft keeps empty slots.
 */
export function renderModules(html, { contact, ui = {}, preview = false }) {
  const hasSlot = /data-ili-module=/.test(html), hasReviews = /data-ili-reviews/.test(html), float = contact?.float?.on && contact.whatsapp?.on && waNumber(contact.whatsapp.number);
  if (!hasSlot && !hasReviews && !float) return html;
  const $ = cheerio.load(html);
  $('[data-ili-module="contact"]').each((_, el) => { $(el).addClass('ili-contact').html(contact ? contactHtml(contact, ui) : ''); });
  if (!$('style[data-ili-modules]').length) ($('head').length ? $('head') : $.root()).append(`<style data-ili-modules>${MODULE_CSS}</style>`);
  $('.ili-wa-float').remove();
  // in the editor the button is only shown (no link), so a click there does not leave the page
  if (float) $('body').append(`<a class="ili-wa-float"${preview ? ' data-ili-preview' : ` href="${esc(waLink(contact))}" target="_blank" rel="noopener"`} aria-label="Chat with us on WhatsApp">${ICON.whatsapp}</a>`);
  return $.html();
}

/** Labels of the form fields, so messages show "Preferred day" rather than "f_x8k2". */
export const fieldLabels = (c) => Object.fromEntries((c?.form?.fields || []).map((f) => [f.id, f.label]));

/**
 * A theme (or older site) that still has its own <form data-ili-form>: turn every such form into a
 * Contact module slot, and read the first form's fields, button text and small print, so the module
 * starts exactly like the theme's form. Returns null when the page has no such form.
 */
export function adoptForms(html) {
  if (!/data-ili-form/.test(html)) return null;
  const $ = cheerio.load(html);
  let form = null;
  $('form[data-ili-form]').each((_, f) => {
    const $f = $(f);
    if (!form) {
      const fields = [], used = new Set();
      $f.find('input, textarea, select').each((__, el) => {
        const $e = $(el);
        const name = String($e.attr('name') || '').toLowerCase();
        const tag = el.tagName.toLowerCase();
        const raw = tag === 'input' ? String($e.attr('type') || 'text').toLowerCase() : tag;
        if (!name || name.startsWith('_') || ['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'reset', 'image'].includes(raw)) return;
        const type = { email: 'email', tel: 'tel', date: 'date', textarea: 'textarea', select: 'select' }[raw] || 'text';
        let id = name in STD ? name : 'f_' + (name.replace(/[^a-z0-9]/g, '') + 'xxx').slice(0, 18);
        if (used.has(id)) return; used.add(id);
        const lab = $e.closest('label');
        let label = lab.length ? lab.clone().find('input, textarea, select, small').remove().end().text() : '';
        if (!label.trim() && $e.attr('id')) label = $(`label[for="${$e.attr('id')}"]`).first().text();
        label = (label.trim() || $e.attr('placeholder') || $e.attr('aria-label') || name).replace(/\s+/g, ' ').replace(/\s*\*\s*$/, '').slice(0, 80);
        const options = type === 'select' ? $e.find('option').toArray().filter((o) => $(o).attr('value') !== '').map((o) => $(o).text().trim()).filter(Boolean).slice(0, 20) : null;
        if (type === 'select' && !options.length) return;
        fields.push({ id, label, type, required: $e.is('[required]'), ...(options ? { options } : {}) });
      });
      const btn = $f.find('button[type="submit"], button:not([type]), input[type="submit"]').first();
      const submit = (btn.is('input') ? btn.attr('value') : btn.text()) || '';
      const note = $f.children('p').last().text() || '';
      form = { fields: fields.slice(0, 12), submit: submit.trim().slice(0, 40), note: note.replace(/\s+/g, ' ').trim().slice(0, 200) };
    }
    $f.replaceWith('<div data-ili-module="contact"></div>');
  });
  return { html: $.html(), form };
}

/** Contact settings for a new site: the brief's phone and email, and the theme's own form if it had one. */
export function contactFromTheme(brief, form) {
  const c = contactDefaults(brief);
  if (form?.fields?.length && form.fields.some((f) => f.type === 'email' || f.type === 'tel')) {
    c.form.fields = form.fields;
    if (form.submit) c.form.submit = form.submit;
    c.form.note = form.note;
  }
  return c;
}
