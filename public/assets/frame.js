// ili studio, script injected into the site being edited (runs inside a sandboxed iframe).
// It highlights elements, lets the user select and edit them, and talks to the editor via postMessage.
(() => {
  if (window.__ili) return; window.__ili = true;
  if (location.search.includes('ili-thumb')) return; // dashboard thumbnails: no editing UI
  const ID = 'data-ili-id';
  const INLINE = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'BR', 'SPAN', 'A', 'SMALL', 'SUP', 'SUB', 'MARK', 'CODE', 'ABBR', 'TIME', 'IMG', 'SVG']);
  const post = (msg) => parent.postMessage({ ili: true, ...msg }, '*');
  let mode = 'edit';
  let selected = null;
  let editing = null;
  let original = '';

  // ---- overlay UI (lives outside the page's own DOM tree as much as possible) --------
  const css = document.createElement('style');
  css.setAttribute('data-ili-ui', '');
  css.textContent = `
    .__ili-box{position:fixed;pointer-events:none;z-index:2147483646;border:1.5px dashed #0D1221;border-radius:2px;transition:all .06s linear;display:none}
    .__ili-sel{border:2px solid #C8F031;box-shadow:0 0 0 1px #0D1221;display:none}
    .__ili-lab{position:fixed;z-index:2147483647;pointer-events:none;background:#0D1221;color:#C8F031;font:500 11px/1 ui-monospace,monospace;padding:4px 6px;border-radius:2px;display:none;white-space:nowrap}
    [contenteditable="true"][${ID}]{outline:2px solid #C8F031!important;outline-offset:3px;cursor:text!important;caret-color:#0D1221}
    html.__ili-edit *{cursor:pointer}
  `;
  document.head.appendChild(css);
  const mk = (cls) => { const d = document.createElement('div'); d.className = cls; d.setAttribute('data-ili-ui', ''); document.documentElement.appendChild(d); return d; };
  const hoverBox = mk('__ili-box');
  const selBox = mk('__ili-box __ili-sel');
  const label = mk('__ili-lab');
  document.documentElement.classList.add('__ili-edit');

  // ---- element classification ------------------------------------------------------
  const target = (node) => (node && node.closest ? node.closest(`[${ID}]`) : null);
  const hasText = (el) => (el.textContent || '').trim().length > 0;
  const inlineOnly = (el) => [...el.querySelectorAll('*')].every((c) => INLINE.has(c.tagName.toUpperCase()) || c.closest('svg'));
  const canText = (el) => !['IMG', 'INPUT', 'SELECT', 'TEXTAREA', 'IFRAME', 'VIDEO', 'SVG'].includes(el.tagName) && hasText(el) && inlineOnly(el);
  function kind(el) {
    if (el.tagName === 'IMG') return 'image';
    if (el.tagName === 'A') return canText(el) ? 'link' : 'link-block';
    if (el.tagName === 'BUTTON') return 'button';
    if (canText(el)) return 'text';
    return 'block';
  }
  const NAMES = { image: 'Image', link: 'Link', 'link-block': 'Link', button: 'Button', text: 'Text', block: 'Section' };
  function describe(el) {
    const k = kind(el);
    const a = el.tagName === 'A' ? el : el.closest('a[' + ID + ']');
    const bgImg = getComputedStyle(el).backgroundImage;
    return {
      id: el.getAttribute(ID), tag: el.tagName.toLowerCase(), kind: k, name: NAMES[k], canText: canText(el),
      text: canText(el) ? el.textContent.trim().slice(0, 200) : '',
      src: el.tagName === 'IMG' ? el.getAttribute('src') : null, alt: el.tagName === 'IMG' ? el.getAttribute('alt') || '' : null,
      preview: el.tagName === 'IMG' ? el.currentSrc || el.src : null,
      link: a ? { id: a.getAttribute(ID), href: a.getAttribute('href') || '', blank: a.getAttribute('target') === '_blank' } : null,
      hasBg: bgImg && bgImg !== 'none',
      parentId: el.parentElement ? target(el.parentElement)?.getAttribute(ID) || null : null,
      hasPrev: !!el.previousElementSibling, hasNext: !!el.nextElementSibling,
    };
  }

  // ---- drawing ------------------------------------------------------------------
  function place(box, el) {
    if (!el || !el.isConnected) { box.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', top: r.top - 3 + 'px', left: r.left - 3 + 'px', width: r.width + 6 + 'px', height: r.height + 6 + 'px' });
    return r;
  }
  function drawLabel(el) {
    if (!el) { label.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    label.textContent = NAMES[kind(el)] + ' · ' + el.tagName.toLowerCase();
    label.style.display = 'block';
    label.style.top = Math.max(2, r.top - 24) + 'px';
    label.style.left = Math.max(2, r.left - 3) + 'px';
  }
  let raf = 0;
  function loop() { if (selected) { place(selBox, selected); drawLabel(selected); } raf = requestAnimationFrame(loop); }

  function select(el, notify = true) {
    if (editing && editing !== el) finishEdit(true);
    selected = el;
    if (!el) { selBox.style.display = 'none'; label.style.display = 'none'; if (notify) post({ type: 'deselect' }); return; }
    place(selBox, el); drawLabel(el);
    if (notify) post({ type: 'select', info: describe(el) });
  }

  // ---- inline text editing ------------------------------------------------------------
  function startEdit(el) {
    if (!el || !canText(el)) return;
    if (editing) finishEdit(true);
    editing = el; original = el.innerHTML;
    el.setAttribute('contenteditable', 'true');
    el.focus();
    const range = document.createRange(); range.selectNodeContents(el); range.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(range);
    post({ type: 'editing', id: el.getAttribute(ID) });
  }
  function finishEdit(save) {
    const el = editing; if (!el) return;
    editing = null;
    el.removeAttribute('contenteditable');
    if (!save) { el.innerHTML = original; post({ type: 'edit-cancel' }); return; }
    const html = el.innerHTML;
    if (html !== original) post({ type: 'text', id: el.getAttribute(ID), html });
    else post({ type: 'edit-cancel' });
  }

  // ---- events (capture phase, so the site's own handlers do not fire while editing) ----
  const isUi = (n) => n && n.closest && n.closest('[data-ili-ui]');
  document.addEventListener('mouseover', (e) => {
    if (mode !== 'edit' || isUi(e.target)) return;
    const el = target(e.target);
    if (el && el !== selected && el !== editing) place(hoverBox, el); else hoverBox.style.display = 'none';
  }, true);
  document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) hoverBox.style.display = 'none'; }, true);
  for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'submit', 'auxclick']) {
    document.addEventListener(type, (e) => {
      if (mode !== 'edit' || isUi(e.target)) return;
      if (editing && editing.contains(e.target)) return; // let the caret move inside the text
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      if (type === 'click') { const el = target(e.target); hoverBox.style.display = 'none'; select(el); }
    }, true);
  }
  document.addEventListener('dblclick', (e) => {
    if (mode !== 'edit') return;
    const el = target(e.target);
    if (el && canText(el)) { e.preventDefault(); e.stopPropagation(); select(el); startEdit(el); }
  }, true);
  document.addEventListener('keydown', (e) => {
    if (editing) {
      if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finishEdit(true); }
      e.stopPropagation();
      return;
    }
    if (mode !== 'edit') return;
    if (e.key === 'Escape') select(null);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); post({ type: 'undo' }); }
    if (e.key === 'Enter' && selected && canText(selected)) { e.preventDefault(); startEdit(selected); }
  }, true);
  document.addEventListener('focusout', (e) => { if (editing && e.target === editing) finishEdit(true); }, true);
  document.addEventListener('paste', (e) => {
    if (!editing) return;
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  }, true);

  // ---- commands from the editor -------------------------------------------------------------
  const byId = (id) => document.querySelector(`[${ID}="${CSS.escape(id)}"]`);
  window.addEventListener('message', (e) => {
    if (e.source !== parent || !e.data || !e.data.ili) return;
    const m = e.data;
    switch (m.cmd) {
      case 'mode':
        mode = m.mode; if (editing) finishEdit(true);
        document.documentElement.classList.toggle('__ili-edit', mode === 'edit');
        if (mode !== 'edit') { select(null, false); hoverBox.style.display = 'none'; }
        break;
      case 'select': { const el = byId(m.id); if (el) { select(el); if (m.scroll) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } break; }
      case 'deselect': select(null, false); break;
      case 'parent': if (selected) { const p = target(selected.parentElement); if (p) select(p); } break;
      case 'edit': startEdit(selected); break;
      case 'bold': case 'italic': if (editing) document.execCommand(m.cmd); break;
      case 'setAttr': {
        const el = byId(m.id); if (!el) break;
        if (m.value === null || m.value === '') el.removeAttribute(m.name); else el.setAttribute(m.name, m.value);
        if (m.name === 'src' && el.tagName === 'IMG') { el.removeAttribute('srcset'); el.closest('picture')?.querySelectorAll('source').forEach((s) => s.remove()); }
        if (el === selected) post({ type: 'select', info: describe(el) });
        break;
      }
      case 'scrollTo': window.scrollTo(0, m.y || 0); break;
    }
  });

  const page = decodeURIComponent(location.pathname.split('/').slice(4).join('/')) || 'index.html';
  post({ type: 'ready', page, title: document.title });
  loop();
  addEventListener('scroll', () => post({ type: 'scroll', y: scrollY }), { passive: true });
})();
