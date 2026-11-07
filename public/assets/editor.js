// ili studio editor shell: loads the site in a sandboxed frame and turns selections into saved edits.
const $ = (s) => document.querySelector(s);
const id = location.pathname.split('/').pop();
const frame = $('#frame');
const state = { meta: null, token: '', page: 'index.html', sel: null, mode: 'edit', scrollY: 0, reselect: null, busy: 0 };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(html, err = false) {
  const t = $('#toast'); t.innerHTML = html; t.classList.toggle('err', err); t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), err ? 6000 : 4000);
}
const tell = (msg) => frame.contentWindow?.postMessage({ ili: true, ...msg }, '*');

function setStatus() {
  const s = $('#status');
  if (state.busy) { s.textContent = 'Saving…'; s.className = 'status'; return; }
  const m = state.meta;
  if (!m.publishedAt) { s.textContent = 'Saved'; s.className = 'status dirty'; s.title = 'Your changes are saved. Publish to put the site online.'; }
  else if (m.dirty) { s.textContent = 'Saved'; s.className = 'status dirty'; s.title = 'Your changes are saved but visitors still see the published version. Click Publish changes to put them online.'; }
  else { s.textContent = 'Saved · live'; s.className = 'status ok'; s.title = 'Visitors see exactly what you see here.'; }
  const live = $('#live');
  live.hidden = !m.publishedAt; live.href = liveUrl(m.subdomain || m.slug);
  const pub = $('#publish');
  pub.textContent = m.publishedAt && m.dirty ? 'Publish changes' : 'Publish';
  pub.classList.toggle('changes', !!(m.publishedAt && m.dirty));
}

async function api(path, opts = {}) {
  const r = await fetch(`/api/sites/${id}${path}`, { signal: AbortSignal.timeout(opts.timeout || 60000), headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}, ...opts });
  let d = {}; try { d = await r.json(); } catch { /* */ }
  if (r.status === 502 || r.status === 504) { if (!d.error) throw new Error('The server took too long to answer. Try again.'); }
  if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
  if (!r.ok) { const err = new Error(d.error || 'Something went wrong'); err.code = d.code; err.data = d; throw err; }
  return d;
}

// ---- account & plan --------------------------------------------------------------------------
const me = { credits: null };
const testHost = /^(localhost|\d+\.\d+\.\d+\.\d+)/.test(location.hostname) || location.hostname.endsWith('nip.io');
const liveUrl = (sub) => (!testHost && me.freeDomain ? `https://${sub}.${me.freeDomain}/` : `/s/${sub}/`);
async function loadMe() {
  const [u, p] = await Promise.all([fetch('/api/me').then((r) => r.json()), fetch('/api/plans').then((r) => r.json())]);
  Object.assign(me, u, { freeDomain: p.freeDomain });
  showCredits();
}
function showCredits() {
  const el = $('#wrenCredits'); if (!el) return;
  if (me.role === 'admin' || me.credits == null) { el.textContent = ''; return; }
  el.innerHTML = `✦ ${me.credits} AI credit${me.credits === 1 ? '' : 's'} left${me.credits < 10 ? ' · <a href="#" id="moreCredits">Get more</a>' : ''}`;
  const more = document.getElementById('moreCredits'); if (more) more.onclick = (e) => { e.preventDefault(); creditsOut(false); };
}
async function creditsOut(empty = true) {
  const { offersModal } = await import('/_ili/offers.js');
  offersModal({
    title: empty ? 'You have used your AI credits' : 'Get more AI credits',
    intro: empty ? 'You can keep editing your site by hand: texts, photos, colours, sizes and pages all stay editable. Or choose a plan to get Wren back with fresh credits every month.'
      : 'Each plan comes with fresh AI credits every month, more pages and your own domain on Plus and Pro.',
    actions: empty ? '<button class="btn btn-dark" type="button" data-close="manual">Continue manually</button>' : '',
    current: me.plan,
  });
}
function loadFrame() { frame.src = `/frame/${id}/${state.token}/${state.page}`; }

async function init() {
  loadMe().catch(() => {});
  const d = await api('');
  state.meta = d; state.token = d.frameToken;
  document.title = `${d.name} · ili studio`;
  $('#siteName').value = d.name;
  $('#page').innerHTML = d.pages.map((p) => `<option value="${esc(p)}">${esc(p === 'index.html' ? 'Home (index.html)' : p)}</option>`).join('');
  $('#pageList').innerHTML = d.pages.map((p) => `<option value="${esc(p)}">`).join('');
  $('#undo').disabled = !d.undo;
  setStatus();
  loadFrame();
  waitPersonalising();
}

// ---- saving edits --------------------------------------------------------------------
async function ops(list, { reload = false, reselect = null } = {}) {
  state.busy++; setStatus();
  try {
    const d = await api('/ops', { method: 'POST', body: JSON.stringify({ page: state.page, ops: list }) });
    state.meta.dirty = true;
    $('#undo').disabled = !d.undo;
    if (reload) { state.reselect = typeof reselect === 'function' ? reselect(d) : reselect; loadFrame(); }
    return d;
  } catch (e) {
    toast(esc(e.message), true);
    if (!reload) { state.reselect = state.sel?.id; loadFrame(); } // resync the frame with what is saved
    throw e;
  } finally { state.busy--; setStatus(); }
}

async function undo() {
  if ($('#undo').disabled) return;
  state.busy++; setStatus();
  try {
    const d = await api('/undo', { method: 'POST', body: JSON.stringify({ page: state.page }) });
    $('#undo').disabled = !d.undo; state.meta.dirty = true;
    state.reselect = state.sel?.id; loadFrame();
  } catch (e) { toast(esc(e.message), true); }
  finally { state.busy--; setStatus(); }
}

// ---- inspector ----------------------------------------------------------------------------
function show(info) {
  if (pending.id && (!info || info.id !== pending.id)) flushStyle();
  state.sel = info;
  $('#empty').hidden = !!info; $('#sel').hidden = !info;
  if (!info) return;
  $('#selKind').textContent = info.name;
  $('#selTag').textContent = `<${info.tag}>`;
  $('#parentBtn').disabled = !info.parentId;
  $('#gText').hidden = !info.canText;
  $('#textPreview').textContent = info.text;
  $('#gImage').hidden = info.kind !== 'image';
  if (info.kind === 'image') { $('#imgPrev').src = info.preview || ''; $('#imgSrc').value = info.src || ''; $('#imgAlt').value = info.alt || ''; }
  $('#gLink').hidden = !info.link;
  if (info.link) { $('#href').value = info.link.href; $('#blank').checked = info.link.blank; }
  $('#moveUp').disabled = !info.hasPrev; $('#moveDown').disabled = !info.hasNext;
  const root = ['body', 'html', 'main'].includes(info.tag);
  $('#del').disabled = root; $('#dup').disabled = root;
  $('#qDel').disabled = root; $('#qDup').disabled = root; $('#qUp').disabled = !info.hasPrev; $('#qDown').disabled = !info.hasNext;
  $('#secBtn').hidden = !info.sectionId;
  $('#qDel').textContent = 'Delete'; $('#qDel').dataset.confirm = '';
  fillStyle(info.style);
  wrenUi(info);
  $('#noContent').hidden = !!(info.canText || info.kind === 'image' || info.link);
  $('#fitField').hidden = info.kind !== 'image';
}

