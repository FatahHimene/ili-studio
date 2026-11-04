const $ = (s) => document.querySelector(s);
const grid = $('#grid');
const drop = $('#drop');
const fileInput = $('#file');

function toast(msg, err = false) {
  const t = $('#toast'); t.innerHTML = msg; t.classList.toggle('err', err); t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 4500);
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = (iso) => {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

// ---- account ---------------------------------------------------------------------------
const me = {};
let sites = [];
const liveUrl = (s) => (s.subdomain && me.freeDomain && !/^(localhost|\d+\.\d+\.\d+\.\d+)/.test(location.hostname) && !location.hostname.endsWith('nip.io') ? `https://${s.subdomain}.${me.freeDomain}/` : `/s/${s.subdomain || s.slug}/`);
async function loadMe() {
  const [u, p] = await Promise.all([fetch('/api/me').then((r) => r.json()), fetch('/api/plans').then((r) => r.json())]);
  Object.assign(me, u, { freeDomain: p.freeDomain });
  $('#themesTab').hidden = u.role !== 'admin';
  $('#acct').innerHTML = u.role === 'admin' ? '<span class="tag">Admin</span>'
    : `<span class="who">${esc(u.email)}</span><span class="tag">${esc(u.planInfo.name)}</span><span class="credits" title="AI credits left">✦ ${u.credits} credits</span>${u.plan === 'free' ? '<button class="btn btn-sm btn-primary" id="upBtn" type="button">See plans</button>' : ''}`;
  const up = document.getElementById('upBtn');
  if (up) up.onclick = async () => { const { offersModal } = await import('/_ili/offers.js'); offersModal({ title: 'Choose a plan', intro: 'More pages, more AI credits and your own domain. Your site and everything you made are kept.', current: u.plan }); };
}

// ---- sites list -------------------------------------------------------------------------
async function load() {
  const r = await fetch('/api/sites'); if (r.status === 401) { location.href = '/login'; return; }
  sites = await r.json();
  const unread = sites.reduce((n, s) => n + (s.unread || 0), 0);
  $('#msgTab').innerHTML = unread ? `Messages <span class="tag tag-live">${unread}</span>` : 'Messages';
  grid.querySelectorAll('.card').forEach((c) => c.remove());
  $('#empty').hidden = sites.length > 0;
  for (const s of sites) {
    const status = !s.publishedAt ? '<span class="tag">Draft</span>' : s.dirty ? '<span class="tag tag-warn">Unpublished changes</span>' : '<span class="tag tag-live">Live</span>';
    const origin = s.theme ? `<span>· theme ${esc(s.theme.id)}</span>` : '<span>· imported</span>';
    const el = document.createElement('article');
    el.className = 'card';
    el.innerHTML = `
      <a class="thumb" href="/editor/${s.id}" aria-label="Edit ${esc(s.name)}"><iframe loading="lazy" sandbox="allow-scripts" tabindex="-1" title="" scrolling="no"></iframe></a>
      <div class="meta"><h3>${esc(s.name)}</h3>
        <div class="facts">${status}<span>${s.pages.length} page${s.pages.length > 1 ? 's' : ''}</span>${origin}<span>· edited ${ago(s.updatedAt)}</span>${s.unread ? `<a class="tag tag-live" href="/messages">${s.unread} new message${s.unread > 1 ? 's' : ''}</a>` : ''}${s.ownerEmail !== undefined ? `<span>· ${esc(s.ownerEmail || 'you')}</span>` : ''}</div>
        ${s.publishedAt && s.subdomain ? `<div class="facts"><span class="mono">${esc(s.subdomain)}.${esc(me.freeDomain || '')}</span></div>` : ''}</div>
      <div class="acts">
        <a class="btn btn-sm btn-dark" href="/editor/${s.id}">Edit</a>
        ${s.publishedAt ? `<a class="btn btn-sm" href="${esc(liveUrl(s))}" target="_blank" rel="noopener">View live ↗</a>` : ''}
        <button class="btn btn-sm btn-danger del" data-id="${s.id}" data-name="${esc(s.name)}">Delete</button>
      </div>`;
    grid.appendChild(el);
    fetch(`/api/sites/${s.id}`).then((r2) => r2.json()).then((d) => { el.querySelector('iframe').src = `/frame/${s.id}/${d.frameToken}/index.html?ili-thumb=1`; });
  }
}

grid.addEventListener('click', async (e) => {
  const b = e.target.closest('.del');
  if (!b) return;
  if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Click again to delete'; setTimeout(() => { b.dataset.confirm = ''; b.textContent = 'Delete'; }, 3000); return; }
  const r = await fetch(`/api/sites/${b.dataset.id}`, { method: 'DELETE' });
  if (r.ok) { toast(`Deleted ${esc(b.dataset.name)}`); load(); } else toast('Could not delete this site', true);
});

// ---- import ---------------------------------------------------------------------------------
function upload(file) {
  if (!file) return;
  if (!/\.(zip|html?)$/i.test(file.name)) return toast('Please choose a .zip or .html file', true);
  const fd = new FormData(); fd.append('file', file);
  const xhr = new XMLHttpRequest();
  const prog = $('#prog'); const bar = prog.querySelector('i'); const status = $('#status');
  prog.hidden = false; bar.style.width = '0%'; status.textContent = `Uploading ${file.name}…`;
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) bar.style.width = `${Math.round((e.loaded / e.total) * 100)}%`; };
  xhr.upload.onload = () => { status.textContent = 'Preparing your site…'; };
  xhr.onload = () => {
    prog.hidden = true;
    let d = {}; try { d = JSON.parse(xhr.responseText); } catch { /* */ }
    if (xhr.status >= 400) { status.textContent = ''; return toast(esc(d.error || 'Import failed'), true); }
    location.href = `/editor/${d.id}`;
  };
  xhr.onerror = () => { prog.hidden = true; status.textContent = ''; toast('Upload failed. Check your connection.', true); };
  xhr.open('POST', '/api/sites'); xhr.send(fd);
}
$('#choose').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => upload(fileInput.files[0]));
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => upload(e.dataTransfer.files[0]));
drop.addEventListener('submit', (e) => e.preventDefault());

