const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toast = (m, err) => { const t = $('#toast'); t.textContent = m; t.classList.toggle('err', !!err); t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 4500); };
const size = (b) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : b < 1024 ** 3 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${(b / 1024 ** 3).toFixed(2)} GB`);
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

let data = { clients: [], plans: [] };

async function load() {
  const r = await fetch('/api/admin/clients');
  if (!r.ok) { toast('Could not load clients', true); return; }
  data = await r.json();
  const c = data.clients;
  const paid = c.filter((x) => x.plan !== 'free').length;
  const live = c.reduce((n, x) => n + x.sites.filter((s) => s.live).length, 0);
  const wants = c.filter((x) => x.wantsPlan && x.wantsPlan !== x.plan).length;
  $('#stats').innerHTML = [
    [c.length, 'clients'], [paid, 'on a paid plan'], [wants, 'chose a paid plan, not paid yet'], [live, 'sites online'], [size(data.disk), 'used in total'],
  ].map(([n, l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join('');
  render();
}

function render() {
  const q = $('#q').value.trim().toLowerCase();
  const list = data.clients.filter((x) => !q || [x.email, x.name, ...x.sites.map((s) => s.name + ' ' + (s.address || ''))].join(' ').toLowerCase().includes(q));
  $('#count').textContent = `${list.length} of ${data.clients.length}`;
  $('#rows').innerHTML = list.map((x) => `<tr data-id="${x.id}">
    <td><div class="em">${esc(x.email)}</div>${x.name ? `<div class="sm">${esc(x.name)}</div>` : ''}</td>
    <td><select class="plan" aria-label="Plan">${data.plans.map((p) => `<option value="${p.id}"${p.id === x.plan ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      ${x.wantsPlan && x.wantsPlan !== x.plan ? `<div class="sm"><span class="tag tag-warn">wants ${esc(x.wantsPlan)}</span></div>` : ''}</td>
    <td><input class="credits" type="number" min="0" max="100000" value="${x.credits ?? 0}" aria-label="AI credits" /></td>
    <td>${x.sites.length ? `<ul class="sites">${x.sites.map((s) => `<li>${s.live ? `<a href="https://${esc(s.address)}/" target="_blank" rel="noopener">${esc(s.name)} ↗</a> <span class="tag tag-live">live</span>` : `${esc(s.name)} <span class="sm">draft</span>`}</li>`).join('')}</ul>` : '<span class="sm">none</span>'}</td>
    <td class="num">${size(x.bytes)}</td>
    <td class="sm">${day(x.createdAt)}<br>${x.lastLoginAt ? day(x.lastLoginAt) : 'never signed in again'}</td>
    <td><button class="btn btn-sm btn-danger del" type="button">Delete</button></td>
  </tr>`).join('') || '<tr><td colspan="7" class="muted">No clients yet.</td></tr>';
}

async function patch(id, body, what) {
  const r = await fetch(`/api/admin/clients/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (r.ok) { toast(`${what} saved`); load(); } else toast(d.error || 'Could not save', true);
}

$('#rows').addEventListener('change', (e) => {
  const id = e.target.closest('tr')?.dataset.id; if (!id) return;
  if (e.target.matches('.plan')) patch(id, { plan: e.target.value }, 'Plan');
  if (e.target.matches('.credits')) patch(id, { credits: Number(e.target.value) }, 'Credits');
});

$('#rows').addEventListener('click', async (e) => {
  if (!e.target.matches('.del')) return;
  const id = e.target.closest('tr').dataset.id;
  const x = data.clients.find((c) => c.id === id);
  const typed = prompt(`Delete ${x.email} with its ${x.sites.length} site(s), messages and SEO checks? This cannot be undone.\n\nType the client's email address to confirm:`);
  if (typed === null) return;
  e.target.disabled = true;
  const r = await fetch(`/api/admin/clients/${id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: typed }) });
  const d = await r.json().catch(() => ({}));
  if (r.ok) { toast(`${x.email} deleted (${d.sites} site(s))`); load(); } else { e.target.disabled = false; toast(d.error || 'Could not delete', true); }
});

$('#q').addEventListener('input', render);
load();

// e-mail status (SMTP) and test
(async () => {
  const m = await fetch('/api/admin/mail').then((r) => r.json()).catch(() => ({}));
  $('#mailState').innerHTML = m.enabled ? `E-mail: <b>on</b> · from ${esc(m.from)}` : 'E-mail: <b>not set up</b> (add SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM in Coolify)';
})();
$('#mailTest').onclick = async () => {
  const r = await fetch('/api/admin/mail/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: $('#mailTo').value }) });
  const d = await r.json().catch(() => ({}));
  toast(r.ok && d.ok ? 'Test e-mail sent' : d.error || 'Could not send', !(r.ok && d.ok));
};
