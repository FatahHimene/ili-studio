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

export async function openDomain(siteId, { onChange, onPublish, inEditor = false } = {}) {
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
    const reg = info.register || {};
    const freeCard = reg.used
      ? `<button class="dchoice" type="button" data-way="mine"><b>Use my free domain: ${esc(reg.used)}</b><span>The domain that came with your plan. Put it on this site in one click.</span></button>`
      : `<button class="dchoice" type="button" data-way="new"><b>Get a new domain, free</b><span>Find a name ending in ${esc((reg.tlds || ['.co.uk']).join(', '))}. We register it in your name, free while your plan is active.</span>${reg.ready ? '' : `<em class="tag">${reg.admin ? 'Clients only' : 'Opening soon'}</em>`}</button>`;
    body.innerHTML = `<p class="muted">Your plan includes a domain. How would you like to set it up?</p>
      <div class="dchoices">
        ${freeCard}
        <button class="dchoice" type="button" data-way="connect"><b>Connect a domain I already own</b><span>Keep your domain where it is and point it to your site. Takes two DNS records.</span></button>
        <button class="dchoice" type="button" data-way="transfer"><b>Move my domain to you</b><span>Your domain is elsewhere and you want us to look after it.</span><em class="tag">Later</em></button>
      </div>`;
    body.querySelectorAll('[data-way]').forEach((b) => b.onclick = async () => {
      const way = b.dataset.way;
      if (way === 'connect') return connectForm();
      if (way === 'new' && reg.ready) return search();
      if (way === 'mine') {
        b.disabled = true;
        try { changed(await call(siteId, '', { method: 'POST', body: JSON.stringify({ domain: reg.used }) })); show(); } catch (e) { b.disabled = false; alert(e.message); }
        return;
      }
      soon(way);
    });
  }

  function search(err = '', q = '') {
    const reg = info.register || {};
    body.innerHTML = `<form class="dbox" novalidate><h3>Find your free domain</h3>
      <p class="muted">Type your business name. Included with your plan: ${esc((reg.tlds || []).join(', '))}.</p>
      <div class="addr"><input class="input" id="dq" placeholder="yourbusiness" autocomplete="off" spellcheck="false" value="${esc(q)}"><button class="btn btn-primary" type="submit">Search</button></div>
      <p class="amsg ${err ? 'bad' : ''}" aria-live="polite">${esc(err)}</p>
      <div class="dres"></div>
      <div class="row"><button class="btn" type="button" data-back>← Back</button></div></form>`;
    body.querySelector('[data-back]').onclick = choose;
    const f = body.querySelector('form'), input = f.querySelector('#dq'), out = f.querySelector('.dres'), msg = f.querySelector('.amsg');
    input.focus();
    f.onsubmit = async (e) => {
      e.preventDefault();
      msg.className = 'amsg'; msg.textContent = 'Searching…'; out.innerHTML = '';
      try {
        const r = await fetch(`/api/domains/search?q=${encodeURIComponent(input.value)}`);
        const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Search failed');
        msg.textContent = d.results.some((x) => x.available) ? 'Pick the one you like:' : 'None of these are free. Try another name, for example with your town.';
        out.innerHTML = d.results.map((x) => `<div class="dhit ${x.available ? '' : 'off'}"><b>${esc(x.name)}</b>
          ${x.available ? `<span class="tag tag-live">Free with your plan</span><button class="btn btn-sm btn-primary" type="button" data-pick="${esc(x.name)}">Choose</button>` : `<span class="muted">${x.available === false ? 'Taken' : 'Could not check'}</span>`}</div>`).join('');
        out.querySelectorAll('[data-pick]').forEach((b) => b.onclick = () => ownerForm(b.dataset.pick, input.value));
      } catch (e2) { msg.className = 'amsg bad'; msg.textContent = e2.message; }
    };
    if (q) f.requestSubmit();
  }

  function ownerForm(name, q, err = '', v = {}) {
    const reg = info.register || {};
    const [first = '', ...rest] = String(reg.name || '').split(/\s+/);
    const val = (k, d = '') => esc(v[k] ?? d);
    body.innerHTML = `<form class="dbox downer" novalidate><h3>Register ${esc(name)}</h3>
      <p class="muted">The domain is registered in your name: you are its legal owner. The UK registry (Nominet) needs these details. For a person, they are not shown publicly.</p>
      <label>Who owns it?<select class="input" name="type">
        <option value="IND" ${v.type === 'IND' || !v.type ? 'selected' : ''}>Me, personally</option>
        <option value="STRA" ${v.type === 'STRA' ? 'selected' : ''}>My business (sole trader)</option>
        <option value="LTD" ${v.type === 'LTD' ? 'selected' : ''}>My limited company</option></select></label>
      <div class="two"><label>First name<input class="input" name="firstName" value="${val('firstName', first)}" autocomplete="given-name" required></label>
        <label>Last name<input class="input" name="lastName" value="${val('lastName', rest.join(' '))}" autocomplete="family-name" required></label></div>
      <div class="two biz"><label>Business name<input class="input" name="company" value="${val('company')}" autocomplete="organization"></label>
        <label class="ltd">Company number<input class="input" name="companyNumber" value="${val('companyNumber')}" placeholder="01234567"></label></div>
      <label>Address<input class="input" name="address1" value="${val('address1')}" autocomplete="address-line1" required></label>
      <label><span class="sr">Address line 2</span><input class="input" name="address2" value="${val('address2')}" autocomplete="address-line2" placeholder="Address line 2 (optional)"></label>
      <div class="two"><label>Town or city<input class="input" name="city" value="${val('city')}" autocomplete="address-level2" required></label>
        <label>Postcode<input class="input" name="postcode" value="${val('postcode')}" autocomplete="postal-code" required></label></div>
      <label>Phone<input class="input" name="phone" type="tel" value="${val('phone')}" autocomplete="tel" required></label>
      <p class="amsg ${err ? 'bad' : ''}" aria-live="polite">${esc(err)}</p>
      <div class="row"><button class="btn" type="button" data-back>← Back</button><button class="btn btn-primary" type="submit">Register ${esc(name)} for free</button></div></form>`;
    const f = body.querySelector('form');
    const sync = () => { const t = f.type.value; f.querySelector('.biz').hidden = t === 'IND'; f.querySelector('.ltd').hidden = t !== 'LTD'; };
    f.type.onchange = sync; sync();
    body.querySelector('[data-back]').onclick = () => search('', q);
    f.onsubmit = async (e) => {
      e.preventDefault();
      const who = Object.fromEntries(new FormData(f));
      const btn = f.querySelector('[type=submit]'); btn.disabled = true; btn.textContent = 'Registering… this can take a minute';
      try { changed(await call(siteId, '/register', { method: 'POST', body: JSON.stringify({ domain: name, who }) })); show(); }
      catch (e2) { ownerForm(name, q, e2.message, who); }
    };
  }

  function soon(way) {
    body.innerHTML = `<section class="dbox"><h3>${way === 'new' ? 'Get a new domain, free' : 'Move my domain to you'}</h3>
      <p class="muted">${way === 'new' && info.register?.admin ? 'The free domain is registered in the client\'s name, from their own account (paid plan). As admin, register domains in Blesta.' : way === 'new' ? 'This opens very soon.' : 'Transfers open later.'} If you are in a hurry, send us a message from <a href="/billing/support">Support</a> and we will help you.</p>
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

  /** The "what to do now" part: publish here, or open the editor. */
  function nextStep(d) {
    const live = d.status === 'live';
    if (!info.published) return `<div class="dnext"><b>${live ? 'Last step: publish your site.' : 'Your site is not published yet.'}</b>
      <p>${live ? `Your domain is ready. Publish your site and it opens on ${esc(d.name)} straight away.` : `Publish it now if you like: it goes online on its free address today, and moves to ${esc(d.name)} as soon as ${d.registered ? 'it is ready' : 'your DNS is ready'}.`}</p>
      <p class="muted">You choose its free address in the next window.</p>
      <div class="row">${inEditor ? '<button class="btn btn-primary" type="button" data-first>Publish my site</button>' : `<a class="btn btn-primary" href="/editor/${siteId}?publish=1">Publish my site</a><a class="btn" href="/editor/${siteId}">Open the editor</a>`}</div></div>`;
    if (live && info.dirty) return `<div class="dnext"><b>Publish once more to finish.</b>
      <p>You have changes that are not online yet, and Google needs to learn your new address. One click does both.</p>
      <div class="row"><button class="btn btn-primary" type="button" data-publish>Publish now</button>${inEditor ? '' : `<a class="btn" href="/editor/${siteId}">Open the editor</a>`}</div></div>`;
    return '';
  }

  function show(note = '') {
    const d = info.domain;
    if (!d) return choose();
    const [cls, label] = d.registered && d.status === 'pending' ? ['wait', 'Setting up'] : STATUS[d.status] || ['wait', d.status];
    const dns = info.dns;
    const mark = (ok) => (dns ? (ok ? '<span class="dok">✓ found</span>' : '<span class="dno">not yet</span>') : '');
    const steps = `<ol class="dsteps">
        <li class="${d.status === 'live' || d.registered ? 'done' : 'now'}"><b>${d.registered ? 'We register your domain' : 'Point your domain to us'}</b><span>${d.registered ? (d.status === 'live' ? 'Done: registered in your name.' : 'Done: registered in your name. We are connecting it to your site.') : d.status === 'live' ? 'Done: your DNS is right.' : 'Add the two records below where you bought your domain.'}</span></li>
        <li class="${d.status === 'live' ? 'done' : d.registered ? 'now' : ''}"><b>We check it for you</b><span>${d.status === 'live' ? `Done: ${esc(d.name)} is connected, with HTTPS.` : 'Every 10 minutes, and we e-mail you when it works.'}</span></li>
        <li class="${info.published && !(d.status === 'live' && info.dirty) ? (d.status === 'live' ? 'done' : '') : d.status === 'live' ? 'now' : ''}"><b>Publish your site</b><span>${info.published ? 'Your site is published.' : 'Not published yet.'}</span></li>
      </ol>`;
    body.innerHTML = `<section class="dbox">
      <div class="dhead"><b class="dname">${esc(d.name)}</b><span class="dstat ${cls}">${label}</span></div>
      ${d.status === 'paused' ? `<p class="muted">Your site is back on its free address. Choose a paid plan to switch your domain on again.</p><a class="btn btn-primary" href="/account">See the plans →</a>` : steps}
      ${d.status === 'live' && info.published && !info.dirty ? `<div class="dnext ok"><b>Your site is online on <a href="https://${esc(d.name)}/" target="_blank" rel="noopener">${esc(d.name)} ↗</a></b>
        <p>Visitors of your free address are sent there automatically. If it does not open on your own computer yet, your internet provider still remembers the old address: it clears by itself within a few hours.</p></div>` : ''}
      ${d.status !== 'paused' ? nextStep(d) : ''}
      ${d.status === 'pending' && d.registered ? `<p>Your new domain usually works within 15 to 60 minutes. Nothing to do on your side: we e-mail you when it is ready.</p>` : ''}
      ${d.status === 'pending' && !d.registered ? `<p>Log in where you bought your domain (GoDaddy, 123 Reg, IONOS, Namecheap, Internet.bs…), open its <b>DNS settings</b> and add these two records. Delete any other <b>A</b> record on <b>@</b> and any other record on <b>www</b>.</p>
      <table class="drec"><thead><tr><th>Type</th><th>Name / Host</th><th>Value / Points to</th><th></th></tr></thead><tbody>
        ${info.records.map((r, i) => `<tr><td>${r.type}</td><td><code>${esc(r.host)}</code></td><td><code>${esc(r.value)}</code> <button class="btn btn-sm" type="button" data-copy="${esc(r.value)}">Copy</button></td><td>${mark(i === 0 ? dns?.apexOk : dns?.wwwOk)}</td></tr>`).join('')}
      </tbody></table>
      <p class="muted">Changes usually show within an hour, sometimes up to 24 hours. Your e-mail (MX records) is not affected.</p>` : ''}
      <div class="row">
        ${d.status === 'pending' ? '<button class="btn btn-primary" type="button" data-check>Check now</button>' : ''}
        <button class="btn" type="button" data-change>${d.registered ? 'Connect another domain' : 'Use another domain'}</button>
        <button class="btn" type="button" data-remove>Remove domain</button>
      </div>
      <p class="amsg" aria-live="polite">${esc(note)}</p></section>`;
    const msg = body.querySelector('.amsg');
    body.querySelectorAll('[data-copy]').forEach((b) => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1500); } catch { /* ignore */ } });
    body.querySelector('[data-first]')?.addEventListener('click', () => { close(); onPublish?.(); });
    body.querySelectorAll('[data-publish]').forEach((b) => b.onclick = async () => {
      b.disabled = true; b.textContent = 'Publishing…';
      try {
        const r = await fetch(`/api/sites/${siteId}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        const p = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(p.error || 'Could not publish');
        changed({ ...(await call(siteId)), published: true, dirty: false, justPublished: p });
        show();
      } catch (e2) { msg.className = 'amsg bad'; msg.textContent = `${e2.message}${inEditor ? '' : ' You can also publish from the editor.'}`; b.disabled = false; b.textContent = 'Try again'; }
    });
    body.querySelector('[data-check]')?.addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.textContent = 'Checking…';
      try { changed(await call(siteId, '/check', { method: 'POST' })); show(info.domain?.status === 'live' ? '' : 'Not ready yet. DNS changes can take a while: we keep checking and e-mail you.'); }
      catch (e2) { msg.className = 'amsg bad'; msg.textContent = e2.message; e.target.disabled = false; e.target.textContent = 'Check now'; }
    });
    body.querySelector('[data-change]').onclick = () => connectForm();
    body.querySelector('[data-remove]').onclick = async () => {
      if (!confirm(`Remove ${d.name} from this site? It goes back to its free address.${d.registered ? ' The domain stays yours.' : ''}`)) return;
      try { changed(await call(siteId, '', { method: 'DELETE' })); choose(); } catch (e2) { msg.className = 'amsg bad'; msg.textContent = e2.message; }
    };
  }

  info.domain ? show() : choose();
}