// ---- new site from a theme -------------------------------------------------------------------
const modal = $('#modal');
let themes = []; let chosen = null; let cat = 'All'; let sub = 'All';
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
function step(name) {
  $('#stepTheme').hidden = name !== 'theme'; $('#stepBrief').hidden = name !== 'brief'; $('#stepWork').hidden = name !== 'work';
  $('#mTitle').textContent = { theme: 'Choose a theme', brief: 'Tell Wren about your business', work: 'Creating your site' }[name];
  $('#mSteps').innerHTML = ['1 Theme', '2 Your business', '3 Personalise'].map((s, i) => (i === ['theme', 'brief', 'work'].indexOf(name) ? `<b>${s}</b>` : s)).join(' · ');
  $('#mClose').hidden = name === 'work';
}
function renderThemes() {
  const cats = ['All', ...new Set(themes.map((t) => t.category))];
  $('#cats').innerHTML = cats.map((c) => `<button type="button" data-cat="${esc(c)}" aria-pressed="${c === cat}">${esc(c)}</button>`).join('');
  const subs = cat === 'All' ? [] : [...new Set(themes.filter((t) => t.category === cat && t.subcategory).map((t) => t.subcategory))];
  $('#subs').hidden = subs.length < 1;
  $('#subs').innerHTML = ['All', ...subs].map((s) => `<button type="button" data-sub="${esc(s)}" aria-pressed="${s === sub}">${esc(s === 'All' ? 'All ' + cat.toLowerCase() : s)}</button>`).join('');
  const words = norm($('#tq').value).split(/\s+/).filter(Boolean);
  const list = themes.filter((t) => (cat === 'All' || t.category === cat) && (sub === 'All' || t.subcategory === sub)
    && words.every((w) => norm([t.name, t.category, t.subcategory, t.description, ...(t.tags || [])].join(' ')).includes(w)));
  $('#tgrid').innerHTML = list.length ? list.map((t) => `
    <article class="tpick">
      <a class="thumb" href="/theme-files/${t.id}/index.html" target="_blank" rel="noopener" aria-label="Preview ${esc(t.name)}">${t.preview ? `<img src="/theme-files/${t.id}/${esc(t.preview)}" alt="">` : `<iframe loading="lazy" sandbox="allow-scripts" tabindex="-1" title="" scrolling="no" src="/theme-files/${t.id}/index.html"></iframe>`}</a>
      <div class="meta"><h3>${esc(t.name)}</h3><div class="facts"><span class="tag">${esc(t.category)}</span>${t.subcategory ? `<span>${esc(t.subcategory)}</span>` : ''}<span>· ${t.pages.length} pages</span></div><p>${esc(t.description)}</p></div>
      <div class="acts"><a class="btn btn-sm" href="/theme-files/${t.id}/index.html" target="_blank" rel="noopener">Preview ↗</a><button class="btn btn-sm btn-primary pick" data-id="${esc(t.id)}" type="button">Use this theme →</button></div>
    </article>`).join('') : `<p class="muted">${themes.length ? 'No theme matches your search. Try another word, or <a href="#" id="tReset">show all themes</a>.' : 'No themes yet.'}</p>`;
  const r = document.getElementById('tReset'); if (r) r.onclick = (e) => { e.preventDefault(); $('#tq').value = ''; cat = 'All'; sub = 'All'; renderThemes(); };
}
$('#cats').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { cat = b.dataset.cat; sub = 'All'; renderThemes(); } });
$('#subs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { sub = b.dataset.sub; renderThemes(); } });
$('#tq').addEventListener('input', () => renderThemes());
$('#tgrid').addEventListener('click', (e) => {
  const b = e.target.closest('.pick'); if (!b) return;
  chosen = themes.find((t) => t.id === b.dataset.id);
  $('#chosen').innerHTML = `<span class="tag tag-live">Theme</span><b>${esc(chosen.name)}</b><span class="muted">${esc(chosen.category)}</span>`;
  const pals = chosen.palettes || [];
  $('#palField').hidden = pals.length < 2;
  $('#palOpts').innerHTML = pals.map((p, i) => `<label class="palopt"><input type="radio" name="palette" value="${esc(p.id)}" ${i === 0 ? 'checked' : ''} /><span class="sw">${Object.values(p.colors).slice(0, 5).map((c) => `<i style="background:${esc(c)}"></i>`).join('')}</span>${esc(p.name)}</label>`).join('');
  step('brief'); $('#stepBrief').elements.business.focus();
});
$('#back').onclick = () => step('theme');
$('#stepBrief').addEventListener('change', (e) => {
  if (e.target.name === 'writeMode') { const ta = $('#stepBrief').elements.presentation; ta.hidden = e.target.value !== 'own'; if (!ta.hidden) ta.focus(); }
});
$('#fromTheme').onclick = async () => {
  if (me.role !== 'admin' && sites.length >= (me.planInfo?.drafts || 3)) return toast(`Your ${esc(me.planInfo.name)} plan allows ${me.planInfo.drafts} sites in progress. Delete one to start another.`, true);
  modal.hidden = false; step('theme');
  const r = await fetch('/api/themes'); themes = await r.json(); renderThemes();
};
const close = () => { modal.hidden = true; };
$('#mClose').onclick = close;
modal.addEventListener('click', (e) => { if (e.target === modal && $('#stepWork').hidden) close(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden && $('#stepWork').hidden) close(); });

$('#stepBrief').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target).entries());
  const { palette, ...brief } = data;
  if (brief.writeMode === 'own' && !String(brief.presentation || '').trim()) { toast('Write your presentation, or let Wren write it', true); return; }
  step('work');
  try {
    const r = await fetch('/api/sites/from-theme', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: chosen.id, brief, palette }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Could not create the site');
    const t0 = Date.now();
    for (;;) {
      await new Promise((res) => setTimeout(res, 1500));
      const j = await (await fetch(`/api/jobs/${d.job}`)).json();
      if (j.status === 'done') break;
      if (j.status === 'error') { toast(esc(j.error), true); break; }
      $('#workNote').textContent = `Writing your texts and choosing photos… ${Math.round((Date.now() - t0) / 1000)}s`;
      if (Date.now() - t0 > 240000) break;
    }
    location.href = `/editor/${d.id}`;
  } catch (err) { toast(esc(err.message), true); step('brief'); }
});

// ---- thumbnails: scale the site preview to the card width ------------------------------------
function fitThumbs() {
  document.querySelectorAll('.thumb').forEach((t) => {
    const f = t.querySelector('iframe'); if (!f) return;
    const w = t.clientWidth, h = t.clientHeight; const scale = w / 1280;
    f.style.width = '1280px'; f.style.height = `${Math.ceil(h / scale)}px`; f.style.transform = `scale(${scale})`;
  });
}
new ResizeObserver(fitThumbs).observe(document.body);
new MutationObserver(fitThumbs).observe(document.body, { childList: true, subtree: true });
await loadMe().catch(() => {});
await load();
if (new URLSearchParams(location.search).get('new') === '1') { history.replaceState(null, '', '/'); if (!sites.length) $('#fromTheme').click(); }
