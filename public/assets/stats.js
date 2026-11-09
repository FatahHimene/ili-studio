const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toast = (m, err) => { const t = $('#toast'); t.textContent = m; t.classList.toggle('err', !!err); t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 4500); };
const fmt = (n) => Number(n || 0).toLocaleString('en-GB');
const dayLabel = (d, opts = { day: 'numeric', month: 'short' }) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', opts);
const RANGE_NAMES = { 7: '7 days', 30: '30 days', 90: '3 months', 180: '6 months', 365: '12 months', 730: '2 years' };
const regions = (() => { try { return new Intl.DisplayNames(['en-GB'], { type: 'region' }); } catch { return null; } })();
const flag = (cc) => (/^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '');
const country = (cc) => (/^[A-Z]{2}$/.test(cc) ? `${flag(cc)} ${regions?.of(cc) || cc}` : cc);

const params = new URLSearchParams(location.search);
const state = { site: params.get('site'), days: Number(params.get('days')) || 30, me: null, sites: [], data: null };

async function init() {
  const [me, sites] = await Promise.all([fetch('/api/me').then((r) => r.json()), fetch('/api/sites').then((r) => r.json())]);
  state.me = me;
  state.sites = sites.sort((a, b) => (!!b.publishedAt - !!a.publishedAt) || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  if (me.role === 'admin') {
    $('#nav').insertAdjacentHTML('beforeend', '<a href="/themes">Themes</a><a href="/clients">Clients</a>');
    $('#nav a[href="/account"]').remove();
  }
  const opts = (me.role === 'admin' ? ['<option value="all">All sites</option>'] : []).concat(state.sites.map((s) => `<option value="${s.id}">${esc(s.name)}${s.publishedAt ? '' : ' (not published)'}</option>`));
  if (!opts.length) return empty('You have no site yet', 'Create your first site, publish it, and its visitors will show up here.', '<a class="btn btn-primary" href="/">Create a site</a>');
  $('#site').innerHTML = opts.join('');
  if (!state.site || ![...$('#site').options].some((o) => o.value === state.site)) state.site = $('#site').options[0].value;
  $('#site').value = state.site;
  $('#site').onchange = () => { state.site = $('#site').value; load(); };
  load();
}

function empty(title, text, action = '') {
  $('#body').hidden = true;
  const e = $('#empty'); e.hidden = false;
  e.innerHTML = `<h2>${esc(title)}</h2><p>${esc(text)}</p>${action}`;
}

function renderRanges(d) {
  $('#ranges').innerHTML = Object.entries(RANGE_NAMES).map(([n, label]) => {
    const locked = Number(n) > d.max;
    return `<button type="button" data-days="${n}" aria-pressed="${Number(n) === d.range}" class="${locked ? 'locked' : ''}"${locked ? ' title="More history on a higher plan"' : ''}>${label}</button>`;
  }).join('');
}
$('#ranges').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.classList.contains('locked')) {
    const { offersModal } = await import('/_ili/offers.js');
    return offersModal({ title: 'See more history', intro: 'Free keeps 30 days of statistics, Essential 6 months, Plus and Pro 2 years.', current: state.me.plan });
  }
  state.days = Number(b.dataset.days); load();
});

async function load() {
  const url = state.site === 'all' ? `/api/admin/stats?days=${state.days}` : `/api/sites/${state.site}/stats?days=${state.days}`;
  const r = await fetch(url);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return toast(d.error || 'Could not load the statistics', true);
  state.data = d; state.days = d.range;
  history.replaceState(null, '', `/stats?site=${state.site}&days=${d.range}`);
  renderRanges(d);
  if (!d.all && !d.live && !d.totals.views) return empty('This site is not published yet', 'Publish it and we will start counting its visitors straight away.', `<a class="btn btn-primary" href="/editor/${state.site}">Open in the editor</a>`);
  $('#empty').hidden = true; $('#body').hidden = false;
  renderKpis(d); renderChart(); renderTable(d);
  $('#pagesTitle').textContent = d.all ? 'Sites with the most visitors' : 'Most viewed pages';
  bars('#pages', d.all ? d.sites.map((s) => ({ name: s.name, count: s.visitors, sub: s.owner })) : d.pages.map((p) => ({ ...p, name: p.name === '/' ? 'Home page' : p.name })), d.all ? 'No visits yet.' : 'No page views yet.');
  bars('#sources', d.sources, 'No visitors yet.');
  bars('#countries', d.countries.map((c) => ({ ...c, name: country(c.name) })), 'No visitors yet.');
  bars('#devices', d.devices, 'No visitors yet.');
}

function delta(cur, prev) {
  if (prev == null) return '';
  const span = RANGE_NAMES[state.data.range];
  if (!prev) return cur ? `<span class="d">new · nothing in the previous ${span}</span>` : `<span class="d">same as the previous ${span}</span>`;
  const p = Math.round(((cur - prev) / prev) * 100);
  return `<span class="d"><b>${p > 0 ? '▲' : p < 0 ? '▼' : '='} ${Math.abs(p)}%</b> vs the previous ${span}</span>`;
}
function renderKpis(d) {
  const pv = d.previous || {};
  $('#kpis').innerHTML = [
    ['Visitors', d.totals.visitors, pv.visitors, 's1'],
    ['Page views', d.totals.views, pv.views, 's2'],
    ['Contact messages', d.totals.messages, pv.messages, ''],
  ].map(([k, v, p, s]) => `<div class="kpi"><span class="k">${s ? `<i class="${s}"></i>` : ''}${k}</span><span class="v">${fmt(v)}</span>${d.previous ? delta(v, p) : '<span class="d">&nbsp;</span>'}</div>`).join('');
}

