// "Your domain" dialog, used by the editor and the dashboard.
// Step 1: choose how (new free domain / transfer / connect). Step 2 (connect): the two DNS records and a live check.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function call(id, path = '', opts = {}) {
  const r = await fetch(`/api/sites/${id}/domain${path}`, { headers: { 'content-type': 'application/json' }, ...opts });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || 'Something went wrong'); e.code = d.code; throw e; }
  return d;
}

const STATUS = {
  live: ['ok', 'Live'],
  pending: ['wait', 'Waiting for your DNS'],
  paused: ['off', 'Paused: your plan has no domain'],
};

export async function openDomain(siteId, { onChange } = {}) {
  let info;
  try { info = await call(siteId); } catch (e) { alert(e.message); return; }
  const wrap = document.createElement('div');
  wrap.className = 'omodal';
  wrap.innerHTML = `<div class="osheet dom" role="dialog" aria-modal="true" aria-label="Your domain">
    <div class="ohead"><h2>Your domain</h2><button class="btn btn-sm" type="button" data-close aria-label="Close">✕</button></div>
    <div class="dbody"></div></div>`;
  document.body.appendChild(wrap);
  const body = wrap.querySelector('.dbody');
  const close = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
  const changed = (d) => { info = d; onChange?.(d); };

  function choose() {
    if (!info.allowed) {
      body.innerHTML = `<section class="dbox"><h3>Put your site on your own domain</h3>
        <p class="muted">Your own domain, like yourbusiness.co.uk, comes free with every paid plan. Choose a plan and come back here.</p>
        <a class="btn btn-primary" href="/account">See the plans →</a></section>`;
      return;
    }
    body.innerHTML = `<p class="muted">Your plan includes a domain. How would you like to set it up?</p>
      <div class="dchoices">
        <button class="dchoice" type="button" data-way="new"><b>Get a new domain, free</b><span>Find a name like yourbusiness.co.uk. We register it for you, free while your plan is active.</span><em class="tag">Opening soon</em></button>
        <button class="dchoice" type="button" data-way="transfer"><b>Move my domain to you</b><span>Your domain is elsewhere and you want us to look after it. The transfer is free.</span><em class="tag">Opening soon</em></button>
        <button class="dchoice" type="button" data-way="connect"><b>Connect my domain</b><span>Keep your domain where it is and point it to your site. Takes two DNS records.</span></button>
      </div>`;
    body.querySelectorAll('[data-way]').forEach((b) => b.onclick = () => {
      if (b.dataset.way === 'connect') connectForm();
      else soon(b.dataset.way);
    });
  }

  function soon(way) {
    body.innerHTML = `<section class="dbox"><h3>${way === 'new' ? 'Get a new domain, free' : 'Move my domain to you'}</h3>
      <p class="muted">This opens in the next few days. If you are in a hurry, send us a message from <a href="/billing/support">Support</a> with the domain you want and we will set it up for you.</p>
      <p class="muted">If you already own your domain, you can connect it now: your site goes live on it today.</p>
      <div class="row"><button class="btn" type="button" data-back>← Back</button><button class="btn btn-primary" type="button" data-connect>Connect my domain</button></div></section>`;
    body.querySelector('[data-back]').onclick = choose;
    body.querySelector('[data-connect]').onclick = connectForm;
  }

  function connectForm(err = '') {
    body.innerHTML = `<form class="dbox" novalidate><h3>Connect your domain</h3>
      <label class="label" for="domIn">Your domain</label>
      <div class="addr"><span>https://</span><input class="input" id="domIn" placeholder="yourbusiness.co.uk" autocomplete="off" spellcheck="false" required></div>
      <p class="amsg ${err ? 'bad' : ''}" aria-live="polite">${esc(err)}</p>
      <div class="row">${info.domain ? '' : '<button class="btn" type="button" data-back>← Back</button>'}<button class="btn btn-primary" type="submit">Continue →</button></div></form>`;
    body.querySelector('[data-back]')?.addEventListener('click', choose);
    const f = body.querySelector('form'), input = f.querySelector('#domIn');
    input.focus();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const btn = f.querySelector('[type=submit]'); btn.disabled = true; btn.textContent = 'Checking…';
      try { changed(await call(siteId, '', { method: 'POST', body: JSON.stringify({ domain: input.value }) })); show(); }
      catch (e2) { connectForm(e2.message); body.querySelector('#domIn').value = input.value; }
    };
  }

  function show() {
    const d = info.domain;
    if (!d) return choose();
    const [cls, label] = STATUS[d.status] || ['wait', d.status];
    const dns = info.dns;
    const mark = (ok) => (dns ? (ok ? '<span class="dok">✓ found</span>' : '<span class="dno">not yet</span>') : '');
    body.innerHTML = `<section class="dbox">
      <div class="dhead"><b class="dname">${esc(d.name)}</b><span class="dstat ${cls}">${label}</span></div>
      ${d.status === 'live' ? `<p>Your site opens on <a href="https://${esc(d.name)}/" target="_blank" rel="noopener">${esc(d.name)} ↗</a>. Your free address sends visitors there automatically.</p>
        ${info.published ? '' : '<p class="muted">Publish your site to put it online on this domain.</p>'}`
      : d.status === 'paused' ? `<p class="muted">Your site is back on its free address. Choose a paid plan to switch your domain on again.</p><a class="btn btn-primary" href="/account">See the plans →</a>`
      : `<p>Log in where you bought your domain (GoDaddy, 123 Reg, IONOS, Namecheap…), open its <b>DNS settings</b> and add these two records. Delete any other <b>A</b> record on <b>@</b> and any other record on <b>www</b>.</p>
      <table class="drec"><thead><tr><th>Type</th><th>Name / Host</th><th>Value / Points to</th><th></th></tr></thead><tbody>
        ${info.records.map((r, i) => `<tr><td>${r.type}</td><td><code>${esc(r.host)}</code></td><td><code>${esc(r.value)}</code> <button class="btn btn-sm" type="button" data-copy="${esc(r.value)}">Copy</button></td><td>${mark(i === 0 ? dns?.apexOk : dns?.wwwOk)}</td></tr>`).join('')}
      </tbody></table>
      <p class="muted">Changes usually show within an hour, sometimes up to 24 hours. We check every 10 minutes and e-mail you when your site is live on ${esc(d.name)}. Your email (MX records) is not affected.</p>`}
      <div class="row">
        ${d.status === 'pending' ? '<button class="btn btn-primary" type="button" data-check>Check now</button>' : ''}
        <button class="btn" type="button" data-change>Use another domain</button>
        <button class="btn" type="button" data-remove>Remove domain</button>
      </div>
      <p class="amsg" aria-live="polite"></p></section>`;
    const msg = body.querySelector('.amsg');
    body.querySelectorAll('[data-copy]').forEach((b) => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1500); } catch { /* ignore */ } });
    body.querySelector('[data-check]')?.addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.textContent = 'Checking…';
      try { changed(await call(siteId, '/check', { method: 'POST' })); show(); if (info.domain?.status !== 'live') body.querySelector('.amsg').textContent = 'Not ready yet. DNS changes can take a while, we keep checking for you.'; }
      catch (e2) { msg.className = 'amsg bad'; msg.textContent = e2.message; e.target.disabled = false; e.target.textContent = 'Check now'; }
    });
    body.querySelector('[data-change]').onclick = () => connectForm();
    body.querySelector('[data-remove]').onclick = async () => {
      if (!confirm(`Remove ${d.name} from this site? It goes back to its free address.`)) return;
      try { changed(await call(siteId, '', { method: 'DELETE' })); choose(); } catch (e2) { msg.className = 'amsg bad'; msg.textContent = e2.message; }
    };
  }

  info.domain ? show() : choose();
}
