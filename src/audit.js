// SEO audit: checks pages of an ili studio site (its draft) or of any public website (crawled), and scores them.
import dns from 'node:dns/promises';
import net from 'node:net';
import * as cheerio from 'cheerio';

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// ---- safe fetching of external sites ---------------------------------------------------------
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x.startsWith('::ffff:') && privateIp(x.slice(7));
}
async function assertPublic(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https addresses can be checked.');
  if (u.port && !['80', '443'].includes(u.port)) throw new Error('This address cannot be checked.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw new Error(`We could not find ${host}. Check the address.`); });
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw new Error('This address cannot be checked.');
}
/** GET a public URL (follows up to 4 redirects, each checked), max 2 MB of text. */
export async function safeFetch(url, { timeout = 12000, accept = 'text/html' } = {}) {
  let current = url;
  for (let i = 0; i < 5; i++) {
    await assertPublic(current);
    const r = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(timeout), headers: { 'User-Agent': 'ili-studio-seo-audit/1.0 (+https://ilidweb.uk)', Accept: accept } });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { current = new URL(r.headers.get('location'), current).href; continue; }
    const type = r.headers.get('content-type') || '';
    let text = '';
    if (r.body && /text|html|xml|json/.test(type)) {
      const reader = r.body.getReader(); let size = 0; const parts = [];
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1024 * 1024) { reader.cancel(); break; } parts.push(value); }
      text = Buffer.concat(parts).toString('utf8');
    } else if (r.body) r.body.cancel();
    return { url: current, status: r.status, type, text, headers: r.headers };
  }
  throw new Error('Too many redirects.');
}

/** Crawl a public site from its home page: up to `max` HTML pages on the same host. */
export async function crawl(start, max = 15) {
  const home = new URL(start);
  const first = await safeFetch(home.href);
  if (first.status >= 400) throw new Error(`The site answered with an error (${first.status}).`);
  const origin = new URL(first.url).origin;
  const pages = []; const seen = new Set(); const queue = [first.url]; const statuses = new Map();
  while (queue.length && pages.length < max) {
    const url = queue.shift(); const key = url.split('#')[0];
    if (seen.has(key)) continue; seen.add(key);
    let res;
    try { res = key === first.url ? first : await safeFetch(key); } catch { statuses.set(key, 0); continue; }
    statuses.set(key, res.status);
    if (res.status >= 400 || !/html/.test(res.type)) continue;
    pages.push({ path: new URL(res.url).pathname || '/', url: res.url, html: res.text, status: res.status });
    const $ = cheerio.load(res.text);
    $('a[href]').each((_, a) => {
      try {
        const u = new URL($(a).attr('href'), res.url); u.hash = '';
        if (u.origin === origin && !/\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|mp4|mp3)$/i.test(u.pathname) && !seen.has(u.href) && queue.length < 200) queue.push(u.href);
      } catch { /* bad link */ }
    });
  }
  const robots = await safeFetch(origin + '/robots.txt', { accept: 'text/plain' }).catch(() => null);
  const sitemap = await safeFetch(origin + '/sitemap.xml', { accept: 'application/xml' }).catch(() => null);
  return {
    origin, https: origin.startsWith('https:'), pages, statuses,
    robots: robots && robots.status === 200 && /user-agent|sitemap|disallow|allow/i.test(robots.text) ? robots.text : null,
    sitemap: sitemap && sitemap.status === 200 && /<urlset|<sitemapindex/i.test(sitemap.text),
  };
}