// ---- inspector tabs ------------------------------------------------------------------------
document.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => {
  document.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  document.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.tab; });
});

// ---- style panel: live preview in the frame, saved after a short pause ---------------------
const pending = { id: null, props: {}, timer: 0 };
function flushStyle() {
  clearTimeout(pending.timer);
  if (!pending.id || !Object.keys(pending.props).length) return;
  const op = { type: 'style', id: pending.id, props: pending.props };
  pending.props = {};
  ops([op]).catch(() => {});
}
function live(props) {
  if (!state.sel) return;
  if (pending.id !== state.sel.id) { flushStyle(); pending.id = state.sel.id; }
  Object.assign(pending.props, props);
  tell({ cmd: 'style', id: state.sel.id, props });
  clearTimeout(pending.timer); pending.timer = setTimeout(flushStyle, 500);
}
function fillStyle(st) {
  if (!st) return;
  $('#sColor').value = st.color; $('#sColorHex').value = st.color;
  $('#sBg').value = st.bg; $('#sBgHex').value = st.bgOwn ? st.bg : '';
  $('#sBgHex').placeholder = st.bgOwn ? '' : 'none';
  $('#sSize').value = st.fontSize; $('#sSizeVal').textContent = st.fontSize + 'px';
  const w = [300, 400, 500, 600, 700, 800].reduce((a, b) => (Math.abs(b - st.fontWeight) < Math.abs(a - st.fontWeight) ? b : a));
  $('#sWeight').value = String(w);
  document.querySelectorAll('[data-align]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.align === (st.textAlign === 'start' ? 'left' : st.textAlign))));
  $('#sRadius').value = st.radius; $('#sRadiusVal').textContent = st.radius + 'px';
  $('#sPadY').value = st.padY; $('#sPadX').value = st.padX;
  $('#sWidth').value = st.widthPct ?? 100; $('#sWidthVal').textContent = st.widthSet ? `${st.widthPct}%` : `auto (${st.widthPct}%)`;
  $('#sHeight').value = st.height ?? ''; $('#sHeight').placeholder = st.heightNow ? `auto (${st.heightNow})` : 'auto';
  $('#sFit').value = st.fit || '';
  focalFill(st);
  $('#sMt').value = st.mt ?? 0; $('#sMb').value = st.mb ?? 0;
}
const isHex = (v) => /^#[0-9a-f]{6}$/i.test(v);
$('#sColor').oninput = (e) => { $('#sColorHex').value = e.target.value; live({ color: e.target.value }); };
$('#sColorHex').onchange = (e) => { const v = e.target.value.trim(); if (isHex(v)) { $('#sColor').value = v; live({ color: v }); } else toast('Use a colour like #1E3A6E', true); };
$('#sBg').oninput = (e) => { $('#sBgHex').value = e.target.value; live({ 'background-color': e.target.value }); };
$('#sBgHex').onchange = (e) => {
  const v = e.target.value.trim();
  if (!v) live({ 'background-color': null }); else if (isHex(v)) { $('#sBg').value = v; live({ 'background-color': v }); } else toast('Use a colour like #C8F031, or leave empty', true);
};
$('#sSize').oninput = (e) => { $('#sSizeVal').textContent = e.target.value + 'px'; live({ 'font-size': e.target.value + 'px' }); };
$('#sWeight').onchange = (e) => live({ 'font-weight': e.target.value });
document.querySelectorAll('[data-align]').forEach((b) => b.onclick = () => {
  document.querySelectorAll('[data-align]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  live({ 'text-align': b.dataset.align });
});
$('#sRadius').oninput = (e) => { $('#sRadiusVal').textContent = e.target.value + 'px'; live({ 'border-radius': e.target.value + 'px' }); };
const pad = () => live({ padding: `${Math.max(0, Number($('#sPadY').value) || 0)}px ${Math.max(0, Number($('#sPadX').value) || 0)}px` });
$('#sPadY').onchange = pad; $('#sPadX').onchange = pad;
$('#sWidth').oninput = (e) => { $('#sWidthVal').textContent = e.target.value + '%'; live({ width: e.target.value + '%', 'max-width': '100%' }); };
$('#sWidthAuto').onclick = () => { live({ width: null, 'max-width': null }); $('#sWidthVal').textContent = 'auto'; };
$('#sHeight').onchange = (e) => { const v = Number(e.target.value); live({ height: v > 0 ? v + 'px' : null }); };
$('#sFit').onchange = (e) => { live({ 'object-fit': e.target.value || null }); focal.fit = e.target.value || focal.fitNow; focalDraw(); };

// ---- visible part of an image (object-position) -------------------------------------------------
const focal = { x: 50, y: 50, natW: 0, natH: 0, boxW: 0, boxH: 0, fit: 'fill', fitNow: 'fill' };
function focalFill(st) {
  const isImg = state.sel?.kind === 'image';
  $('#posField').hidden = !isImg;
  if (!isImg) return;
  const [px, py] = String(st.pos || '50% 50%').split(/\s+/);
  const pct = (v) => (/%$/.test(v || '') ? parseFloat(v) : v === 'left' || v === 'top' ? 0 : v === 'right' || v === 'bottom' ? 100 : 50);
  Object.assign(focal, { x: pct(px), y: pct(py), natW: st.natW, natH: st.natH, boxW: st.boxW, boxH: st.boxH, fitNow: st.fitNow, fit: st.fit || st.fitNow });
  const img = $('#focalImg');
  img.onload = () => {
    if (!focal.natW) { focal.natW = img.naturalWidth || 1600; focal.natH = img.naturalHeight || 1000; }
    const ar = focal.natW / focal.natH || 1.6;
    const w = Math.min($('#posField').clientWidth || 280, 220 * ar);
    img.style.width = w + 'px'; img.style.height = Math.round(w / ar) + 'px';
    focalDraw();
  };
  img.src = state.sel.preview || '';
  focalDraw();
}
function focalDraw() {
  $('#focalDot').style.left = focal.x + '%'; $('#focalDot').style.top = focal.y + '%';
  const box = $('#focalBox');
  const imgAR = focal.natW / focal.natH, boxAR = focal.boxW / focal.boxH;
  let w = 100, h = 100;
  if (focal.fit === 'cover' && imgAR && boxAR) { if (imgAR > boxAR) w = (boxAR / imgAR) * 100; else h = (imgAR / boxAR) * 100; }
  box.style.width = w + '%'; box.style.height = h + '%';
  box.style.left = ((100 - w) * focal.x) / 100 + '%'; box.style.top = ((100 - h) * focal.y) / 100 + '%';
  const cropped = w < 99.5 || h < 99.5;
  box.hidden = !cropped;
  $('#focalNote').textContent = focal.fit !== 'cover' ? 'Choosing a part switches the image to “Fill and crop”.'
    : cropped ? 'The bright frame is what visitors see. Move it to choose the part to show.' : 'The whole photo is visible in this shape. Change the height to crop it.';
}
function focalSet(x, y) {
  focal.x = Math.round(Math.max(0, Math.min(100, x))); focal.y = Math.round(Math.max(0, Math.min(100, y)));
  const props = { 'object-position': `${focal.x}% ${focal.y}%` };
  if (focal.fit !== 'cover') { props['object-fit'] = 'cover'; focal.fit = 'cover'; $('#sFit').value = 'cover'; }
  live(props); focalDraw();
}
(() => {
  const area = $('#focal'); let dragging = false;
  const at = (e) => { const r = $('#focalImg').getBoundingClientRect(); focalSet(((e.clientX - r.left) / r.width) * 100, ((e.clientY - r.top) / r.height) * 100); };
  area.addEventListener('pointerdown', (e) => { dragging = true; area.setPointerCapture(e.pointerId); at(e); });
  area.addEventListener('pointermove', (e) => { if (dragging) at(e); });
  area.addEventListener('pointerup', () => { dragging = false; });
  document.querySelectorAll('[data-pos]').forEach((b) => b.onclick = () => { const [x, y] = b.dataset.pos.split(' ').map(parseFloat); focalSet(x, y); });
  $('#sHeight').addEventListener('change', (e) => { const v = Number(e.target.value); if (v > 0) { focal.boxH = v; focalDraw(); } });
})();
$('#sMt').onchange = (e) => live({ 'margin-top': Math.max(0, Number(e.target.value) || 0) + 'px' });
$('#sMb').onchange = (e) => live({ 'margin-bottom': Math.max(0, Number(e.target.value) || 0) + 'px' });

// ---- insert new elements after the selection --------------------------------------------------
const PLACEHOLDER_IMG = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500"><rect width="800" height="500" fill="#e6e9ef"/><path d="M300 330l90-110 70 80 45-45 95 75H300z" fill="#c3c9d5"/><circle cx="520" cy="190" r="34" fill="#c3c9d5"/></svg>');
const BLOCKS = {
  heading: '<h2>New heading</h2>',
  text: '<p>New text. Double-click to write, or ask Wren.</p>',
  button: '<a href="#" style="display: inline-block; padding: 12px 22px; border-radius: 8px; background-color: #1e3a6e; color: #ffffff; text-decoration: none; font-weight: 600">New button</a>',
  image: `<img src="${PLACEHOLDER_IMG}" alt="" style="width: 100%; max-width: 100%; height: auto; border-radius: 8px">`,
  spacer: '<div style="height: 48px" aria-hidden="true"></div>',
};
document.querySelectorAll('[data-ins]').forEach((b) => b.onclick = () => {
  if (!state.sel) return;
  ops([{ type: 'insert', id: state.sel.id, position: 'after', html: BLOCKS[b.dataset.ins] }], { reload: true, reselect: (d) => d.results?.[0]?.newId || null })
    .then(() => toast(b.dataset.ins === 'image' ? 'Image added · use “Find a free photo” to choose it' : 'Added')).catch(() => {});
});

// ---- pages ------------------------------------------------------------------------------------
const pageLabel = (p) => (p === 'index.html' ? 'Home' : p.replace(/\.html?$/, '').split('/').pop().replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase()));
async function openPages() {
  $('#pgModal').hidden = false;
  renderPages();
  const tpls = await api('/templates').catch(() => []);
  $('#pgFrom').innerHTML = `<option value="blank">Blank page (keeps menu and footer)</option><option value="duplicate">Copy of “${esc(pageLabel(state.page))}”</option>` +
    tpls.map((t) => `<option value="template:${esc(t.id)}">Theme page: ${esc(t.name)}</option>`).join('');
}
function renderPages() {
  $('#pgList').innerHTML = state.meta.pages.map((p) => `
    <li data-p="${esc(p)}"><span class="pn"><b>${esc(pageLabel(p))}</b><span>${esc(p)}</span></span>
      <button class="btn btn-sm" data-act="open" type="button">Open</button>
      ${p === 'index.html' ? '' : '<button class="btn btn-sm" data-act="rename" type="button">Rename</button><button class="btn btn-sm btn-danger" data-act="delete" type="button">Delete</button>'}
    </li>`).join('');
}
function refreshPageSelect() {
  $('#page').innerHTML = state.meta.pages.map((p) => `<option value="${esc(p)}">${esc(p === 'index.html' ? 'Home (index.html)' : p)}</option>`).join('');
  $('#page').value = state.page;
  $('#pageList').innerHTML = state.meta.pages.map((p) => `<option value="${esc(p)}">`).join('');
}
$('#pagesBtn').onclick = openPages;
$('#pgClose').onclick = () => { $('#pgModal').hidden = true; };
$('#pgModal').addEventListener('click', (e) => { if (e.target === $('#pgModal')) $('#pgModal').hidden = true; });
$('#pgList').onclick = async (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const li = b.closest('li'); const p = li.dataset.p;
  if (b.dataset.act === 'open') { $('#pgModal').hidden = true; state.page = p; state.scrollY = 0; show(null); refreshPageSelect(); loadFrame(); return; }
  if (b.dataset.act === 'rename') {
    const name = li.querySelector('.pn b').textContent;
    li.innerHTML = `<input class="input" value="${esc(name)}" maxlength="60" /><button class="btn btn-sm btn-primary" data-act="save" type="button">Save</button>`;
    li.querySelector('input').focus(); return;
  }
  if (b.dataset.act === 'save') {
    const title = li.querySelector('input').value.trim(); if (!title) return;
    try { await api('/pages', { method: 'PATCH', body: JSON.stringify({ page: p, title }) }); toast('Page renamed'); state.meta.dirty = true; setStatus(); if (p === state.page || true) loadFrame(); } catch (err) { toast(esc(err.message), true); }
    renderPages(); return;
  }
  if (b.dataset.act === 'delete') {
    if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Confirm'; setTimeout(() => { b.dataset.confirm = ''; b.textContent = 'Delete'; }, 3000); return; }
    try {
      const d = await api(`/pages?page=${encodeURIComponent(p)}`, { method: 'DELETE' });
      state.meta.pages = d.pages; state.meta.dirty = true; setStatus();
      if (state.page === p) { state.page = 'index.html'; show(null); }
      refreshPageSelect(); renderPages(); loadFrame(); toast('Page deleted');
    } catch (err) { toast(esc(err.message), true); }
  }
};
$('#pgForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target; const from = f.elements.from.value;
  const body = { title: f.elements.title.value.trim(), menu: f.elements.menu.checked, source: state.page,
    from: from.startsWith('template:') ? 'template' : from, template: from.startsWith('template:') ? from.slice(9) : undefined };
  const btn = f.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = from.startsWith('template:') ? 'Wren is writing the page…' : 'Adding…';
  try {
    const d = await api('/pages', { method: 'POST', body: JSON.stringify(body), timeout: 180000 });
    state.meta.pages = d.pages; state.meta.dirty = true; setStatus();
    state.page = d.page; state.scrollY = 0; show(null); refreshPageSelect(); loadFrame();
    $('#pgModal').hidden = true; f.reset(); toast('Page added');
  } catch (err) { toast(esc(err.message), true); }
  finally { btn.disabled = false; btn.textContent = 'Add page →'; }
};

$('#resetStyle').onclick = () => {
  if (!state.sel) return;
  const props = { color: null, 'background-color': null, 'font-size': null, 'font-weight': null, 'text-align': null, 'border-radius': null, padding: null,
    width: null, 'max-width': null, height: null, 'object-fit': null, 'object-position': null, 'margin-top': null, 'margin-bottom': null };
  live(props); flushStyle();
  tell({ cmd: 'style', id: state.sel.id, props: {}, notify: true });
}

async function setAttr(elId, name, value) {
  await ops([{ type: 'attr', id: elId, name, value }]);
  tell({ cmd: 'setAttr', id: elId, name, value });
}

$('#editText').onclick = () => tell({ cmd: 'edit' });
$('#boldBtn').onmousedown = (e) => { e.preventDefault(); tell({ cmd: 'bold' }); };
$('#italicBtn').onmousedown = (e) => { e.preventDefault(); tell({ cmd: 'italic' }); };
$('#parentBtn').onclick = () => tell({ cmd: 'parent' });
$('#imgSrc').onchange = (e) => setAttr(state.sel.id, 'src', e.target.value.trim());
$('#imgAlt').onchange = (e) => setAttr(state.sel.id, 'alt', e.target.value.trim());
$('#href').onchange = (e) => setAttr(state.sel.link.id, 'href', e.target.value.trim());
$('#blank').onchange = (e) => setAttr(state.sel.link.id, 'target', e.target.checked ? '_blank' : '');
$('#replaceImg').onclick = () => $('#imgFile').click();
// a site still being personalised: wait, then reload
async function waitPersonalising() {
  while (state.meta?.personalising) {
    $('#status').textContent = 'Wren is personalising…';
    await new Promise((r) => setTimeout(r, 2000));
    const d = await api(''); state.meta = { ...state.meta, ...d };
    if (!d.personalising) { loadFrame(); setStatus(); }
  }
}
$('#imgFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const fd = new FormData(); fd.append('page', state.page); fd.append('image', f);
  try {
    state.busy++; setStatus();
    const d = await api('/images', { method: 'POST', body: fd });
    state.busy--; await setAttr(state.sel.id, 'src', d.src);
    toast('Image replaced');
  } catch (err) { state.busy = Math.max(0, state.busy - 1); setStatus(); toast(esc(err.message), true); }
};
$('#moveUp').onclick = () => ops([{ type: 'move', id: state.sel.id, dir: 'up' }], { reload: true, reselect: state.sel.id });
$('#moveDown').onclick = () => ops([{ type: 'move', id: state.sel.id, dir: 'down' }], { reload: true, reselect: state.sel.id });
$('#dup').onclick = () => ops([{ type: 'duplicate', id: state.sel.id }], { reload: true, reselect: (d) => d.results?.[0]?.newId || null }).catch(() => {});
async function removeSel() {
  if (!state.sel) return;
  const what = state.sel.name || 'Element';
  await ops([{ type: 'remove', id: state.sel.id }], { reload: true });
  show(null);
  toast(`${esc(what)} deleted · <a href="#" id="tUndoDel">Undo</a>`);
  setTimeout(() => { const u = document.getElementById('tUndoDel'); if (u) u.onclick = (ev) => { ev.preventDefault(); undo(); }; }, 0);
}
const confirmDel = (e) => {
  const b = e.currentTarget;
  if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Click to confirm'; setTimeout(() => { b.dataset.confirm = ''; b.textContent = 'Delete'; }, 2500); return; }
  b.dataset.confirm = ''; b.textContent = 'Delete';
  removeSel();
};
$('#del').onclick = confirmDel; $('#qDel').onclick = confirmDel;
$('#qUp').onclick = () => $('#moveUp').click(); $('#qDown').onclick = () => $('#moveDown').click(); $('#qDup').onclick = () => $('#dup').click();
$('#secBtn').onclick = () => { if (state.sel?.sectionId) tell({ cmd: 'select', id: state.sel.sectionId, scroll: false }); };
let delArmed = 0;
function delKey(key) {
  if (!state.sel || $('#qDel').disabled) return;
  if (Date.now() - delArmed > 2500) { delArmed = Date.now(); toast(`Press ${esc(key)} again to delete this ${esc((state.sel.name || 'element').toLowerCase())}`); return; }
  delArmed = 0; removeSel();
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.activeElement === frame) return;
  e.preventDefault(); delKey(e.key);
});

