const $ = (s) => document.querySelector(s);
const grid = $('#grid');
const drop = $('#drop');
const fileInput = $('#file');

function toast(msg, err = false) {
  const t = $('#toast'); t.innerHTML = msg; t.classList.toggle('err', err); t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 4000);
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = (iso) => {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

async function load() {
  const sites = await (await fetch('/api/sites')).json();
  grid.querySelectorAll('.card').forEach((c) => c.remove());
  if (!sites.length) return;
  for (const s of sites) {
    const status = !s.publishedAt ? '<span class="tag">Draft</span>' : s.dirty ? '<span class="tag tag-warn">Unpublished changes</span>' : '<span class="tag tag-live">Live</span>';
    const el = document.createElement('article');
    el.className = 'card';
    el.innerHTML = `
      <a class="thumb" href="/editor/${s.id}" aria-label="Edit ${esc(s.name)}"><iframe loading="lazy" sandbox="allow-scripts" tabindex="-1" title=""></iframe></a>
      <div class="meta"><h3>${esc(s.name)}</h3>
        <div class="facts">${status}<span>${s.pages.length} page${s.pages.length > 1 ? 's' : ''}</span><span>· edited ${ago(s.updatedAt)}</span></div></div>
      <div class="acts">
        <a class="btn btn-sm btn-dark" href="/editor/${s.id}">Edit</a>
        ${s.publishedAt ? `<a class="btn btn-sm" href="/s/${esc(s.slug)}/" target="_blank" rel="noopener">View live ↗</a>` : ''}
        <button class="btn btn-sm btn-danger del" data-id="${s.id}" data-name="${esc(s.name)}">Delete</button>
      </div>`;
    grid.appendChild(el);
    fetch(`/api/sites/${s.id}`).then((r) => r.json()).then((d) => { el.querySelector('iframe').src = `/frame/${s.id}/${d.frameToken}/index.html?ili-thumb=1`; });
  }
}

grid.addEventListener('click', async (e) => {
  const b = e.target.closest('.del');
  if (!b) return;
  if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Click again to delete'; setTimeout(() => { b.dataset.confirm = ''; b.textContent = 'Delete'; }, 3000); return; }
  const r = await fetch(`/api/sites/${b.dataset.id}`, { method: 'DELETE' });
  if (r.ok) { toast(`Deleted ${esc(b.dataset.name)}`); load(); } else toast('Could not delete this site', true);
});

function upload(file) {
  if (!file) return;
  if (!/\.(zip|html?)$/i.test(file.name)) return toast('Please choose a .zip or .html file', true);
  const fd = new FormData(); fd.append('file', file); fd.append('name', drop.elements.name.value);
  const xhr = new XMLHttpRequest();
  const prog = $('#prog'); const bar = prog.querySelector('i'); const status = $('#status');
  prog.hidden = false; bar.style.width = '0%'; status.textContent = `Uploading ${file.name}…`;
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) bar.style.width = `${Math.round((e.loaded / e.total) * 100)}%`; };
  xhr.upload.onload = () => { status.textContent = 'Importing and preparing your site…'; };
  xhr.onload = () => {
    prog.hidden = true;
    let d = {}; try { d = JSON.parse(xhr.responseText); } catch { /* */ }
    if (xhr.status >= 400) { status.textContent = ''; return toast(esc(d.error || 'Import failed'), true); }
    status.textContent = '';
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
load();
