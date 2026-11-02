// HTML helpers: tag elements with stable ids, apply edit operations, clean output.
import * as cheerio from 'cheerio';

export const ID_ATTR = 'data-ili-id';
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'base']);
const SVG_INNER = (el) => el.parents('svg').length > 0;

export function load(html) {
  return cheerio.load(html, { xml: false });
}

/** Highest numeric id already used on the page (ids look like "e12"). */
function maxId($) {
  let max = 0;
  $(`[${ID_ATTR}]`).each((_, el) => {
    const n = parseInt(String($(el).attr(ID_ATTR)).slice(1), 36);
    if (n > max) max = n;
  });
  return max;
}

/** Give every element inside <body> a stable id, so edits can target it. */
export function tag(html) {
  const $ = load(html);
  let next = maxId($) + 1;
  $('body *').each((_, el) => {
    const $el = $(el);
    if (SKIP.has(el.tagName) || SVG_INNER($el) || $el.attr(ID_ATTR)) return;
    $el.attr(ID_ATTR, 'e' + (next++).toString(36));
  });
  return $.html();
}

/** Remove editor ids, for publishing. */
export function strip(html) {
  const $ = load(html);
  $(`[${ID_ATTR}]`).removeAttr(ID_ATTR);
  $('script[data-ili-editor]').remove();
  return $.html();
}

// ---- sanitising rich text coming from the editor --------------------------
const INLINE_OK = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'br', 'span', 'a', 'small', 'sup', 'sub', 'mark', 'code', 'abbr', 'time',
  'svg', 'path', 'g', 'circle', 'rect', 'line', 'polyline', 'polygon', 'use', 'img']);
const ATTR_OK = new Set(['class', 'style', 'href', 'target', 'rel', 'title', 'src', 'alt', 'width', 'height', 'loading', ID_ATTR,
  'd', 'viewbox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'xmlns', 'cx', 'cy', 'r', 'x', 'y',
  'x1', 'x2', 'y1', 'y2', 'points', 'aria-hidden', 'role', 'datetime']);

const badUrl = (v) => /^\s*(javascript|vbscript|data:text\/html)/i.test(v || '');

export function sanitizeInline(fragment) {
  const $ = cheerio.load(`<div id="__r">${fragment}</div>`, { xml: false });
  const root = $('#__r');
  root.find('*').each((_, el) => {
    const $el = $(el);
    if (!INLINE_OK.has(el.tagName)) { $el.replaceWith($el.contents()); return; }
    for (const name of Object.keys(el.attribs || {})) {
      const v = el.attribs[name];
      if (!ATTR_OK.has(name.toLowerCase()) || name.startsWith('on') || ((name === 'href' || name === 'src') && badUrl(v))) $el.removeAttr(name);
    }
  });
  return root.html() ?? '';
}

// ---- edit operations --------------------------------------------------------
const ATTRS_EDITABLE = new Set(['src', 'alt', 'href', 'target', 'title', 'srcset', 'rel']);

/**
 * Apply a list of operations to a page.
 * ops: {type:'html', id, html} | {type:'attr', id, name, value} | {type:'remove', id}
 *      {type:'duplicate', id} | {type:'move', id, dir:'up'|'down'}
 */
export function applyOps(html, ops) {
  const $ = load(html);
  let next = maxId($) + 1;
  const results = [];
  const find = (id) => {
    if (!/^e[0-9a-z]+$/.test(String(id))) throw new Error('Bad element id');
    const el = $(`[${ID_ATTR}="${id}"]`).first();
    if (!el.length) throw new Error('Element not found: ' + id);
    return el;
  };
  for (const op of ops) {
    const el = find(op.id);
    switch (op.type) {
      case 'html': {
        el.html(sanitizeInline(String(op.html ?? '')));
        // new inline children (e.g. a link added by the user) need ids too
        el.find('*').each((_, c) => { if (!$(c).attr(ID_ATTR) && !SVG_INNER($(c))) $(c).attr(ID_ATTR, 'e' + (next++).toString(36)); });
        break;
      }
      case 'attr': {
        const name = String(op.name).toLowerCase();
        if (!ATTRS_EDITABLE.has(name)) throw new Error('Attribute not editable: ' + name);
        const value = op.value == null ? null : String(op.value);
        if ((name === 'href' || name === 'src') && badUrl(value)) throw new Error('Unsafe URL');
        if (value === null || value === '') el.removeAttr(name); else el.attr(name, value);
        if (name === 'src' && el.is('img')) { el.removeAttr('srcset'); el.parent('picture').find('source').remove(); }
        if (name === 'target' && value === '_blank') el.attr('rel', 'noopener');
        break;
      }
      case 'remove': {
        if (el.is('body, html')) throw new Error('Cannot remove this element');
        el.remove();
        break;
      }
      case 'duplicate': {
        const clone = el.clone();
        clone.attr(ID_ATTR, 'e' + (next++).toString(36));
        clone.find(`[${ID_ATTR}]`).each((_, c) => $(c).attr(ID_ATTR, 'e' + (next++).toString(36)));
        el.after(clone);
        results.push({ op: 'duplicate', id: op.id, newId: clone.attr(ID_ATTR) });
        break;
      }
      case 'move': {
        if (op.dir === 'up') { const prev = el.prev(); if (prev.length) prev.before(el); }
        else { const nxt = el.next(); if (nxt.length) nxt.after(el); }
        break;
      }
      default: throw new Error('Unknown operation: ' + op.type);
    }
  }
  return { html: $.html(), results };
}

/** Inject the editor script into a draft page served to the editor frame. */
export function injectEditor(html) {
  const tagStr = '<script src="/_ili/frame.js" data-ili-editor defer></script>';
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, tagStr + '</body>') : html + tagStr;
}

/** Page title, for the dashboard. */
export function title(html) {
  const $ = load(html);
  return $('title').first().text().trim() || $('h1').first().text().trim() || '';
}