// ---- top bar ------------------------------------------------------------------------------
$('#undo').onclick = undo;
$('#page').onchange = (e) => { state.page = e.target.value; state.scrollY = 0; show(null); loadFrame(); api(`?page=${encodeURIComponent(state.page)}`).then((d) => { $('#undo').disabled = !d.undo; }); };
document.querySelectorAll('[data-dev]').forEach((b) => b.onclick = () => {
  document.querySelectorAll('[data-dev]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  $('#device').dataset.dev = b.dataset.dev;
});
document.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => setMode(b.dataset.mode));
$('#siteName').onchange = async (e) => {
  const name = e.target.value.trim(); if (!name) { e.target.value = state.meta.name; return; }
  try { const d = await api('', { method: 'PATCH', body: JSON.stringify({ name }) }); state.meta.name = d.name; document.title = `${d.name} · ili studio`; } catch (err) { toast(esc(err.message), true); }
};
$('#publish').onclick = () => openPublish();
async function openPublish() {
  flushStyle?.();
  let a, seo = null;
  try { [a, seo] = await Promise.all([api('/address'), api('/seo-score').catch(() => null)]); } catch (e) { return toast(esc(e.message), true); }
  const plan = a.plan; // null for the admin
  const { renderOffers, choosePlan } = await import('/_ili/offers.js');
  const wrap = document.createElement('div');
  wrap.className = 'omodal';
  wrap.innerHTML = `<div class="osheet pub" role="dialog" aria-modal="true" aria-label="Publish your site">
    <div class="ohead"><h2>Publish your site</h2><button class="btn btn-sm" type="button" data-close aria-label="Close">✕</button></div>
    <section class="pbox">
      <span class="label">${plan && !plan.customDomain ? 'Your free address' : 'Your address'}</span>
      <div class="addr"><span>https://</span><input class="input" id="pubSub" value="${esc(a.sub)}" maxlength="40" autocomplete="off" spellcheck="false" aria-label="Address"><span>.${esc(a.freeDomain)}</span></div>
      <p class="amsg" id="pubMsg" aria-live="polite"></p>
      ${a.locked.length ? `<p class="lock">Your ${esc(plan?.name || '')} plan publishes ${a.live.length === 1 ? 'one page' : a.live.length + ' pages'}: <b>${a.live.map(pageLabel).map(esc).join(', ')}</b>. Your page${a.locked.length > 1 ? 's' : ''} <b>${a.locked.map(pageLabel).map(esc).join(', ')}</b> ${a.locked.length > 1 ? 'are' : 'is'} ready and will go live as soon as you choose a plan.</p>` : ''}
      ${seo ? `<div class="seobox ${seo.score >= 80 ? 'good' : seo.score >= 50 ? 'mid' : 'bad'}"><b class="sscore">${seo.score}<small>/100</small></b>
        <div><b>SEO score</b><p>${seo.counts.error + seo.counts.warning ? `${seo.counts.error + seo.counts.warning} thing${seo.counts.error + seo.counts.warning > 1 ? 's' : ''} to improve before Google sees your site${seo.top.length ? ': ' + seo.top.slice(0, 2).map(esc).join(', ').toLowerCase() : ''}.` : 'Your site is ready for Google.'}</p></div>
        ${seo.counts.error + seo.counts.warning ? `<a class="btn btn-sm" href="/seo?site=${id}&tab=improve">Finalise my SEO first →</a>` : ''}</div>` : ''}
      <div class="row"><button class="btn btn-primary" id="pubGo" type="button">${plan?.id === 'free' ? 'Publish now for free →' : 'Publish now →'}</button></div>
      <div class="done" id="pubDone" hidden></div>
    </section>
    ${plan && !plan.customDomain ? `<section class="pup">
      <h3>Want your own domain, like yourbusiness.co.uk?</h3>
      <p class="muted">Every paid plan puts your site on your own domain, without the ili studio link, with more pages and more AI credits. Free stays free if you prefer.</p>
      <div class="ogrid"></div><p class="onote" hidden></p>
    </section>` : ''}
  </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
  const input = wrap.querySelector('#pubSub'), msg = wrap.querySelector('#pubMsg'), go = wrap.querySelector('#pubGo');
  let ok = a.ok, t;
  const showCheck = (d) => { ok = d.ok; msg.className = 'amsg ' + (d.ok ? 'ok' : 'bad'); msg.textContent = d.ok ? (d.current === d.sub ? 'This is your current address.' : 'This address is available.') : d.error; go.disabled = !d.ok; };
  showCheck(a);
  input.oninput = () => {
    clearTimeout(t); msg.className = 'amsg'; msg.textContent = 'Checking…'; go.disabled = true;
    t = setTimeout(async () => { try { const d = await api(`/address?sub=${encodeURIComponent(input.value)}`); if (input.value !== d.sub) input.value = d.sub; showCheck(d); } catch (e) { msg.textContent = e.message; } }, 350);
  };
  go.onclick = async () => {
    if (!ok) return;
    go.disabled = true; go.textContent = 'Publishing…';
    try {
      const d = await api('/publish', { method: 'POST', body: JSON.stringify({ sub: input.value }) });
      state.meta.publishedAt = d.publishedAt; state.meta.dirty = false; state.meta.subdomain = input.value; setStatus();
      const shown = d.url.replace(/^https:\/\//, '').replace(/\/$/, '');
      const done = wrap.querySelector('#pubDone'); done.hidden = false;
      done.innerHTML = `<b>Your site is live!</b> <a href="${esc(liveUrl(input.value))}" target="_blank" rel="noopener">${esc(shown)} ↗</a>`;
      go.textContent = 'Publish again';
    } catch (e) {
      msg.className = 'amsg bad'; msg.textContent = e.message;
      if (e.code === 'publish_limit') wrap.querySelector('.pup')?.scrollIntoView({ behavior: 'smooth' });
      go.textContent = plan?.id === 'free' ? 'Publish now for free →' : 'Publish now →';
    }
    go.disabled = !ok;
  };
  const og = wrap.querySelector('.pup .ogrid');
  if (og) renderOffers(og, {
    current: plan.id, only: 'paid',
    onPick: async (p) => {
      await choosePlan(p).catch(() => {});
      const n = wrap.querySelector('.pup .onote'); n.hidden = false;
      n.textContent = 'Thank you! Card payment and domain registration open very soon: we have saved your choice and will email you. Meanwhile your free address works straight away.';
    },
  });
  input.focus(); input.select();
}
document.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (!typing && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
});

// ---- messages from the frame ---------------------------------------------------------------
window.addEventListener('message', (e) => {
  if (e.source !== frame.contentWindow || !e.data?.ili) return;
  const m = e.data;
  switch (m.type) {
    case 'ready':
      if (m.page && m.page !== state.page && state.meta.pages.includes(m.page)) { state.page = m.page; $('#page').value = m.page; }
      tell({ cmd: 'mode', mode: state.mode });
      if (state.scrollY) tell({ cmd: 'scrollTo', y: state.scrollY });
      if (state.reselect) { tell({ cmd: 'select', id: state.reselect, scroll: false }); state.reselect = null; } else show(null);
      break;
    case 'scroll': state.scrollY = m.y; break;
    case 'select': show(m.info); break;
    case 'deselect': show(null); break;
    case 'text': ops([{ type: 'html', id: m.id, html: m.html }]).then(() => toast('Text saved')).catch(() => {}); break;
    case 'undo': undo(); break;
    case 'delkey': delKey(m.key); break;
  }
});

// ---- Wren ---------------------------------------------------------------------------
const ai = { enabled: false };
const CHIPS_TEXT = ['Make it shorter', 'Make it friendlier', 'More professional', 'Fix spelling and grammar', 'Make it stand out more'];
const CHIPS_BLOCK = ['Make this section more modern', 'Add a clear call to action', 'Reorganise as 3 columns', 'Rewrite the text to be clearer'];
function wrenUi(info) {
  const g = $('#gWren');
  g.classList.toggle('off', !ai.enabled);
  $('#wrenInput').disabled = !ai.enabled; $('#wrenGo').disabled = !ai.enabled;
  $('#wrenTag').textContent = ai.enabled ? ({ gemini: 'Gemini', anthropic: 'Claude', azure: 'Azure' }[ai.provider] || 'Test') : 'Not set up';
  $('#wrenNote').textContent = ai.enabled ? 'Wren edits only the selected element. You can undo any change.' : 'Add an AI key (Azure, Gemini or Claude) in CapRover to switch Wren on.';
  const chips = info?.canText ? CHIPS_TEXT : CHIPS_BLOCK;
  $('#wrenChips').innerHTML = ai.enabled ? chips.map((c) => `<button type="button">${esc(c)}</button>`).join('') : '';
}
$('#wrenChips').onclick = (e) => { const b = e.target.closest('button'); if (b) { $('#wrenInput').value = b.textContent; askWren(); } };
$('#wrenGo').onclick = () => askWren();
$('#wrenInput').onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) askWren(); };
async function askWren() {
  const instruction = $('#wrenInput').value.trim();
  if (!state.sel || !instruction) return toast('Select an element and tell Wren what to do', true);
  flushStyle();
  const go = $('#wrenGo'); go.classList.add('busy'); go.textContent = 'Wren is working ';
  $('#canvas').classList.add('thinking');
  const sel = state.sel;
  try {
    const start = await api('/wren', { method: 'POST', body: JSON.stringify({ page: state.page, id: sel.id, instruction, current: sel.style || {}, style: sel.style ? `text ${sel.style.color}, background ${sel.style.bgOwn ? sel.style.bg : 'none (inherits ' + sel.style.bg + ')'}, ${sel.style.fontSize}px, weight ${sel.style.fontWeight}, corners ${sel.style.radius}px, padding ${sel.style.padY}px ${sel.style.padX}px` : '', mode: sel.canText && !['section', 'div', 'header', 'footer', 'article'].includes(sel.tag) ? 'text' : 'block' }) });
    let d; const t0 = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      d = await api(`/wren/${start.job}`);
      if (d.status === 'done') break;
      if (d.status === 'error') throw new Error(d.error);
      if (Date.now() - t0 > 200000) throw new Error('Wren took too long. Try again or select a smaller part.');
      go.textContent = `Wren is working (${Math.round((Date.now() - t0) / 1000)}s) `;
    }
    $('#undo').disabled = !d.undo; state.meta.dirty = true; setStatus();
    if (d.credits != null) { me.credits = d.credits; showCredits(); }
    state.reselect = sel.id; loadFrame();
    $('#wrenInput').value = '';
    toast(`${esc(d.note || 'Wren updated this part')} · <a href="#" id="tUndo">Undo</a>`);
    setTimeout(() => { const u = document.getElementById('tUndo'); if (u) u.onclick = (ev) => { ev.preventDefault(); undo(); }; }, 0);
  } catch (e) {
    if (e.code === 'no_credits') { me.credits = 0; showCredits(); creditsOut(true); }
    else toast(esc(e.name === 'TimeoutError' ? 'Wren took too long. Try again or select a smaller part.' : e.message), true);
  }
  finally { go.classList.remove('busy'); go.textContent = 'Ask Wren →'; $('#canvas').classList.remove('thinking'); }
}
fetch('/api/ai').then((r) => r.json()).then((d) => { Object.assign(ai, d); wrenUi(state.sel); }).catch(() => {});

// ---- free photo library -----------------------------------------------------------------------
const pm = { el: $('#pmodal'), target: null };
function openPhotos() {
  if (!state.sel || state.sel.kind !== 'image') return;
  pm.target = state.sel.id;
  pm.el.hidden = false;
  const q = state.sel.alt || state.meta.brief?.trade || '';
  $('#pQuery').value = q; $('#pChips').innerHTML = '';
  if (q) searchPhotos(q); else $('#pGrid').innerHTML = '<p class="muted">Search the free photo library, or let Wren suggest.</p>';
  $('#pQuery').focus();
}
async function searchPhotos(q) {
  $('#pGrid').innerHTML = '<p class="muted">Searching…</p>';
  try {
    const r = await fetch(`/api/images/search?q=${encodeURIComponent(q)}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Search failed');
    if (!d.results.length) { $('#pGrid').innerHTML = '<p class="muted">No photos found. Try other words, in English.</p>'; return; }
    pm.results = d.results;
    $('#pGrid').innerHTML = d.results.map((p, i) => `<button type="button" data-i="${i}" title="${esc(p.tags)}${p.author ? ' · ' + esc(p.author) : ''}"><img src="${esc(p.preview || p.thumb)}" alt="${esc(p.tags)}" loading="lazy"></button>`).join('');
  } catch (e) { $('#pGrid').innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}
