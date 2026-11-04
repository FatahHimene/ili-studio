// Customer reviews, managed by the site owner and shown in the theme's own design.
//
// Theme markup (any tags, the attributes matter):
//   <div data-ili-reviews>                                   the reviews block
//     <article data-ili-review>                              one card, used as the template for every review
//       <span data-ili-review-rating>★★★★★</span>
//       <p data-ili-review-text>…</p>
//       <b data-ili-review-author>…</b> <span data-ili-review-date>…</span>
//       <span data-ili-review-source>Google</span> <a data-ili-review-link href="#">See on Google</a>
//     </article>
//   </div>
//   <p data-ili-reviews-summary>…</p>                         optional: "4.9 ★ · 120 reviews on Google"
//   <a data-ili-reviews-cta href="#">Leave us a review</a>    optional: link to the owner's review page
//
// Two ways to fill it: reviews typed in by the owner (mode "manual"), or the platform's official widget (mode "widget").
import * as cheerio from 'cheerio';
import { ID_ATTR } from './html.js';

export const PLATFORMS = {
  google: { name: 'Google', hosts: ['google.com', 'google.co.uk', 'g.page', 'maps.app.goo.gl', 'goo.gl'] },
  trustpilot: { name: 'Trustpilot', hosts: ['trustpilot.com'] },
  facebook: { name: 'Facebook', hosts: ['facebook.com', 'fb.com'] },
  checkatrade: { name: 'Checkatrade', hosts: ['checkatrade.com'] },
  trustatrader: { name: 'TrustATrader', hosts: ['trustatrader.com'] },
  yell: { name: 'Yell', hosts: ['yell.com'] },
  mybuilder: { name: 'MyBuilder', hosts: ['mybuilder.com'] },
  ratedpeople: { name: 'Rated People', hosts: ['ratedpeople.com'] },
  houzz: { name: 'Houzz', hosts: ['houzz.co.uk', 'houzz.com'] },
  tripadvisor: { name: 'Tripadvisor', hosts: ['tripadvisor.co.uk', 'tripadvisor.com'] },
  feefo: { name: 'Feefo', hosts: ['feefo.com'] },
  reviewsio: { name: 'Reviews.io', hosts: ['reviews.io', 'reviews.co.uk'] },
  other: { name: 'Other', hosts: [] },
};

// Official widgets may load scripts and frames from these hosts only.
const WIDGET_HOSTS = ['trustpilot.com', 'elfsight.com', 'elfsightcdn.com', 'trustindex.io', 'reviews.io', 'reviews.co.uk', 'feefo.com', 'checkatrade.com',
  'trustatrader.com', 'yell.com', 'facebook.com', 'facebook.net', 'google.com', 'tripadvisor.com', 'tripadvisor.co.uk', 'tacdn.com', 'houzz.com', 'houzz.co.uk',
  'ratedpeople.com', 'mybuilder.com', 'shapo.io', 'embedsocial.com', 'sociablekit.com', 'featurable.com'];
const hostOk = (url) => {
  try { const h = new URL(url, 'https://x.invalid').hostname.toLowerCase(); return WIDGET_HOSTS.some((w) => h === w || h.endsWith('.' + w)); } catch { return false; }
};
const httpUrl = (u) => { try { const x = new URL(String(u || '').trim()); return /^https?:$/.test(x.protocol) ? x.href.slice(0, 500) : ''; } catch { return ''; } };
const txt = (v, n) => String(v ?? '').replace(/\r/g, '').trim().slice(0, n);

/** Keep only the safe parts of a pasted widget: markup, scripts and frames from known review platforms. */
export function sanitizeWidget(code) {
  const raw = String(code || '').trim();
  if (!raw) return { html: '', removed: 0 };
  if (raw.length > 20000) throw new Error('This code is too long for a review widget.');
  const $ = cheerio.load(`<div id="w">${raw}</div>`, null, false);
  const OK = new Set(['div', 'span', 'a', 'p', 'b', 'strong', 'em', 'i', 'img', 'script', 'iframe', 'section', 'blockquote', 'br', 'small', 'noscript', 'ul', 'li']);
  let removed = 0;
  $('#w *').each((_, el) => {
    const $el = $(el); const tag = el.tagName.toLowerCase();
    if (!OK.has(tag)) { $el.remove(); removed++; return; }
    for (const name of Object.keys(el.attribs || {})) {
      const v = el.attribs[name];
      if (/^on/i.test(name) || name === 'style' && /expression|javascript/i.test(v) || /^(href|src|data-src)$/i.test(name) && /^\s*javascript:/i.test(v)) $el.removeAttr(name);
    }
    if (tag === 'script') {
      const src = $el.attr('src');
      if (!src || !hostOk(src) || $el.html().trim()) { $el.remove(); removed++; return; }
      [...Object.keys(el.attribs)].forEach((n) => { if (!/^(src|async|defer|type|charset|data-[\w-]+)$/i.test(n)) $el.removeAttr(n); });
      if ($el.attr('type') && !/^(text\/javascript|module)$/i.test($el.attr('type'))) $el.removeAttr('type');
    }
    if (tag === 'iframe' && !hostOk($el.attr('src') || '')) { $el.remove(); removed++; }
  });
  const html = $('#w').html().trim();
  return { html, removed };
}

