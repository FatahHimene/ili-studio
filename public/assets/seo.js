// SEO tool: audits of ili studio sites and of any public website, and fixes for ili studio sites.
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg, err = false) {
  const t = $('#toast'); t.innerHTML = msg; t.classList.toggle('err', err); t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 4500);
}
async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: opts.body ? { 'Content-Type': 'application/json' } : {} });
  if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || 'Something went wrong'); e.code = d.code; throw e; }
  return d;
}
const ago = (iso) => { if (!iso) return 'never'; const s = (Date.now() - new Date(iso)) / 1000; if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`; return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };
const scoreClass = (n) => (n >= 80 ? 'good' : n >= 50 ? 'mid' : 'bad');
const badge = (a) => (a ? `<span class="sc ${scoreClass(a.score)}">${a.score}</span>` : '<span class="sc none">–</span>');
const pageName = (p) => (p === 'index.html' || p === '/' ? 'Home' : p.replace(/\.html?$/, '').replace(/^\//, '').replace(/[-_/]+/g, ' ').replace(/^./, (c) => c.toUpperCase()));

const state = { data: null, sel: null, audit: null, tab: 'audit', me: null };

async function load() {
  state.data = await api('/api/seo');
  const { sites, external, limit } = state.data;
  $('#sites').innerHTML = sites.length ? sites.map((s) => `<button class="sitem${state.sel?.kind === 'site' && state.sel.id === s.id ? ' on' : ''}" data-k="site" data-id="${s.id}" type="button">
      ${badge(s.audit)}<span><b>${esc(s.name)}</b><small>${s.publishedAt ? 'Live' : 'Draft'} · audit ${ago(s.audit?.at)}</small></span></button>`).join('')
    : '<p class="muted small">No site yet. <a href="/?new=1">Create one from a theme</a>.</p>';
  $('#ext').innerHTML = external.length ? external.map((e) => `<div class="sitem-wrap"><button class="sitem${state.sel?.kind === 'ext' && state.sel.id === e.id ? ' on' : ''}" data-k="ext" data-id="${e.id}" type="button">
      ${badge(e.audit)}<span><b>${esc(e.host)}</b><small>audit ${ago(e.audit?.at)}</small></span></button><button class="x" data-del="${e.id}" type="button" title="Remove" aria-label="Remove ${esc(e.host)}">✕</button></div>`).join('')
    : '<p class="muted small">Check the website you have today, even if it was not made with ili studio.</p>';
  $('#extNote').textContent = `You can check ${limit} other website${limit > 1 ? 's' : ''} on your plan.`;
}

async function select(kind, id, tab) {
  state.sel = { kind, id }; state.tab = tab || 'audit';
  const item = kind === 'site' ? state.data.sites.find((s) => s.id === id) : state.data.external.find((e) => e.id === id);
  if (!item) return;
  document.querySelectorAll('.sitem').forEach((b) => b.classList.toggle('on', b.dataset.k === kind && b.dataset.id === id));
  $('#empty').hidden = true; $('#detail').hidden = false;
  $('#dName').textContent = kind === 'site' ? item.name : item.host;
  $('#dSub').textContent = kind === 'site' ? (item.publishedAt ? 'ili studio site · live' : 'ili studio site · not published yet') : item.url;
  state.audit = await api(`/api/seo/audit/${kind === 'site' ? 'site' : 'ext'}/${id}`);
  if (!state.audit) await run();
  else render();
  history.replaceState(null, '', `/seo?${kind}=${id}${state.tab !== 'audit' ? '&tab=' + state.tab : ''}`);
}

async function run() {
  const b = $('#run'); b.disabled = true; b.textContent = 'Checking…';
  document.querySelector('[data-p="audit"]').innerHTML = `<div class="working"><div class="spin"></div><p>${state.sel.kind === 'ext' ? 'Reading the website page by page and testing its speed. This takes up to a minute.' : 'Checking every page of your site.'}</p></div>`;
  showTab('audit');
  try { state.audit = await api(`/api/seo/audit/${state.sel.kind === 'site' ? 'site' : 'ext'}/${state.sel.id}`, { method: 'POST' }); render(); load(); }
  catch (e) { document.querySelector('[data-p="audit"]').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  finally { b.disabled = false; b.textContent = 'Run the audit again'; }
}

function showTab(t) {
  if (t === 'advanced' || t === 'audit' || t === 'improve') state.tab = t;
  document.querySelectorAll('.ptabs [data-t]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.t === state.tab)));
  document.querySelectorAll('.tpane').forEach((p) => { p.hidden = p.dataset.p !== state.tab; });
}

function render() {
  const a = state.audit; const isSite = state.sel.kind === 'site';
  $('#run').textContent = 'Run the audit again';
  const groups = {};
  for (const i of a.issues) (groups[i.area] ||= []).push(i);
  document.querySelector('[data-p="audit"]').innerHTML = `
    <div class="sum">
      <div class="ring ${scoreClass(a.score)}" style="--p:${a.score}"><b>${a.score}</b><small>/100</small></div>
      <div class="sumtxt">
        <h3>${a.score >= 80 ? 'Good shape' : a.score >= 50 ? 'Room to improve' : 'Needs work'}</h3>
        <p><span class="lv error">${a.counts.error} to fix</span> <span class="lv warning">${a.counts.warning} to improve</span> <span class="lv info">${a.counts.info} tips</span></p>
        <p class="muted small">${a.pages.length} page${a.pages.length > 1 ? 's' : ''} checked · ${ago(a.at)}${a.speed ? ` · mobile speed ${a.speed.score}/100` : ''}</p>
        ${a.issues.some((i) => i.fix) && isSite ? '<button class="btn btn-primary btn-sm" data-go="improve" type="button">Fix these now →</button>' : ''}
      </div>
    </div>
    ${a.auto?.length ? `<div class="auto"><h4>Done for you by ili studio</h4><ul>${a.auto.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${Object.entries(groups).map(([area, list]) => `<div class="grp"><h4>${esc(area)}</h4>${list.map((i) => `
      <div class="iss ${i.level}"><span class="lv ${i.level}">${{ error: 'Fix', warning: 'Improve', info: 'Tip' }[i.level]}</span>
        <div><b>${esc(i.title)}</b>${i.page ? ` <span class="pg">${esc(pageName(i.page))}</span>` : ''}<p>${esc(i.help)}</p></div></div>`).join('')}</div>`).join('')}
    ${!a.issues.length ? '<p class="okmsg">No problem found. Well done!</p>' : ''}
    ${!isSite ? promo() : ''}`;
  renderImprove();
  showTab(state.tab);
}

function promo() {
  return `<div class="promo"><div><span class="label">ili studio</span><h3>Want all of this fixed for you?</h3>
    <p>Rebuild your website from a designer-made theme: titles, descriptions, sharing previews, Google business information, sitemap and fast images are all handled automatically. Free to start.</p></div>
    <a class="btn btn-primary" href="/?new=1">Start from a theme →</a></div>`;
}

function renderImprove() {
  const pane = document.querySelector('[data-p="improve"]'); const a = state.audit;
  if (state.sel.kind !== 'site') {
    const fixes = a.issues.filter((i) => i.level !== 'info');
    pane.innerHTML = `<p class="muted">Here is what to change on <b>${esc(a.name)}</b>. Ask whoever manages your website, or let ili studio handle it.</p>
      <ol class="todo">${fixes.map((i) => `<li><b>${esc(i.title)}</b>${i.page ? ` <span class="pg">${esc(pageName(i.page))}</span>` : ''}<p>${esc(i.help)}</p></li>`).join('') || '<li>Nothing important to change.</li>'}</ol>${promo()}`;
    return;
  }
  const alts = a.issues.filter((i) => i.fix === 'alt');
  const edits = a.issues.filter((i) => i.fix === 'editor');
  pane.innerHTML = `
    <h3 class="ih">Titles and descriptions</h3>
    <p class="muted small">This is what people see in Google. Write it for humans: what you do, where, and why choose you.</p>
    ${a.pages.filter((p) => !/thanks/i.test(p.page)).map((p) => `<form class="meta" data-page="${esc(p.page)}">
      <div class="mh"><b>${esc(pageName(p.page))}</b><button class="btn btn-sm wren" type="button" data-wren>✦ Write with Wren <small>1 credit</small></button></div>
      <label>Title <small class="cnt" data-c="t"></small><input class="input" name="title" maxlength="90" value="${esc(p.title)}"></label>
      <label>Description <small class="cnt" data-c="d"></small><textarea class="input" name="description" rows="2" maxlength="200">${esc(p.description)}</textarea></label>
      <div class="serp"><span class="su">${esc(siteUrl())}${p.page === 'index.html' ? '' : esc(p.page)}</span><span class="st"></span><span class="sd"></span></div>
      <div class="row"><button class="btn btn-sm btn-dark" type="submit">Save</button><span class="muted small" data-msg></span></div>
    </form>`).join('')}
    ${alts.length ? `<h3 class="ih">Image descriptions</h3><p class="muted small">Describe what each image shows, in a few words.</p>
      ${alts.map((i) => i.images.map((im) => `<form class="alt" data-page="${esc(i.page)}" data-id="${esc(im.id || '')}">
        <img src="${esc(frameSrc(i.page, im.src))}" alt="" loading="lazy"><input class="input" name="alt" placeholder="e.g. Plumber fitting a new boiler in a kitchen" maxlength="150">
        <button class="btn btn-sm" type="submit" ${im.id ? '' : 'disabled'}>Save</button></form>`).join('')).join('')}` : ''}
    ${edits.length ? `<h3 class="ih">In the editor</h3>${edits.map((i) => `<div class="iss ${i.level}"><span class="lv ${i.level}">${{ error: 'Fix', warning: 'Improve', info: 'Tip' }[i.level]}</span>
      <div><b>${esc(i.title)}</b> <span class="pg">${esc(pageName(i.page))}</span><p>${esc(i.help)}</p></div>
      <a class="btn btn-sm" href="/editor/${state.sel.id}">Open the editor →</a></div>`).join('')}` : ''}
    <p class="muted small" style="margin-top:20px">Changes are saved in your site. <a href="/editor/${state.sel.id}">Publish</a> to put them online, then run the audit again.</p>`;
  pane.querySelectorAll('form.meta').forEach(meterForm);
}

const siteUrl = () => { const s = state.data.sites.find((x) => x.id === state.sel.id); return s?.subdomain ? `${s.subdomain}.yela.uk › ` : 'yoursite › '; };
let token = null;
function frameSrc(page, src) {
  if (!src || /^(https?:|data:)/.test(src)) return src;
  return token ? `/frame/${state.sel.id}/${token}/${new URL(src, 'http://x/' + page).pathname.slice(1)}` : '';
}

function meterForm(f) {
  const t = f.elements.title, d = f.elements.description;
  const upd = () => {
    const tl = t.value.trim().length, dl = d.value.trim().length;
    f.querySelector('[data-c="t"]').textContent = `${tl} / 60`; f.querySelector('[data-c="t"]').className = 'cnt ' + (tl >= 30 && tl <= 60 ? 'ok' : 'warn');
    f.querySelector('[data-c="d"]').textContent = `${dl} / 155`; f.querySelector('[data-c="d"]').className = 'cnt ' + (dl >= 70 && dl <= 160 ? 'ok' : 'warn');
    f.querySelector('.st').textContent = t.value.trim().slice(0, 62) + (t.value.trim().length > 62 ? '…' : '') || 'Page title';
    f.querySelector('.sd').textContent = d.value.trim().slice(0, 158) + (d.value.trim().length > 158 ? '…' : '') || 'Description of the page.';
  };
  t.oninput = upd; d.oninput = upd; upd();
  f.onsubmit = async (e) => {
    e.preventDefault(); const m = f.querySelector('[data-msg]'); m.textContent = 'Saving…';
    try { await api(`/api/sites/${state.sel.id}/seo-meta`, { method: 'POST', body: JSON.stringify({ page: f.dataset.page, title: t.value, description: d.value }) }); m.textContent = 'Saved ✓'; }
    catch (err) { m.textContent = err.message; }
  };
  f.querySelector('[data-wren]').onclick = async (e) => {
    const b = e.currentTarget; b.disabled = true; const m = f.querySelector('[data-msg]'); m.textContent = 'Wren is writing…';
    try {
      const r = await api(`/api/sites/${state.sel.id}/seo-write`, { method: 'POST', body: JSON.stringify({ page: f.dataset.page }) });
      t.value = r.title; d.value = r.description; upd(); m.textContent = `Check it, then Save.${r.credits != null ? ` ${r.credits} credits left.` : ''}`;
    } catch (err) {
      m.textContent = err.message;
      if (err.code === 'no_credits') { const { offersModal } = await import('/_ili/offers.js'); offersModal({ title: 'You have used your AI credits', intro: 'You can still write your titles and descriptions yourself. Or choose a plan to get Wren back.', actions: '<button class="btn btn-dark" type="button" data-close>Write it myself</button>' }); }
    } finally { b.disabled = false; }
  };
}

// ---- events -------------------------------------------------------------------------------------
document.addEventListener('click', async (e) => {
  const it = e.target.closest('.sitem'); if (it) { if (it.dataset.k === 'site') token = (await api(`/api/sites/${it.dataset.id}`)).frameToken; select(it.dataset.k, it.dataset.id); return; }
  const del = e.target.closest('[data-del]');
  if (del) {
    if (del.dataset.confirm !== '1') { del.dataset.confirm = '1'; del.textContent = '?'; setTimeout(() => { del.dataset.confirm = ''; del.textContent = '✕'; }, 2500); return; }
    await api(`/api/seo/external/${del.dataset.del}`, { method: 'DELETE' });
    if (state.sel?.id === del.dataset.del) { state.sel = null; $('#detail').hidden = true; $('#empty').hidden = false; }
    load(); return;
  }
  const go = e.target.closest('[data-go]'); if (go) { showTab(go.dataset.go); return; }
  const tab = e.target.closest('.ptabs [data-t]'); if (tab) showTab(tab.dataset.t);
});
document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (f.id === 'addExt') {
    e.preventDefault();
    try { const item = await api('/api/seo/external', { method: 'POST', body: JSON.stringify({ url: f.elements.url.value }) }); f.reset(); await load(); select('ext', item.id); }
    catch (err) {
      toast(esc(err.message), true);
      if (err.code === 'ext_limit') { const { offersModal } = await import('/_ili/offers.js'); offersModal({ title: 'Check more websites', intro: 'Paid plans let you check up to 5 websites, and your own ili studio sites always get full SEO.' }); }
    }
  } else if (f.classList.contains('alt')) {
    e.preventDefault();
    const v = f.elements.alt.value.trim(); if (!v) return;
    try {
      await api(`/api/sites/${state.sel.id}/ops`, { method: 'POST', body: JSON.stringify({ page: f.dataset.page, ops: [{ type: 'attr', id: f.dataset.id, name: 'alt', value: v }] }) });
      f.classList.add('done'); f.querySelector('button').textContent = 'Saved ✓';
    } catch (err) { toast(esc(err.message), true); }
  }
});
$('#run').onclick = run;

// ---- start ----------------------------------------------------------------------------------------
fetch('/api/me').then((r) => r.json()).then((me) => { if (me.role === 'admin') $('#nav').insertAdjacentHTML('beforeend', '<a href="/themes">Themes</a>'); }).catch(() => {});
await load();
const q = new URLSearchParams(location.search);
if (q.get('site')) { token = (await api(`/api/sites/${q.get('site')}`).catch(() => ({}))).frameToken; select('site', q.get('site'), q.get('tab') || undefined); }
else if (q.get('ext')) select('ext', q.get('ext'));