$('#findPhoto').onclick = openPhotos;
$('#pClose').onclick = () => { pm.el.hidden = true; };
pm.el.addEventListener('click', (e) => { if (e.target === pm.el) pm.el.hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pm.el.hidden) pm.el.hidden = true; });
$('#pForm').onsubmit = (e) => { e.preventDefault(); const q = $('#pQuery').value.trim(); if (q) searchPhotos(q); };
$('#pChips').onclick = (e) => { const b = e.target.closest('button'); if (b) { $('#pQuery').value = b.textContent; searchPhotos(b.textContent); } };
$('#pSuggest').onclick = async () => {
  const b = $('#pSuggest'); b.disabled = true; b.textContent = '✦ Thinking…';
  try {
    const d = await api('/images/suggest', { method: 'POST', body: JSON.stringify({ page: state.page, id: pm.target }) });
    $('#pChips').innerHTML = d.queries.map((q) => `<button type="button">${esc(q)}</button>`).join('');
    if (d.queries[0]) { $('#pQuery').value = d.queries[0]; searchPhotos(d.queries[0]); }
  } catch (e) { toast(esc(e.message), true); }
  finally { b.disabled = false; b.textContent = '✦ Suggest'; }
};
$('#pGrid').onclick = async (e) => {
  const b = e.target.closest('button[data-i]'); if (!b || b.classList.contains('busy')) return;
  const photo = pm.results[Number(b.dataset.i)];
  b.classList.add('busy');
  try {
    const d = await api('/images/library', { method: 'POST', body: JSON.stringify({ page: state.page, photo }) });
    pm.el.hidden = true;
    await setAttr(pm.target, 'src', d.src);
    if (d.alt && !state.sel?.alt) await setAttr(pm.target, 'alt', d.alt);
    toast('Photo added');
  } catch (err) { toast(esc(err.message), true); }
  finally { b.classList.remove('busy'); }
};