/** Validate what the editor sends. */
export function cleanReviews(input) {
  const b = input && typeof input === 'object' ? input : {};
  const platform = PLATFORMS[b.platform] ? b.platform : 'google';
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 30).map((r, i) => ({
    id: txt(r.id, 20).replace(/[^\w-]/g, '') || `r${Date.now().toString(36)}${i}`,
    author: txt(r.author, 80), rating: Math.max(1, Math.min(5, Math.round(Number(r.rating) || 5))),
    text: txt(r.text, 1200), date: txt(r.date, 30), link: httpUrl(r.link),
    source: PLATFORMS[r.source] ? r.source : platform,
  })).filter((r) => r.text && r.author);
  const mode = b.mode === 'widget' ? 'widget' : 'manual';
  const out = {
    platform, mode, items,
    profileUrl: httpUrl(b.profileUrl), reviewUrl: httpUrl(b.reviewUrl),
    overall: b.overall === '' || b.overall == null ? null : Math.max(1, Math.min(5, Math.round(Number(b.overall) * 10) / 10)) || null,
    count: b.count === '' || b.count == null ? null : Math.max(0, Math.min(1e6, Math.round(Number(b.count)))) || null,
    widget: '', genuine: !!b.genuine, updatedAt: new Date().toISOString(),
  };
  if (mode === 'widget') out.widget = sanitizeWidget(b.widget).html;
  if (mode === 'manual' && items.length && !out.genuine) throw new Error('Please confirm these are genuine reviews from real customers.');
  if (mode === 'widget' && !out.widget) throw new Error('Paste the widget code given by the review platform.');
  return out;
}

const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
const platformName = (id) => (PLATFORMS[id] || PLATFORMS.other).name;

/** Does this page have a reviews block? */
export const hasReviewsBlock = (html) => /data-ili-reviews(?![-\w])/.test(html);

/** Fill the theme's reviews blocks of one page with the owner's reviews (or widget). */
export function renderReviews(html, rv) {
  if (!rv || !hasReviewsBlock(html) && !/data-ili-reviews-(cta|summary)/.test(html)) return html;
  const $ = cheerio.load(html);
  const name = platformName(rv.platform);
  const link = rv.reviewUrl || rv.profileUrl;

  $('[data-ili-reviews]').each((_, box) => {
    const $box = $(box);
    $box.find('.ili-reviews-widget').remove();
    const cards = $box.find('[data-ili-review]');
    cards.removeAttr('hidden');
    if (rv.mode === 'widget' && rv.widget) {
      cards.attr('hidden', '');
      $box.append(`<div class="ili-reviews-widget">${rv.widget}</div>`);
      return;
    }
    if (!rv.items.length || !cards.length) return; // keep the theme's placeholder cards
    const tpl = cards.first().clone();
    const parent = cards.first().parent();
    cards.remove();
    for (const r of rv.items) {
      const c = tpl.clone();
      c.removeAttr(ID_ATTR); c.find(`[${ID_ATTR}]`).removeAttr(ID_ATTR);
      const src = platformName(r.source);
      c.attr('data-ili-source', r.source);
      c.find('[data-ili-review-text]').text(r.text);
      c.find('[data-ili-review-author]').text(r.author);
      const rating = c.find('[data-ili-review-rating]');
      rating.text(stars(r.rating)).attr('aria-label', `${r.rating} out of 5 stars`).attr('role', 'img');
      // empty parts are hidden, never removed, so the card keeps its full structure for the next render
      const date = c.find('[data-ili-review-date]');
      if (r.date) date.text(r.date).removeAttr('hidden'); else date.text('').attr('hidden', '');
      c.find('[data-ili-review-source]').text(src);
      const a = c.find('a[data-ili-review-link]');
      if (r.link) a.attr('href', r.link).attr('target', '_blank').attr('rel', 'noopener nofollow').text(`See on ${src}`).removeAttr('hidden');
      else a.attr('href', '#').attr('hidden', '');
      parent.append(c);
    }
  });

  $('[data-ili-reviews-summary]').each((_, el) => {
    const avg = rv.overall || (rv.items.length ? Math.round((rv.items.reduce((s, r) => s + r.rating, 0) / rv.items.length) * 10) / 10 : null);
    if (!avg) return;
    $(el).text(`${avg.toFixed(1)} ★${rv.count ? ` · ${rv.count.toLocaleString('en-GB')} reviews` : ''} on ${name}`);
  });
  $('a[data-ili-reviews-cta]').each((_, el) => {
    if (!link) return;
    $(el).attr('href', link).attr('target', '_blank').attr('rel', 'noopener').text(rv.reviewUrl ? `Leave us a review on ${name}` : `See all our reviews on ${name}`);
  });
  return $.html();
}
