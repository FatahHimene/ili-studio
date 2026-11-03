const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg, err = false) {
  const t = $('#toast'); t.innerHTML = msg; t.classList.toggle('err', err); t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 4500);
}
const grid = $('#grid');

async function load() {
  const r = await fetch('/api/themes?all=1'); if (r.status === 401) { location.href = '/login'; return; }
  const themes = await r.json();
  grid.querySelectorAll('.tcard').forEach((c) => c.remove());
  for (const t of themes) {
    const el = document.createElement('article');
    el.className = 'card tcard' + (t.hidden ? ' is-hidden' : '');
    const thumb = t.preview ? `<img src="/theme-files/${t.id}/${esc(t.preview)}" alt="" loading="lazy">` : `<iframe loading="lazy" sandbox="allow-scripts" tabindex="-1" title="" scrolling="no" src="/theme-files/${t.id}/index.html"></iframe>`;
    el.innerHTML = `
      <a class="thumb" href="/theme-files/${t.id}/index.html" target="_blank" rel="noopener" aria-label="Preview ${esc(t.name)}">${thumb}</a>
      <div class="meta"><h3>${esc(t.name)}</h3>
        <div class="facts"><span class="tag">${esc(t.category)}</span><span>v${esc(t.version)}</span><span>· ${t.pages.length} page${t.pages.length > 1 ? 's' : ''}</span><span>· ${t.source}</span>${t.hidden ? '<span class="tag">Hidden</span>' : ''}</div>
        <p>${esc(t.description)}</p>
        ${(t.palettes || []).length ? `<div class="facts">${t.palettes.map((p) => `<span title="${esc(p.name)}" style="display:inline-flex">${Object.values(p.colors).slice(0, 4).map((c) => `<i style="width:14px;height:14px;display:inline-block;background:${esc(c)};border:1px solid rgba(0,0,0,.12)"></i>`).join('')}</span>`).join(' ')}</div>` : ''}
        ${t.templates.length ? `<div class="tpls">${t.templates.map((x) => `<span class="tag">+ ${esc(x.name)}</span>`).join('')}</div>` : ''}
      </div>
      <div class="acts">
        <a class="btn btn-sm" href="/theme-files/${t.id}/index.html" target="_blank" rel="noopener">Preview ↗</a>
        ${t.hidden ? `<button class="btn btn-sm restore" data-id="${esc(t.id)}">Restore</button>` : `<button class="btn btn-sm btn-danger del" data-id="${esc(t.id)}">Delete</button>`}
      </div>`;
    grid.appendChild(el);
  }
}

grid.addEventListener('click', async (e) => {
  const rb = e.target.closest('.restore');
  if (rb) {
    const r = await fetch(`/api/themes/${rb.dataset.id}/restore`, { method: 'POST' });
    if (r.ok) { toast('Theme restored'); load(); } else toast('Could not restore', true);
    return;
  }
  const b = e.target.closest('.del'); if (!b) return;
  if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Click to confirm'; setTimeout(() => { b.dataset.confirm = ''; b.textContent = 'Delete'; }, 3000); return; }
  const r = await fetch(`/api/themes/${b.dataset.id}`, { method: 'DELETE' });
  const d = await r.json().catch(() => ({}));
  if (r.ok) { toast('Theme deleted'); load(); } else toast(esc(d.error || 'Could not delete'), true);
});

async function upload(file) {
  if (!file || !/\.zip$/i.test(file.name)) return toast('Choose a theme .zip file', true);
  $('#status').textContent = `Installing ${file.name}…`;
  const fd = new FormData(); fd.append('file', file);
  const r = await fetch('/api/themes', { method: 'POST', body: fd });
  const d = await r.json().catch(() => ({}));
  $('#status').textContent = '';
  if (!r.ok) return toast(esc(d.error || 'Install failed'), true);
  toast(`Theme “${esc(d.name)}” installed`); function fitThumbs() {
  document.querySelectorAll('.thumb').forEach((t) => {
    const f = t.querySelector('iframe'); if (!f) return;
    const scale = t.clientWidth / 1280; f.style.width = '1280px'; f.style.height = `${Math.ceil(t.clientHeight / scale)}px`; f.style.transform = `scale(${scale})`;
  });
}
new ResizeObserver(fitThumbs).observe(document.body);
new MutationObserver(fitThumbs).observe(document.body, { childList: true, subtree: true });
load();
}
const up = $('#up');
$('#choose').onclick = () => $('#file').click();
$('#file').onchange = (e) => { upload(e.target.files[0]); e.target.value = ''; };
['dragenter', 'dragover'].forEach((t) => up.addEventListener(t, (e) => { e.preventDefault(); up.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => up.addEventListener(t, (e) => { e.preventDefault(); up.classList.remove('over'); }));
up.addEventListener('drop', (e) => upload(e.dataTransfer.files[0]));
function fitThumbs() {
  document.querySelectorAll('.thumb').forEach((t) => {
    const f = t.querySelector('iframe'); if (!f) return;
    const scale = t.clientWidth / 1280; f.style.width = '1280px'; f.style.height = `${Math.ceil(t.clientHeight / scale)}px`; f.style.transform = `scale(${scale})`;
  });
}
new ResizeObserver(fitThumbs).observe(document.body);
new MutationObserver(fitThumbs).observe(document.body, { childList: true, subtree: true });
load();