// ---- full-screen preview ----------------------------------------------------------------------
function setMode(mode) {
  document.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.mode === mode)));
  state.mode = mode; tell({ cmd: 'mode', mode }); if (mode !== 'edit') show(null);
}
function enterFs() {
  state.fsPrevMode = state.mode; setMode('preview');
  document.body.classList.add('fs'); $('#fsExit').hidden = false;
  document.documentElement.requestFullscreen?.().catch(() => {});
}
function exitFs() {
  document.body.classList.remove('fs'); $('#fsExit').hidden = true;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  setMode(state.fsPrevMode || 'edit');
}
$('#fsBtn').onclick = enterFs;
$('#fsExit').onclick = exitFs;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('fs')) exitFs(); });
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && document.body.classList.contains('fs')) exitFs(); });

// ---- palettes and colour swatches ---------------------------------------------------------------
const pal = { list: [], current: null, swatches: [] };
async function loadPalettes() {
  try { Object.assign(pal, await api('/palettes')); } catch { return; }
  $('#colBtn').hidden = pal.palettes.length < 2;
  $('#swatches').hidden = !pal.swatches.length;
  $('#swList').innerHTML = pal.swatches.map((c) => `<button type="button" style="background:${esc(c)}" title="${esc(c)}" data-c="${esc(c)}"></button>`).join('');
}
$('#swList').onclick = (e) => {
  const b = e.target.closest('button[data-c]'); if (!b || !state.sel) return;
  const c = b.dataset.c;
  if (e.shiftKey) { $('#sBgHex').value = c; live({ 'background-color': c }); } else { $('#sColorHex').value = c; live({ color: c }); }
};
$('#colBtn').onclick = () => {
  $('#colModal').hidden = false;
  $('#colOpts').innerHTML = pal.palettes.map((p) => `<button type="button" class="palopt" data-p="${esc(p.id)}" aria-pressed="${p.id === pal.current}"><span class="sw">${Object.values(p.colors).slice(0, 5).map((c) => `<i style="background:${esc(c)}"></i>`).join('')}</span>${esc(p.name)}</button>`).join('');
};
$('#colClose').onclick = () => { $('#colModal').hidden = true; };
$('#colModal').addEventListener('click', (e) => { if (e.target === $('#colModal')) $('#colModal').hidden = true; });
$('#colOpts').onclick = async (e) => {
  const b = e.target.closest('[data-p]'); if (!b) return;
  try {
    await api('/palette', { method: 'POST', body: JSON.stringify({ palette: b.dataset.p }) });
    state.meta.dirty = true; setStatus(); await loadPalettes(); $('#colModal').hidden = true;
    state.reselect = state.sel?.id; loadFrame(); toast('Colours updated');
  } catch (err) { toast(esc(err.message), true); }
};
loadPalettes();

