const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg, err = false) {
  const t = $('#toast'); t.innerHTML = msg; t.classList.toggle('err', err); t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 4500);
}
const grid = $('#grid');

async function load() {
  const r = await fetch('/api/themes'); if (r.status === 401) { location.href = '/login'; return; }
  const themes = await r.json();
  grid.querySelectorAll('.tcard').forEach((c) => c.remove());
  for (const t of themes) {
    const el = document.createElement('article');
    el.className = 'card tcard';
    const thumb = t.preview ? `<img src="/theme-files/${t.id}/${esc(t.preview)}" alt="" loading="lazy">` : `<iframe loading="lazy" sandbox="allow-scripts" tabindex="-1" title="" src="/theme-files/${t.id}/index.html"></iframe>`;
    el.innerHTML = `
      <a class="thumb" href="/theme-files/${t.id}/index.html" target="_blank" rel="noopener" aria-label="Preview ${esc(t.name)}">${thumb}</a>
      <div class="meta"><h3>${esc(t.name)}</h3>
        <div class="facts"><span class="tag">${esc(t.category)}</span><span>v${esc(t.version)}</span><span>· ${t.pages.length} page${t.pages.length > 1 ? 's' : ''}</span><span>· ${t.source}</span></div>
        <p>${esc(t.description)}</p>
        ${t.templates.length ? `<div class="tpls">${t.templates.map((x) => `<span class="tag">+ ${esc(x.name)}</span>`).join('')}</div>` : ''}
      </div>
      <div class="acts">
        <a class="btn btn-sm" href="/theme-files/${t.id}/index.html" target="_blank" rel="noopener">Preview ↗</a>
        ${t.source === 'uploaded' ? `<button class="btn btn-sm btn-danger del" data-id="${esc(t.id)}">Delete</button>` : '<span class="muted" style="margin-left:auto;font-size:12px">Built-in</span>'}
      </div>`;
    grid.appendChild(el);
  }
}

grid.addEventListener('click', async (e) => {
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
  toast(`Theme “${esc(d.name)}” installed`); load();
}
const up = $('#up');
$('#choose').onclick = () => $('#file').click();
$('#file').onchange = (e) => { upload(e.target.files[0]); e.target.value = ''; };
['dragenter', 'dragover'].forEach((t) => up.addEventListener(t, (e) => { e.preventDefault(); up.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => up.addEventListener(t, (e) => { e.preventDefault(); up.classList.remove('over'); }));
up.addEventListener('drop', (e) => upload(e.dataTransfer.files[0]));
load();
