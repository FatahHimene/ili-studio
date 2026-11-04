// Basic SEO, applied automatically to every published page:
// title and description, canonical URL, social sharing preview (Open Graph / Twitter), LocalBusiness structured data
// on the home page, image loading hints, plus sitemap.xml and robots.txt for the site.
// (Image width/height attributes are not added: with some theme CSS they would distort photos.)
import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const cut = (s, n) => { s = clean(s); if (s.length <= n) return s; const t = s.slice(0, n - 1); return t.slice(0, Math.max(t.lastIndexOf(' '), n - 20)).replace(/[\s,.;:–-]+$/, '') + '…'; };
const PLACEHOLDER_DESC = /^(local (trade )?business\.?|description|lorem)/i;
const pageUrl = (base, page) => base + (page === 'index.html' ? '' : page);

/** Best description for a page: its own meta if real, else its first meaningful paragraph. */
function describe($, site) {
  const own = clean($('meta[name="description"]').attr('content'));
  if (own && own.length >= 50 && !PLACEHOLDER_DESC.test(own)) return cut(own, 158);
  let text = '';
  $('main p, section p, p').each((_, p) => {
    if (text) return;
    const $p = $(p);
    if ($p.closest('header, nav, footer, form, [data-ili-reviews], #ili-badge').length) return;
    const t = clean($p.text());
    if (t.length >= 60) text = t;
  });
  const b = site.brief || {};
  if (!text) text = [site.name, b.trade && `${b.trade}${b.town ? ' in ' + b.town : ''}`, b.services].filter(Boolean).join(' · ');
  return cut(text, 158);
}

/** First real content image of the page (for the sharing preview), as an absolute URL. */
function shareImage($, base, page) {
  let src = null;
  $('img[src]').each((_, img) => {
    if (src) return;
    const s = $(img).attr('src');
    if (!s || /^data:|\.svg(\?|$)|placeholder/i.test(s) || $(img).closest('header, footer').length) return;
    src = s;
  });
  if (!src) return null;
  try { return new URL(src, pageUrl(base, page)).href; } catch { return null; }
}

function setMeta($, attr, key, value) {
  if (!value) return;
  let m = $(`head meta[${attr}="${key}"]`);
  if (!m.length) { m = $(`<meta ${attr}="${key}">`); $('head').append(m); }
  m.attr('content', value);
}

/**
 * Apply basic SEO to one published page.
 * ctx: { site (meta), base (site URL ending with /), page }
 */
export function seoPage(html, ctx) {
  const { site, base, page } = ctx;
  const $ = cheerio.load(html);
  const b = site.brief || {};
  if (!$('html').attr('lang')) $('html').attr('lang', 'en-GB');
  if (!$('head').length) return html;

  // title
  let title = clean($('head title').first().text());
  if (!title) { title = page === 'index.html' ? [site.name, b.trade].filter(Boolean).join(' · ') : `${cut(page.replace(/\.html?$/, '').replace(/[-_]/g, ' '), 40)} · ${site.name}`; $('head').append(`<title></title>`); $('head title').first().text(title); }

  // description, canonical, sharing preview
  const desc = describe($, site);
  setMeta($, 'name', 'description', desc);
  const url = pageUrl(base, page);
  $('head link[rel="canonical"]').remove();
  $('head').append(`<link rel="canonical" href="${url}">`);
  const noindex = /^thanks\.html?$/i.test(page);
  if (noindex) setMeta($, 'name', 'robots', 'noindex');
  setMeta($, 'property', 'og:type', 'website');
  setMeta($, 'property', 'og:site_name', site.name);
  setMeta($, 'property', 'og:title', title);
  setMeta($, 'property', 'og:description', desc);
  setMeta($, 'property', 'og:url', url);
  setMeta($, 'property', 'og:locale', 'en_GB');
  const img = shareImage($, base, page);
  setMeta($, 'property', 'og:image', img);
  setMeta($, 'name', 'twitter:card', img ? 'summary_large_image' : 'summary');
  setMeta($, 'name', 'twitter:title', title);
  setMeta($, 'name', 'twitter:description', desc);
  setMeta($, 'name', 'twitter:image', img);

  // LocalBusiness structured data (home page, sites made from a brief)
  $('script[type="application/ld+json"][data-ili-seo]').remove();
  if (page === 'index.html' && (b.business || site.name)) {
    const data = {
      '@context': 'https://schema.org', '@type': 'LocalBusiness',
      name: b.business || site.name, url: base, description: desc,
      ...(img && { image: img }),
      ...(b.phone && { telephone: b.phone }),
      ...(b.email && { email: b.email }),
      ...((b.town || b.address) && { address: { '@type': 'PostalAddress', ...(b.address && { streetAddress: b.address }), ...(b.town && { addressLocality: b.town }), addressCountry: 'GB' } }),
      ...(b.town && { areaServed: b.town }),
      ...(b.services && { makesOffer: String(b.services).split(',').map((s) => clean(s)).filter(Boolean).slice(0, 10).map((s) => ({ '@type': 'Offer', itemOffered: { '@type': 'Service', name: s } })) }),
      ...(site.reviews?.profileUrl && { sameAs: [site.reviews.profileUrl] }),
    };
    // Note: no aggregateRating. Google does not allow businesses to mark up reviews about themselves.
    $('head').append(`<script type="application/ld+json" data-ili-seo>${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`);
  }

  // images: the first one loads first, the others lazily
  const imgs = $('img').toArray();
  for (let i = 0; i < imgs.length; i++) {
    const $i = $(imgs[i]);
    if (i === 0) { $i.attr('fetchpriority', 'high'); $i.removeAttr('loading'); } else if (!$i.attr('loading')) $i.attr('loading', 'lazy');
    if (!$i.attr('decoding')) $i.attr('decoding', 'async');
    if ($i.attr('alt') === undefined) $i.attr('alt', '');
  }
  return { html: $.html(), indexable: !noindex, url };
}

/** sitemap.xml and robots.txt for the published site. */
export async function seoFiles(dir, base, entries) {
  const now = new Date().toISOString().slice(0, 10);
  const urls = entries.filter((e) => e.indexable).map((e) => `  <url><loc>${e.url}</loc><lastmod>${now}</lastmod></url>`).join('\n');
  await fs.writeFile(path.join(dir, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  await fs.writeFile(path.join(dir, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /_form\n\nSitemap: ${base}sitemap.xml\n`);
}
