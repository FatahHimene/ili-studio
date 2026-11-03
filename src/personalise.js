// Personalise a theme from the owner's brief: Wren writes the text slots, the photo library fills the image slots,
// and facts (business name, phone, email, town, address) are inserted as given, never invented.
import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { askJson } from './ai.js';
import { searchPhotos, importPhoto, bankStatus } from './images.js';
import { tag } from './html.js';

const FACT_TYPES = new Set(['business', 'phone', 'email', 'town', 'address']);
const MAX_IMAGES = 14;

export function cleanBrief(b = {}) {
  const s = (v, n = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  return {
    business: s(b.business, 80), trade: s(b.trade, 80), town: s(b.town, 80), services: s(b.services, 400),
    audience: s(b.audience, 200), tone: s(b.tone, 40) || 'friendly', phone: s(b.phone, 40), email: s(b.email, 120),
    address: s(b.address, 200), extra: s(b.extra, 600),
  };
}

/** Read every slot of every page. Slots with the same key share one value. */
async function collectSlots(dir, pages) {
  const slots = new Map();
  for (const page of pages) {
    const $ = cheerio.load(await fs.readFile(path.join(dir, page), 'utf8'));
    $('[data-ili-slot]').each((_, el) => {
      const $el = $(el);
      const key = $el.attr('data-ili-slot');
      if (!key || slots.has(key)) return;
      const isImg = el.tagName === 'img';
      slots.set(key, {
        key, type: isImg ? 'image' : ($el.attr('data-ili-type') || 'text'),
        example: isImg ? ($el.attr('alt') || '') : $el.text().replace(/\s+/g, ' ').trim().slice(0, 200),
        hint: $el.attr('data-ili-hint') || '', max: Number($el.attr('data-ili-max')) || 0,
        query: $el.attr('data-ili-query') || '', orientation: $el.attr('data-ili-orientation') || 'horizontal',
      });
    });
  }
  return [...slots.values()];
}

const SYSTEM = `You are Wren, the copywriter inside ili studio. You personalise a website theme made by a professional designer for a small business.
Write short, specific, natural copy for each text slot, in the tone requested. British English unless the brief is written in another language, then use that language.
Never invent facts: no prices, awards, years in business, reviews, testimonials with real-looking names, certifications or statistics that are not in the brief.
For testimonial-like slots, write a clearly generic placeholder the owner will replace (e.g. "Add a review from a happy customer here.").
Respect each slot's maximum length. Plain text only (no HTML, no Markdown).
For each image slot, give a short English photo search query (2–4 words, concrete, about this trade) and a short alt text in the site's language.`;

/**
 * Personalise a site's draft pages in place.
 * @returns {{ usage, images: number }}
 */
export async function personalise(dir, pages, brief, { log = () => {} } = {}) {
  const slots = await collectSlots(dir, pages);
  const textSlots = slots.filter((s) => s.type === 'text');
  const imageSlots = slots.filter((s) => s.type === 'image').slice(0, MAX_IMAGES);
  log(`slots: ${textSlots.length} text, ${imageSlots.length} images`);

  const user = `Brief:
${JSON.stringify(brief, null, 2)}

Text slots (key, example text from the theme, hint, max characters):
${textSlots.map((s) => `- ${s.key} | example: "${s.example}" | hint: ${s.hint || '-'} | max: ${s.max || Math.max(40, s.example.length * 2)}`).join('\n')}

Image slots (key, theme's suggested query):
${imageSlots.map((s) => `- ${s.key} | ${s.query || s.example}`).join('\n')}

Return: {"text": {"<slot key>": "<copy>", ...}, "images": {"<slot key>": {"query": "...", "alt": "..."}, ...}}`;

  const { data, usage } = await askJson({
    system: SYSTEM, user,
    mock: () => ({
      text: Object.fromEntries(textSlots.map((s) => [s.key, `${brief.business || 'Business'}: ${s.key}`])),
      images: Object.fromEntries(imageSlots.map((s) => [s.key, { query: `${brief.trade || 'work'} ${s.key}`, alt: `${brief.trade} photo` }])),
    }),
  });
  const text = data?.text && typeof data.text === 'object' ? data.text : {};
  const imgs = data?.images && typeof data.images === 'object' ? data.images : {};

  // photos: one search per slot, avoid using the same photo twice
  const photos = {};
  if (bankStatus().enabled) {
    const used = new Set();
    for (const s of imageSlots) {
      const q = String(imgs[s.key]?.query || s.query || brief.trade || '').slice(0, 80);
      try {
        const results = await searchPhotos(q, { orientation: s.orientation === 'vertical' ? 'vertical' : s.orientation === 'all' ? 'all' : 'horizontal', perPage: 12 });
        const pick = results.find((r) => !used.has(r.id));
        if (!pick) continue;
        used.add(pick.id);
        const saved = await importPhoto(pick, path.join(dir, 'ili-uploads'));
        photos[s.key] = { file: 'ili-uploads/' + saved.name, alt: String(imgs[s.key]?.alt || pick.tags || '').slice(0, 150), credit: { source: 'pixabay', author: pick.author, page: pick.page } };
      } catch (e) { log(`photo for ${s.key} failed: ${e.message}`); }
    }
  }

  const fact = (type) => ({ business: brief.business, phone: brief.phone, email: brief.email, town: brief.town, address: brief.address }[type] || '');
  for (const page of pages) {
    const file = path.join(dir, page);
    const $ = cheerio.load(await fs.readFile(file, 'utf8'));
    const pageDir = path.posix.dirname(page) === '.' ? '' : path.posix.dirname(page);
    $('[data-ili-slot]').each((_, el) => {
      const $el = $(el); const key = $el.attr('data-ili-slot');
      if (el.tagName === 'img') {
        const p = photos[key]; if (!p) return;
        $el.attr('src', path.posix.relative(pageDir, p.file)); $el.attr('alt', p.alt); $el.removeAttr('srcset');
        return;
      }
      const type = $el.attr('data-ili-type') || 'text';
      if (FACT_TYPES.has(type)) {
        const v = fact(type);
        if (!v) {
          if ($el.attr('data-ili-optional') !== undefined) { const box = $el.parents('[data-ili-optional]').last(); (box.length ? box : $el).remove(); }
          return;
        }
        $el.text(v);
        if (el.tagName === 'a' && type === 'phone') $el.attr('href', 'tel:' + v.replace(/[^\d+]/g, ''));
        if (el.tagName === 'a' && type === 'email') $el.attr('href', 'mailto:' + v);
        return;
      }
      const v = text[key];
      if (typeof v === 'string' && v.trim()) $el.text(v.trim().slice(0, 600));
    });
    if (brief.business) {
      const t = $('title').first();
      const pageName = page === 'index.html' ? '' : t.text().split(/\s[·|–-]\s/)[0].trim();
      t.text(pageName ? `${pageName} · ${brief.business}` : `${brief.business}${brief.trade ? ' · ' + brief.trade : ''}${brief.town ? ' in ' + brief.town : ''}`);
      $('meta[name="description"]').attr('content', `${brief.business}: ${brief.services || brief.trade}${brief.town ? ' in ' + brief.town : ''}.`.slice(0, 160));
    }
    await fs.writeFile(file, tag($.html()));
  }
  return { usage, images: Object.keys(photos).length, credits: Object.values(photos).map((p) => p.credit) };
}
