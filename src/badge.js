// The small "Website made with Ilidweb" bar at the very bottom of free websites.
// ili-sites adds it when it serves a page (so it never depends on the theme and follows plan changes
// without publishing again); ili studio adds it at publish time only when it serves the sites itself.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const FONT = "500 13px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif";

export function badgeHtml(sub) {
  const href = 'https://ilidweb.uk/ili-studio/';
  return `<div id="ili-badge" style="all:initial;display:block;background:#0D1221;text-align:center;padding:10px 16px;font:${FONT}">`
    + `<a href="${href}" style="all:initial;cursor:pointer;color:#F6F7F9;font:${FONT};text-decoration:none">`
    + `Website made with <b style="all:initial;color:#C8F031;font:700 13px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif">Ilidweb</b> · Create yours for free →</a></div>`;
}

/** Put the bar just before the last </body> (or at the end), once. */
export function injectBadge(html, sub) {
  if (html.includes('id="ili-badge"')) return html;
  const badge = badgeHtml(sub);
  return /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, badge + '</body>') : html + badge;
}
