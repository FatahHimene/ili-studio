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
  if (!m.publishedAt) { s.textContent = 'Draft · not published yet'; s.className = 'status dirty'; }
  else if (m.dirty) { s.textContent = 'Saved · unpublished changes'; s.className = 'status dirty'; }
  else { s.textContent = 'Saved · live'; s.className = 'status ok'; }
  const live = $('#live');
  live.hidden = !m.publishedAt; live.href = `/s/${m.slug}/`;
}

async function api(path, opts = {}) {
  const r = await fetch(`/api/sites/${id}${path}`, { signal: AbortSignal.timeout(opts.timeout || 60000), headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}, ...opts });
  let d = {}; try { d = await r.json(); } catch { /* */ }
  if (r.status === 502 || r.status === 504) { if (!d.error) throw new Error('The server took too long to answer. Try again.'); }
  if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
  if (!r.ok) throw new Error(d.error || 'Something went wrong');
  return d;
}

function loadFrame() { frame.src = `/frame/${id}/${state.token}/${state.page}`; }

async function init() {
  const d = await api('');
  state.meta = d; state.token = d.frameToken;
  document.title = `${d.name} · ili studio`;
  $('#siteName').value = d.name;
  $('#page').innerHTML = d.pages.map((p) => `<option value="${esc(p)}">${esc(p === 'index.html' ? 'Home (index.html)' : p)}</option>`).join('');
  $('#pageList').innerHTML = d.pages.map((p) => `<option value="${esc(p)}">`).join('');
  $('#undo').disabled = !d.undo;
  setStatus();
  loadFrame();
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
  fillStyle(info.style);
  wrenUi(info);
}

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
$('#resetStyle').onclick = () => {
  if (!state.sel) return;
  const props = { color: null, 'background-color': null, 'font-size': null, 'font-weight': null, 'text-align': null, 'border-radius': null, padding: null };
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
$('#del').onclick = async (e) => {
  const b = e.currentTarget;
  if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Click to confirm'; setTimeout(() => { b.dataset.confirm = ''; b.textContent = 'Delete'; }, 2500); return; }
  b.dataset.confirm = ''; b.textContent = 'Delete';
  await ops([{ type: 'remove', id: state.sel.id }], { reload: true });
  show(null);
};

// ---- top bar ------------------------------------------------------------------------------
$('#undo').onclick = undo;
$('#page').onchange = (e) => { state.page = e.target.value; state.scrollY = 0; show(null); loadFrame(); api(`?page=${encodeURIComponent(state.page)}`).then((d) => { $('#undo').disabled = !d.undo; }); };
document.querySelectorAll('[data-dev]').forEach((b) => b.onclick = () => {
  document.querySelectorAll('[data-dev]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  $('#device').dataset.dev = b.dataset.dev;
});
document.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => {
  document.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  state.mode = b.dataset.mode; tell({ cmd: 'mode', mode: state.mode });
  if (state.mode !== 'edit') show(null);
});
$('#siteName').onchange = async (e) => {
  const name = e.target.value.trim(); if (!name) { e.target.value = state.meta.name; return; }
  try { const d = await api('', { method: 'PATCH', body: JSON.stringify({ name }) }); state.meta.name = d.name; document.title = `${d.name} · ili studio`; } catch (err) { toast(esc(err.message), true); }
};
$('#publish').onclick = async () => {
  const b = $('#publish'); b.disabled = true; b.textContent = 'Publishing…';
  try {
    const d = await api('/publish', { method: 'POST' });
    state.meta.publishedAt = d.publishedAt; state.meta.dirty = false; setStatus();
    toast(`Published · <a href="${esc(d.url)}" target="_blank" rel="noopener">Open your site ↗</a>`);
  } catch (e) { toast(esc(e.message), true); }
  finally { b.disabled = false; b.textContent = 'Publish'; }
};
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
    const start = await api('/wren', { method: 'POST', body: JSON.stringify({ page: state.page, id: sel.id, instruction, style: sel.style ? `text ${sel.style.color}, background ${sel.style.bgOwn ? sel.style.bg : 'none (inherits ' + sel.style.bg + ')'}, ${sel.style.fontSize}px, weight ${sel.style.fontWeight}, corners ${sel.style.radius}px, padding ${sel.style.padY}px ${sel.style.padX}px` : '', mode: sel.canText && !['section', 'div', 'header', 'footer', 'article'].includes(sel.tag) ? 'text' : 'block' }) });
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
    state.reselect = sel.id; loadFrame();
    $('#wrenInput').value = '';
    toast(`${esc(d.note || 'Wren updated this part')} · <a href="#" id="tUndo">Undo</a>`);
    setTimeout(() => { const u = document.getElementById('tUndo'); if (u) u.onclick = (ev) => { ev.preventDefault(); undo(); }; }, 0);
  } catch (e) { toast(esc(e.name === 'TimeoutError' ? 'Wren took too long. Try again or select a smaller part.' : e.message), true); }
  finally { go.classList.remove('busy'); go.textContent = 'Ask Wren →'; $('#canvas').classList.remove('thinking'); }
}
fetch('/api/ai').then((r) => r.json()).then((d) => { Object.assign(ai, d); wrenUi(state.sel); }).catch(() => {});

init().catch((e) => toast(esc(e.message), true));