/** Days, or weeks when the period is long, so the line stays readable. */
function points() {
  const days = state.data.days;
  if (days.length <= 120) return days.map((d) => ({ ...d, label: dayLabel(d.date), long: dayLabel(d.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) }));
  const out = [];
  for (let i = 0; i < days.length; i += 7) {
    const w = days.slice(i, i + 7);
    out.push({ date: w[0].date, visitors: w.reduce((n, d) => n + d.visitors, 0), views: w.reduce((n, d) => n + d.views, 0), messages: w.reduce((n, d) => n + d.messages, 0), label: dayLabel(w[0].date), long: `Week of ${dayLabel(w[0].date, { day: 'numeric', month: 'short', year: 'numeric' })}` });
  }
  return out;
}

function niceMax(v) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v)), n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

function renderChart() {
  const pts = points();
  const weekly = pts.length !== state.data.days.length;
  $('#chartTitle').textContent = weekly ? 'Visitors per week' : 'Visitors per day';
  const box = $('#chart');
  const W = Math.max(300, box.clientWidth), H = box.clientHeight;
  const m = { l: 44, r: 14, t: 12, b: 26 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const ymax = niceMax(Math.max(...pts.map((p) => p.views), 1));
  const x = (i) => m.l + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
  const y = (v) => m.t + ih - (v / ymax) * ih;
  const line = (k) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join('');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * ymax);
  const every = Math.max(1, Math.ceil(pts.length / Math.max(2, Math.floor(iw / 70))));
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${weekly ? 'Weekly' : 'Daily'} visitors and page views, ${esc(RANGE_NAMES[state.data.range])}">
    <g class="axis">${ticks.map((t) => `<line class="${t ? 'gl' : 'base'}" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${fmt(Math.round(t * 10) / 10)}</text>`).join('')}
      ${pts.map((p, i) => (i % every === 0 ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(p.label)}</text>` : '')).join('')}</g>
    <path class="ar" fill="var(--series-1)" d="${line('visitors')}L${x(pts.length - 1)},${y(0)}L${x(0)},${y(0)}Z"/>
    <path class="ln" stroke="var(--series-2)" d="${line('views')}"/>
    <path class="ln" stroke="var(--series-1)" d="${line('visitors')}"/>
    <g id="hover" hidden><line class="cross" y1="${m.t}" y2="${m.t + ih}"/><circle class="dot" r="5" fill="var(--series-2)"/><circle class="dot" r="5" fill="var(--series-1)"/></g>
    <rect x="${m.l - 10}" y="0" width="${iw + 20}" height="${H}" fill="transparent" id="hit"/>
  </svg>`;
  const hover = box.querySelector('#hover'), tip = $('#tip');
  const [cross] = hover.getElementsByTagName('line'); const [dv, du] = hover.getElementsByTagName('circle');
  const move = (e) => {
    const r = box.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((px - m.l) / iw) * (pts.length - 1))));
    const p = pts[i];
    hover.hidden = false;
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
    dv.setAttribute('cx', x(i)); dv.setAttribute('cy', y(p.views));
    du.setAttribute('cx', x(i)); du.setAttribute('cy', y(p.visitors));
    tip.hidden = false;
    tip.innerHTML = `<b>${esc(p.long)}</b><div class="r"><span><i style="background:var(--series-1)"></i>Visitors</span><span>${fmt(p.visitors)}</span></div><div class="r"><span><i style="background:var(--series-2)"></i>Page views</span><span>${fmt(p.views)}</span></div>${p.messages ? `<div class="r"><span>Messages</span><span>${fmt(p.messages)}</span></div>` : ''}`;
    const tx = r.left + (x(i) / W) * r.width;
    tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, tx + 14 + tip.offsetWidth > window.innerWidth ? tx - tip.offsetWidth - 14 : tx + 14)) + 'px';
    tip.style.top = Math.max(8, e.clientY - tip.offsetHeight - 12) + 'px';
  };
  const hit = box.querySelector('#hit');
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => { hover.hidden = true; tip.hidden = true; });
}

function renderTable(d) {
  const rows = [...d.days].reverse();
  $('#table').innerHTML = `<table><thead><tr><th>Day</th><th>Visitors</th><th>Page views</th><th>Messages</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(dayLabel(r.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))}</td><td>${fmt(r.visitors)}</td><td>${fmt(r.views)}</td><td>${fmt(r.messages)}</td></tr>`).join('')}</tbody></table>`;
}

function bars(sel, list, none) {
  const max = Math.max(...list.map((x) => x.count), 1);
  const total = list.reduce((n, x) => n + x.count, 0);
  $(sel).innerHTML = list.length ? list.map((x) => `<li><span class="n" title="${esc(x.name)}">${esc(x.name)}${x.sub ? ` <span class="muted">· ${esc(x.sub)}</span>` : ''}</span><span class="c"><b>${fmt(x.count)}</b> · ${Math.round((x.count / total) * 100)}%</span><span class="b"><i style="width:${Math.max(2, (x.count / max) * 100)}%"></i></span></li>`).join('') : `<li><span class="none">${esc(none)}</span></li>`;
}

let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => state.data && !$('#body').hidden && renderChart(), 150); });
init();
