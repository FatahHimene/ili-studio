// Shared offers screen: the same plan cards after sign-up, when AI credits run out and before publishing.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n === 0 ? '£0' : `£${n.toFixed(2)}`);

let cache = null;
export async function getPlans() {
  if (!cache) cache = fetch('/api/plans').then((r) => r.json());
  return cache;
}

/**
 * Render the plan cards into `el`.
 * opts.current  id of the user's plan (marked "Your plan")
 * opts.freeLabel / opts.paidLabel  button texts
 * opts.onPick(planId)  called when a button is pressed
 * opts.only  'paid' to show paid plans only
 */
export async function renderOffers(el, opts = {}) {
  const { plans } = await getPlans();
  const list = opts.only === 'paid' ? plans.filter((p) => p.price > 0) : plans;
  el.classList.add('offers');
  el.innerHTML = list.map((p) => `
    <article class="offer${p.featured ? ' featured' : ''}${opts.current === p.id ? ' current' : ''}">
      ${p.featured ? '<span class="ribbon">Most chosen</span>' : ''}
      <h3>${esc(p.name)}</h3>
      <p class="price"><b>${money(p.price)}</b>${p.price ? '<span>/ month</span>' : '<span>for good</span>'}</p>
      <p class="sum">${esc(p.summary)}</p>
      <ul>${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
      <button class="btn ${p.price ? (p.featured ? 'btn-primary' : 'btn-dark') : ''}" type="button" data-plan="${p.id}" ${opts.current === p.id ? 'disabled' : ''}>
        ${opts.current === p.id ? 'Your plan' : esc(p.price ? (opts.paidLabel || `Choose ${p.name}`) : (opts.freeLabel || 'Start free'))}
      </button>
    </article>`).join('');
  el.onclick = (e) => { const b = e.target.closest('[data-plan]'); if (b && opts.onPick) opts.onPick(b.dataset.plan, b); };
}

/** Record a choice. Card payment is not switched on yet, so a paid choice is only remembered. */
export async function choosePlan(plan) {
  const r = await fetch('/api/me/choice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) });
  if (!r.ok) throw new Error('Could not save your choice');
  return r.json();
}

/** A ready-made modal with the offers (used in the editor). Returns a promise resolved when it closes. */
export function offersModal({ title = 'Choose a plan', intro = '', current = 'free', actions = '' } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'omodal';
    wrap.innerHTML = `<div class="osheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="ohead"><h2>${esc(title)}</h2><button class="btn btn-sm" type="button" data-close aria-label="Close">✕</button></div>
      ${intro ? `<p class="ointro">${intro}</p>` : ''}
      ${actions ? `<div class="oacts">${actions}</div>` : ''}
      <div class="ogrid"></div>
      <p class="onote" hidden></p>
    </div>`;
    document.body.appendChild(wrap);
    const close = (v) => { wrap.remove(); resolve(v); };
    wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) close(e.target.closest('[data-close]')?.dataset.close || null); });
    renderOffers(wrap.querySelector('.ogrid'), {
      current, only: 'paid',
      onPick: async (plan) => {
        try { await choosePlan(plan); } catch { /* */ }
        const n = wrap.querySelector('.onote');
        n.hidden = false;
        n.innerHTML = 'Thank you! Card payment opens very soon: we have saved your choice and will email you as soon as you can switch. Meanwhile, keep building for free.';
      },
    });
  });
}
