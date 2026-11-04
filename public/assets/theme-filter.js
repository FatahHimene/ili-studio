// Theme search + category filter, shared by the customer theme picker and the admin Themes page.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// lower case, no accents: "Électricien" matches "electricien"
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const haystack = (t) => norm([
  t.name, t.category, t.description, t.id,
  ...(t.templates || []).map((x) => x.name),
  ...(t.palettes || []).map((p) => p.name),
].join(' '));

/** Themes matching every word of the query, in the chosen category ('All' = any). */
export function filterThemes(themes, { q = '', cat = 'All' } = {}) {
  const words = norm(q).split(/\s+/).filter(Boolean);
  return themes.filter((t) => (cat === 'All' || t.category === cat) && words.every((w) => haystack(t).includes(w)));
}

/**
 * Wire a search box and category chips to a list of themes.
 * render(list, { q, cat }) is called with the filtered themes every time the filter changes.
 */
export function themeFilter({ input, cats, count, render }) {
  let themes = []; let q = ''; let cat = 'All';
  const draw = () => {
    const names = [...new Set(themes.map((t) => t.category))].sort((a, b) => a.localeCompare(b));
    if (cat !== 'All' && !names.includes(cat)) cat = 'All';
    const n = (c) => (c === 'All' ? themes.length : themes.filter((t) => t.category === c).length);
    // chips only help when there is more than one category
    cats.hidden = names.length < 2;
    cats.innerHTML = ['All', ...names].map((c) => `<button type="button" data-cat="${esc(c)}" aria-pressed="${c === cat}">${esc(c)} <span class="n">${n(c)}</span></button>`).join('');
    const list = filterThemes(themes, { q, cat });
    if (count) count.textContent = q || cat !== 'All' ? `${list.length} of ${themes.length} theme${themes.length > 1 ? 's' : ''}` : '';
    render(list, { q, cat });
  };
  input.addEventListener('input', () => { q = input.value; draw(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { e.stopPropagation(); input.value = ''; q = ''; draw(); } });
  cats.addEventListener('click', (e) => { const b = e.target.closest('button[data-cat]'); if (b) { cat = b.dataset.cat; draw(); } });
  return {
    set(list) { themes = list; draw(); },
    reset() { q = ''; cat = 'All'; input.value = ''; draw(); },
  };
}

/** Message for an empty result. */
export const noMatch = ({ q }) => `<p class="muted tnone">No theme matches${q ? ` “${esc(q)}”` : ''}. Try another word, or pick “All”.</p>`;