/** Google PageSpeed Insights (free API) for one URL, mobile. Returns null if unavailable. */
export async function pagespeed(url) {
  const key = process.env.PAGESPEED_API_KEY ? `&key=${encodeURIComponent(process.env.PAGESPEED_API_KEY)}` : '';
  try {
    const r = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&category=performance${key}`, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) return null;
    const d = await r.json();
    const a = d.lighthouseResult?.audits || {};
    return {
      score: Math.round((d.lighthouseResult?.categories?.performance?.score ?? 0) * 100),
      lcp: a['largest-contentful-paint']?.displayValue, cls: a['cumulative-layout-shift']?.displayValue, tbt: a['total-blocking-time']?.displayValue,
    };
  } catch { return null; }
}

// ---- checks ------------------------------------------------------------------------------
const W = { error: 10, warning: 4, info: 1 };

/**
 * Analyse pages. pages: [{ path, url, html }]
 * ctx: { kind: 'ili' | 'external', https, robots, sitemap, statuses (Map url -> status), auto (true for ili studio: canonical, sharing, sitemap… added on publish) }
 */
export function analyse(pages, ctx) {
  const issues = [];
  const add = (level, area, title, help, extra = {}) => issues.push({ level, area, title, help, ...extra });
  const out = [];
  const titles = new Map(); const descs = new Map();

  for (const p of pages) {
    const $ = cheerio.load(p.html);
    const page = p.path;
    const title = clean($('head title').first().text());
    const desc = clean($('meta[name="description"]').attr('content'));
    const h1s = $('h1').map((_, h) => clean($(h).text())).get().filter(Boolean);
    $('script, style, noscript, #ili-badge').remove();
    const words = clean($('body').text()).split(' ').filter((w) => /[a-z0-9]/i.test(w)).length;
    const imgs = $('img').toArray();
    const noAlt = imgs.filter((i) => !clean($(i).attr('alt')) && !/placeholder|\.svg/i.test($(i).attr('src') || '')).map((i) => ({ src: $(i).attr('src') || '', id: $(i).attr('data-ili-id') || null }));
    const noindex = /noindex/i.test($('meta[name="robots"]').attr('content') || '');
    const isThanks = /thanks/i.test(page);
    out.push({ page, url: p.url, title, description: desc, h1: h1s[0] || '', words, images: imgs.length, noindex });
    if (isThanks) continue;
    if (title) titles.set(title, [...(titles.get(title) || []), page]);
    if (desc) descs.set(desc, [...(descs.get(desc) || []), page]);

    if (!title) add('error', 'Titles', 'Missing page title', 'Every page needs a title: it is the blue link people click in Google.', { page, fix: 'meta' });
    else if (title.length < 25) add('warning', 'Titles', `Title too short (${title.length} characters)`, 'Aim for 30 to 60 characters: what you do, where, and your name.', { page, fix: 'meta' });
    else if (title.length > 65) add('warning', 'Titles', `Title too long (${title.length} characters)`, 'Google cuts titles after about 60 characters.', { page, fix: 'meta' });
    if (!desc && !ctx.auto) add('error', 'Descriptions', 'Missing meta description', 'Write 70 to 160 characters that make people want to click.', { page, fix: 'meta' });
    else if (!desc || desc.length < 50 || /^local (trade )?business/i.test(desc)) add(ctx.auto ? 'warning' : 'warning', 'Descriptions', ctx.auto ? 'Description written automatically' : `Description too short (${desc.length} characters)`, ctx.auto ? 'ili studio writes one for you when you publish, but your own words will convince more people. Aim for 70 to 160 characters.' : 'Aim for 70 to 160 characters.', { page, fix: 'meta' });
    else if (desc.length > 170) add('info', 'Descriptions', `Description long (${desc.length} characters)`, 'Google usually shows about 155 characters.', { page, fix: 'meta' });
    if (!h1s.length) add('error', 'Content', 'No main heading (H1)', 'Each page should have one main heading that says what the page is about.', { page, fix: 'editor' });
    else if (h1s.length > 1) add('warning', 'Content', `${h1s.length} main headings (H1)`, 'Keep a single H1 per page; use H2 for the sections.', { page, fix: 'editor' });
    if (words < 150) add('warning', 'Content', `Little text (${words} words)`, 'Pages with more useful text (at least 250 to 300 words) rank better. Describe your services, your area and how you work.', { page, fix: 'editor' });
    if (noAlt.length) add('warning', 'Images', `${noAlt.length} image${noAlt.length > 1 ? 's' : ''} without a description`, 'Image descriptions (alt text) help Google and blind visitors.', { page, fix: 'alt', images: noAlt.slice(0, 20) });
    if (noindex) add('error', 'Indexing', 'Page hidden from Google (noindex)', 'This page asks Google not to show it.', { page });
    if (!ctx.auto) {
      if (!$('html').attr('lang')) add('info', 'Technical', 'Language not declared', 'Add lang="en-GB" to the <html> tag.', { page });
      if (!$('meta[name="viewport"]').length) add('error', 'Mobile', 'Not set up for mobile', 'The page has no viewport tag, so it will look tiny on phones.', { page });
      if (!$('link[rel="canonical"]').length) add('info', 'Technical', 'No canonical address', 'A canonical tag tells Google the main address of the page.', { page });
      if (!$('meta[property="og:title"]').length) add('info', 'Sharing', 'No sharing preview', 'Open Graph tags give a nice preview on Facebook, WhatsApp and LinkedIn.', { page });
    }
  }
  for (const [t, ps] of titles) if (ps.length > 1) add('warning', 'Titles', 'Same title on several pages', `"${t.slice(0, 60)}" is used on ${ps.join(', ')}. Each page needs its own title.`, { page: ps[0], fix: 'meta' });
  for (const [, ps] of descs) if (ps.length > 1) add('info', 'Descriptions', 'Same description on several pages', `Used on ${ps.join(', ')}.`, { page: ps[0], fix: 'meta' });

  const home = pages.find((p) => p.path === 'index.html' || p.path === '/') || pages[0];
  if (home) {
    const $ = cheerio.load(home.html);
    if (!$('a[href^="tel:"]').length) add('warning', 'Local', 'Phone number not clickable', 'On mobile, a tap-to-call phone number brings more calls.', { page: home.path, fix: 'editor' });
    if (!ctx.auto && !/LocalBusiness|Organization|"@type"/i.test($('script[type="application/ld+json"]').text())) add('warning', 'Local', 'No business information for Google', 'Structured data (LocalBusiness) helps Google show your business details.', { page: home.path });
  }
  if (!ctx.auto) {
    if (!ctx.https) add('error', 'Security', 'Not secure (no HTTPS)', 'Browsers show "Not secure" and Google ranks HTTPS sites higher.');
    if (!ctx.robots) add('info', 'Indexing', 'No robots.txt', 'A robots.txt file tells search engines how to crawl your site.');
    if (!ctx.sitemap) add('warning', 'Indexing', 'No sitemap.xml', 'A sitemap lists your pages so Google finds them all.');
    const broken = [...(ctx.statuses || new Map())].filter(([, s]) => s >= 400 || s === 0);
    if (broken.length) add('error', 'Links', `${broken.length} broken link${broken.length > 1 ? 's' : ''}`, broken.slice(0, 5).map(([u, s]) => `${u} (${s || 'no answer'})`).join(' · '));
  }
  if (ctx.speed && ctx.speed.score < 50) add('error', 'Speed', `Slow on mobile (${ctx.speed.score}/100)`, 'Compress images and remove heavy scripts.');
  else if (ctx.speed && ctx.speed.score < 80) add('warning', 'Speed', `Could be faster on mobile (${ctx.speed.score}/100)`, 'Compress images and remove heavy scripts.');

  const auto = ctx.auto ? ['Canonical addresses', 'Sharing preview (Facebook, WhatsApp, LinkedIn)', 'Business information for Google (LocalBusiness)', 'sitemap.xml and robots.txt', 'HTTPS', 'Compressed images, loaded when needed'] : [];
  const penalty = issues.reduce((s, i) => s + (W[i.level] || 0), 0);
  const score = Math.max(0, Math.min(100, Math.round(100 - penalty * (8 / Math.max(4, Math.sqrt(pages.length) * 4)))));
  const order = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.level] - order[b.level]);
  return { score, pages: out, issues, auto, counts: { error: issues.filter((i) => i.level === 'error').length, warning: issues.filter((i) => i.level === 'warning').length, info: issues.filter((i) => i.level === 'info').length } };
}