init().catch((e) => toast(esc(e.message), true));


// ---- customer reviews -------------------------------------------------------------------------
const WIDGET_HELP = {
  trustpilot: 'In Trustpilot Business, open Integrations → TrustBox widgets, choose a widget and copy its code.',
  google: 'Google has no official widget. Add your best Google reviews yourself (recommended), or paste a widget from a service such as Elfsight or Trustindex.',
  facebook: 'Facebook has no simple review widget. Add your reviews yourself, or use a service such as Elfsight or Trustindex.',
  checkatrade: 'In your Checkatrade account, look for “Website widgets” and copy the code.',
  trustatrader: 'In your TrustATrader account, look for the website widget and copy the code.',
  feefo: 'In Feefo Hub, open the widget settings and copy the embed code.',
  reviewsio: 'In your Reviews.io dashboard, open Integrations → Widgets and copy the code.',
};
async function loadReviewsBtn() {
  try { const d = await api('/reviews'); $('#revBtn').hidden = !d.pages.length; return d; } catch { return null; }
}
$('#revBtn').onclick = async () => {
  const d = await api('/reviews');
  const rv = d.reviews || { platform: 'google', mode: 'manual', items: [], profileUrl: '', reviewUrl: '', overall: null, count: null, widget: '', genuine: false };
  const st = JSON.parse(JSON.stringify(rv));
  const wrap = document.createElement('div'); wrap.className = 'omodal';
  const opts = (sel) => Object.entries(d.platforms).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(v)}</option>`).join('');
  wrap.innerHTML = `<div class="osheet revs" role="dialog" aria-modal="true" aria-label="Customer reviews">
    <div class="ohead"><h2>Customer reviews</h2><button class="btn btn-sm" type="button" data-close aria-label="Close">✕</button></div>
    <p class="ointro">Show your real reviews in your site's own design. Choose where they come from, then add them yourself or paste the platform's widget.</p>
    <div class="rgrid">
      <label class="field"><span>Review platform</span><select class="input" id="rvPlat">${opts(st.platform)}</select></label>
      <label class="field"><span>Your page on this platform</span><input class="input" id="rvProfile" placeholder="https://…" value="${esc(st.profileUrl)}"></label>
      <label class="field"><span>Link to leave a review <small class="muted">(optional)</small></span><input class="input" id="rvLeave" placeholder="https://g.page/r/…" value="${esc(st.reviewUrl)}"></label>
    </div>
    <div class="seg rmode" role="group" aria-label="How to add reviews"><button type="button" data-m="manual">Add my reviews</button><button type="button" data-m="widget">Use the platform's widget</button></div>
    <section id="rvManual">
      <div class="rgrid">
        <label class="field"><span>Overall rating <small class="muted">(optional)</small></span><input class="input" id="rvOverall" type="number" min="1" max="5" step="0.1" placeholder="4.9" value="${st.overall ?? ''}"></label>
        <label class="field"><span>Number of reviews <small class="muted">(optional)</small></span><input class="input" id="rvCount" type="number" min="0" placeholder="120" value="${st.count ?? ''}"></label>
      </div>
      <div id="rvList" class="rlist"></div>
      <button class="btn btn-sm" type="button" id="rvAdd">+ Add a review</button>
      <label class="check rgen"><input type="checkbox" id="rvGenuine" ${st.genuine ? 'checked' : ''}> These are genuine reviews from real customers, copied without changes. <span class="muted">(Fake reviews are illegal in the UK.)</span></label>
    </section>
    <section id="rvWidget" hidden>
      <p class="muted small" id="rvHelp"></p>
      <textarea class="input mono" id="rvCode" rows="6" placeholder="Paste the widget code here">${esc(st.widget)}</textarea>
      <p class="muted small">Widgets keep the platform's own design. Only code from known review platforms is accepted.</p>
    </section>
    <div class="row"><button class="btn btn-primary" type="button" id="rvSave">Save reviews</button><span class="muted small" id="rvMsg"></span></div>
  </div>`;
  document.body.appendChild(wrap);
  const q = (s) => wrap.querySelector(s);
  const close = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
  const today = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const renderList = () => {
    q('#rvList').innerHTML = st.items.length ? st.items.map((r, i) => `<div class="ritem" data-i="${i}">
      <div class="rrow"><input class="input" data-k="author" placeholder="Customer name" value="${esc(r.author)}" maxlength="80">
        <select class="input" data-k="rating">${[5, 4, 3, 2, 1].map((n) => `<option value="${n}" ${Number(r.rating) === n ? 'selected' : ''}>${'★'.repeat(n)}</option>`).join('')}</select>
        <input class="input" data-k="date" placeholder="${esc(today)}" value="${esc(r.date)}" maxlength="30">
        <button class="btn btn-sm btn-danger" type="button" data-del aria-label="Remove this review">✕</button></div>
      <textarea class="input" data-k="text" rows="3" placeholder="The review, word for word" maxlength="1200">${esc(r.text)}</textarea>
      <input class="input" data-k="link" placeholder="Link to this review (optional, lets visitors check it)" value="${esc(r.link)}">
    </div>`).join('') : '<p class="muted small">No reviews yet. Add your favourite ones: 3 to 6 short reviews work best.</p>';
  };
  const setMode = (m) => {
    st.mode = m;
    wrap.querySelectorAll('[data-m]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === m)));
    q('#rvManual').hidden = m !== 'manual'; q('#rvWidget').hidden = m !== 'widget';
  };
  const help = () => { q('#rvHelp').textContent = WIDGET_HELP[q('#rvPlat').value] || 'Copy the website widget code from your account on this platform and paste it below.'; };
  renderList(); setMode(st.mode); help();
  q('#rvPlat').onchange = help;
  wrap.querySelectorAll('[data-m]').forEach((b) => b.onclick = () => setMode(b.dataset.m));
  q('#rvList').addEventListener('input', (e) => { const it = e.target.closest('.ritem'); if (it && e.target.dataset.k) st.items[it.dataset.i][e.target.dataset.k] = e.target.value; });
  q('#rvList').addEventListener('click', (e) => { const b = e.target.closest('[data-del]'); if (b) { st.items.splice(Number(b.closest('.ritem').dataset.i), 1); renderList(); } });
  q('#rvAdd').onclick = () => {
    if (st.items.length >= 30) return;
    st.items.push({ author: '', rating: 5, date: '', text: '', link: '', source: q('#rvPlat').value }); renderList();
    q('#rvList .ritem:last-child [data-k="author"]').focus();
  };
  q('#rvSave').onclick = async () => {
    const btn = q('#rvSave'); btn.disabled = true; q('#rvMsg').textContent = 'Saving…';
    const body = {
      platform: q('#rvPlat').value, profileUrl: q('#rvProfile').value, reviewUrl: q('#rvLeave').value, mode: st.mode,
      overall: q('#rvOverall').value, count: q('#rvCount').value, genuine: q('#rvGenuine').checked, widget: q('#rvCode').value,
      items: st.items.filter((r) => String(r.text).trim() || String(r.author).trim()).map((r) => ({ ...r, source: q('#rvPlat').value })),
    };
    const half = body.items.find((r) => !String(r.text).trim() || !String(r.author).trim());
    if (body.mode === 'manual' && half) { q('#rvMsg').textContent = 'Each review needs a name and a text.'; btn.disabled = false; return; }
    try {
      const r = await api('/reviews', { method: 'POST', body: JSON.stringify(body) });
      state.meta.dirty = true; setStatus(); loadFrame(); close();
      toast(r.reviews.mode === 'widget' ? 'Review widget added' : `${r.reviews.items.length} review${r.reviews.items.length === 1 ? '' : 's'} saved · <a href="#" id="tUndoRv">Undo</a>`);
      setTimeout(() => { const u = document.getElementById('tUndoRv'); if (u) u.onclick = (ev) => { ev.preventDefault(); undo(); }; }, 0);
      api(`?page=${encodeURIComponent(state.page)}`).then((x) => { $('#undo').disabled = !x.undo; });
    } catch (e) { q('#rvMsg').textContent = e.message; btn.disabled = false; }
  };
};
loadReviewsBtn();

// ---- versions ---------------------------------------------------------------------------------
const KIND = { publish: 'Published', manual: 'Saved', auto: 'Auto' };
const when = (iso) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
async function openVersions() {
  $('#verModal').hidden = false;
  $('#dlNow').href = `/api/sites/${id}/download`;
  await renderVersions();
}
async function renderVersions() {
  let d;
  try { d = await api('/versions'); } catch (e) { return toast(esc(e.message), true); }
  $('#verList').innerHTML = d.versions.length ? d.versions.map((v) => `
    <li data-v="${v.id}"><span class="pn"><b>${esc(v.label || when(v.at))}</b><span><span class="kind ${v.kind}">${KIND[v.kind] || v.kind}</span>${v.label ? esc(when(v.at)) + ' · ' : ''}${v.pages.length} page${v.pages.length > 1 ? 's' : ''}</span></span>
      <button class="btn btn-sm" data-act="restore" type="button">Go back to this</button>
      <a class="btn btn-sm btn-icon" href="/api/sites/${id}/versions/${v.id}/download" download title="Download this version (ZIP)" aria-label="Download this version">↓</a>
      <button class="btn btn-sm btn-icon btn-danger" data-act="del" type="button" title="Delete this version" aria-label="Delete this version">✕</button>
    </li>`).join('') : '<li><span class="empty">No versions yet. One is made every time you publish, or save one now.</span></li>';
  $('#verKeep').innerHTML = d.plan ? `Your ${esc(d.plan)} plan keeps your last ${d.keep} version${d.keep > 1 ? 's' : ''}.${d.keep < 15 ? ' <a href="#" id="verMore">Keep more</a>' : ''}` : `Keeps the last ${d.keep} versions.`;
  const more = document.getElementById('verMore'); if (more) more.onclick = async (e) => { e.preventDefault(); const { offersModal } = await import('/_ili/offers.js'); offersModal({ title: 'Keep more versions', intro: 'Essential keeps 5 versions of your site, Plus 15 and Pro 30.', current: me.plan }); };
}
$('#verBtn').onclick = openVersions;
$('#verClose').onclick = () => { $('#verModal').hidden = true; };
$('#verModal').addEventListener('click', (e) => { if (e.target === $('#verModal')) $('#verModal').hidden = true; });
$('#verForm').onsubmit = async (e) => {
  e.preventDefault();
  try { await api('/versions', { method: 'POST', body: JSON.stringify({ label: $('#verLabel').value }) }); $('#verLabel').value = ''; toast('Version saved'); renderVersions(); } catch (err) { toast(esc(err.message), true); }
};
$('#verList').onclick = async (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const vid = b.closest('li').dataset.v;
  if (b.dataset.confirm !== '1') {
    b.dataset.confirm = '1'; const was = b.textContent; b.textContent = b.dataset.act === 'restore' ? 'Click to confirm' : 'Confirm';
    setTimeout(() => { b.dataset.confirm = ''; b.textContent = was; }, 3000); return;
  }
  try {
    if (b.dataset.act === 'del') { await api(`/versions/${vid}`, { method: 'DELETE' }); toast('Version deleted'); return renderVersions(); }
    const d = await api(`/versions/${vid}/restore`, { method: 'POST' });
    state.meta.pages = d.pages; state.meta.dirty = true;
    if (!d.pages.includes(state.page)) state.page = 'index.html';
    $('#undo').disabled = true; show(null); refreshPageSelect(); setStatus(); loadFrame();
    $('#verModal').hidden = true;
    toast('Back to that version. Your previous state was saved as a version too. Publish to put it online.');
  } catch (err) { toast(esc(err.message), true); }
};
