// Wren: AI provider layer. Works with Gemini (free tier for testing) or Claude.
//   AI_PROVIDER=gemini     GEMINI_API_KEY=...     GEMINI_MODEL=gemini-flash-latest (optional)
//   AI_PROVIDER=anthropic  ANTHROPIC_API_KEY=...  ANTHROPIC_MODEL=claude-haiku-5-5 (optional)
//   AI_PROVIDER=azure      AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com  AZURE_OPENAI_API_KEY=...  AZURE_OPENAI_DEPLOYMENT=<deployment name>
//   AI_PROVIDER=mock       (for automated tests, no network)

const PROVIDER = (process.env.AI_PROVIDER || (process.env.AZURE_OPENAI_API_KEY ? 'azure' : process.env.GEMINI_API_KEY ? 'gemini' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : '')).toLowerCase();

export function aiStatus() {
  const ok = PROVIDER === 'mock' || (PROVIDER === 'gemini' && !!process.env.GEMINI_API_KEY) || (PROVIDER === 'anthropic' && !!process.env.ANTHROPIC_API_KEY)
    || (PROVIDER === 'azure' && !!process.env.AZURE_OPENAI_API_KEY && !!process.env.AZURE_OPENAI_ENDPOINT && !!process.env.AZURE_OPENAI_DEPLOYMENT);
  return { enabled: ok, provider: ok ? PROVIDER : null };
}

export class AiError extends Error {}

const SYSTEM = `You are Wren, the AI assistant inside ili studio, a website editor for small businesses.
You edit ONE selected element of an existing web page: its content, its look (CSS), or both.
Rules:
- Content you write in the page keeps the language of the page: French stays French, English stays English, whatever language the instruction is in. When writing English, use British English. Plain, warm, professional. No emoji unless the original uses them.
- Never invent facts: no made-up prices, phone numbers, addresses, awards, reviews or statistics.
- Keep the existing HTML structure, tags, class names and data-* attributes (e.g. data-astro-cid-…) on every element you keep, unless the instruction asks for a different layout. New elements should reuse the same data-* attributes as their siblings.
- Never add <script>, <iframe>, inline event handlers or external stylesheets. No JavaScript at all.
- For a redesign of a whole section (layout, 3D, animation, gradients…), you may include ONE <style> element inside the new element.
  Scope every rule to a new class you put on the root element (e.g. .wren-hero-3d …), use only CSS (transforms, perspective, @keyframes,
  gradients, grid/flex) and make it responsive. Respect prefers-reduced-motion for animations.
- Change ONLY what the instruction asks. Do not change colours, backgrounds or spacing unless asked.
- A request about colours, size, spacing, corners, alignment or weight on the selected element: use <wren-style> only.
- A request about layout or content (columns, grid, order, adding or removing items, a call to action, 3D, animation, redesign):
  you MUST return <wren-html> with the full new element. <wren-style> alone cannot change a layout.
- Never claim in the note a change you did not actually make.
- Answer ONLY with these tagged blocks, each one optional, nothing before or after them:
  <wren-note>one short sentence for the site owner saying what you changed (or why nothing needed changing)</wren-note>
  <wren-style>{"css-property": "value"}</wren-style>
  <wren-html>the new HTML, written as normal HTML (no escaping)</wren-html>
  Use <wren-style> only if the look of the selected element changes. Allowed properties: color, background-color, font-size, font-weight,
    font-style, text-align, text-transform, letter-spacing, line-height, padding, margin-top, margin-bottom, border-radius, border,
    border-color, border-width, border-style, max-width, opacity. Values in CSS (e.g. "#1d4ed8", "18px", "999px").
  Use <wren-html> only if the content or layout changes (see the task for exactly what it must contain).
  Always include <wren-note>.`;

/** Rough language guess for the owner's instruction, so the note answers in their language. */
function instructionLanguage(text) {
  const t = ` ${String(text).toLowerCase()} `;
  const fr = (t.match(/[éèêàçùôîï]|\b(le|la|les|un|une|des|du|de|et|est|ce|cette|ces|mets|met|rends|fais|change|couleur|plus|bouton|titre|texte|avec|pour|en|au|aux)\b/g) || []).length;
  const en = (t.match(/\b(the|a|an|make|this|that|it|change|colour|color|more|button|title|text|with|for|to|and|please)\b/g) || []).length;
  return fr > en ? 'French' : 'English';
}

function prompt({ mode, html, instruction, context, style }) {
  const what = mode === 'text'
    ? 'If the content changes, <wren-html> holds the new INNER HTML of the element only (text and inline tags such as <strong>, <em>, <br>).'
    : 'If the content or layout changes, <wren-html> holds the complete new element (one root element, same tag unless asked otherwise).';
  return `${what}
Write the <wren-note> in ${instructionLanguage(instruction)}. Content inside the page keeps the page's own language.

Instruction from the site owner: ${instruction}

Current look of the element: ${style || 'unknown'}

Page context (for tone, language and facts, do not copy it): ${context}

Element:
${html}`;
}

const clean = (s) => String(s || '')
  .replace(/<think>[\s\S]*?<\/think>/gi, '') // reasoning models (e.g. DeepSeek) may include their thinking
  .trim().replace(/^```(?:json|html)?\s*/i, '').replace(/```\s*$/, '').trim();

/** Read Wren's tagged answer (falls back to JSON, then to plain HTML for models that ignore the format). */
function parseAnswer(text) {
  const t = clean(text);
  const tag = (name, greedy) => { const m = t.match(new RegExp(`<${name}>([\\s\\S]${greedy ? '*' : '*?'})</${name}>`, 'i')); return m ? m[1].trim() : null; };
  const note = tag('wren-note'); const styleRaw = tag('wren-style'); const html = tag('wren-html', true);
  if (note !== null || styleRaw !== null || html !== null) {
    if (html === null && /<wren-html>/i.test(t)) throw new AiError('Wren\'s answer was cut. Select a smaller part, or ask for one change at a time.');
    let style = null;
    if (styleRaw) {
      try { style = JSON.parse(styleRaw.slice(styleRaw.indexOf('{'), styleRaw.lastIndexOf('}') + 1)); }
      catch { // accept "property: value;" lines too
        style = Object.fromEntries(styleRaw.split(/[;\n]/).map((l) => l.split(':')).filter((p) => p.length >= 2).map(([k, ...v]) => [k.trim().replace(/["{}]/g, ''), v.join(':').trim().replace(/["{},]/g, '')]).filter(([k, v]) => k && v));
      }
    }
    return { html: html || null, style: style && typeof style === 'object' ? style : null, note: (note || '').slice(0, 300) };
  }
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a === 0 && b > a) {
    try {
      const j = JSON.parse(t.slice(a, b + 1));
      return { html: typeof j.html === 'string' && j.html.trim() ? j.html.trim() : null, style: j.style && typeof j.style === 'object' ? j.style : null, note: typeof j.note === 'string' ? j.note.slice(0, 300) : '' };
    } catch { throw new AiError('Wren\'s answer was malformed. Try again.'); }
  }
  return { html: t || null, style: null, note: '' };
}

const TIMEOUT = Number(process.env.AI_TIMEOUT_MS || 90000);
// Turn "thinking" off for speed. Newer models use thinkingLevel, older ones thinkingBudget; try each, remember what works.
const THINKING = [{ thinkingLevel: 'minimal' }, { thinkingBudget: 0 }, null];
const thinkingIdx = new Map(); // model -> index in THINKING

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GEMINI_MODELS = [process.env.GEMINI_MODEL || 'gemini-flash-latest', process.env.GEMINI_FALLBACK_MODEL || 'gemini-flash-lite-latest'];

/** Gemini with automatic retries on overload (503/500) and a lighter fallback model. */
async function callGemini(user, system = SYSTEM) {
  let last;
  for (const [i, model] of GEMINI_MODELS.entries()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await callGeminiOnce(user, system, model); }
      catch (e) {
        last = e;
        if (!e.retryable) throw e;
        await sleep(1200 * (attempt + 1));
      }
    }
    if (i === 0) console.warn(`[wren] ${model} overloaded, trying ${GEMINI_MODELS[1]}`);
  }
  throw new AiError('The AI service is very busy right now. Please try again in a minute.', { cause: last });
}

async function callGeminiOnce(user, system, model) {
  const t0 = Date.now();
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { temperature: 0.6, maxOutputTokens: 8192 },
  };
  const ti = thinkingIdx.get(model) ?? 0;
  if (THINKING[ti]) body.generationConfig.thinkingConfig = THINKING[ti];
  let r;
  try {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY || '' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (e) {
    console.error(`[wren] gemini ${model} network error after ${Date.now() - t0}ms:`, e.name, e.message, e.cause?.code || '');
    throw new AiError(e.name === 'TimeoutError' ? 'Wren took too long to answer. Try again, or select a smaller part.' : 'Wren could not reach the AI service. Check the server can access the internet.');
  }
  const d = await r.json().catch(() => ({}));
  console.log(`[wren] gemini ${model} -> ${r.status} in ${Date.now() - t0}ms`);
  if (r.status === 400 && THINKING[ti] && /thinking/i.test(d.error?.message || '')) { thinkingIdx.set(model, ti + 1); return callGeminiOnce(user, system, model); }
  if (r.status === 503 || r.status === 500 || r.status === 529) { const e = new AiError('AI overloaded'); e.retryable = true; throw e; }
  if (!r.ok) console.error('[wren] gemini error:', JSON.stringify(d.error || d).slice(0, 500));
  if (r.status === 429) throw new AiError('Free AI limit reached for now. Wait a minute and try again.');
  if (r.status === 404) throw new AiError(`AI model "${model}" not found. Set GEMINI_MODEL to a model listed in Google AI Studio.`);
  if (r.status === 400 || r.status === 403) throw new AiError(`AI key or request refused (${r.status}): ${d.error?.message || 'check GEMINI_API_KEY'}`);
  if (!r.ok) throw new AiError(`AI error (${r.status}): ${d.error?.message || 'unknown'}`);
  const text = (d.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  if (!text) { console.error('[wren] empty answer:', JSON.stringify(d).slice(0, 500)); throw new AiError('Wren could not answer this one. Try rephrasing.'); }
  return { text, usage: { input: d.usageMetadata?.promptTokenCount || 0, output: d.usageMetadata?.candidatesTokenCount || 0 } };
}

async function callAnthropic(user, system = SYSTEM) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 8000, system, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(TIMEOUT),
  }).catch((e) => { console.error('[wren] anthropic network error:', e.name, e.message); throw new AiError(e.name === 'TimeoutError' ? 'Wren took too long to answer. Try again.' : 'Wren could not reach the AI service.'); });
  const d = await r.json().catch(() => ({}));
  console.log(`[wren] anthropic ${model} -> ${r.status}`);
  if (!r.ok) console.error('[wren] anthropic error:', JSON.stringify(d.error || d).slice(0, 500));
  if (r.status === 429) throw new AiError('Wren is busy. Wait a minute and try again.');
  if (!r.ok) throw new AiError(`AI error (${r.status}): ${d.error?.message || 'unknown'}`);
  const text = (d.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  return { text, usage: { input: d.usage?.input_tokens || 0, output: d.usage?.output_tokens || 0 } };
}

// ---- Azure OpenAI / Azure AI Foundry (OpenAI-compatible v1 API) ----------------------------
let azureNoEffort = false;
async function callAzure(user, system = SYSTEM, { design = false } = {}) {
  let base = String(process.env.AZURE_OPENAI_ENDPOINT || '').trim().replace(/\/+$/, '');
  if (!/\/openai\/v1$/.test(base)) base += '/openai/v1';
  const deployment = (design && process.env.AZURE_OPENAI_DESIGN_DEPLOYMENT) || process.env.AZURE_OPENAI_DEPLOYMENT;
  const body = {
    model: deployment,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_completion_tokens: design ? 24000 : 6000,
  };
  const effort = process.env.AZURE_OPENAI_REASONING_EFFORT; // e.g. "minimal" or "low" for reasoning models
  if (effort && !azureNoEffort) body.reasoning_effort = effort;
  const t0 = Date.now();
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      r = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': process.env.AZURE_OPENAI_API_KEY },
        body: JSON.stringify(body), signal: AbortSignal.timeout(design ? TIMEOUT * 2 : TIMEOUT),
      });
    } catch (e) {
      console.error(`[wren] azure network error after ${Date.now() - t0}ms:`, e.name, e.message, e.cause?.code || '');
      throw new AiError(e.name === 'TimeoutError' ? 'Wren took too long to answer. Try again, or select a smaller part.' : 'Wren could not reach Azure. Check AZURE_OPENAI_ENDPOINT.');
    }
    if (r.status !== 429 && r.status < 500) break;
    await sleep(1500 * (attempt + 1));
  }
  const d = await r.json().catch(() => ({}));
  console.log(`[wren] azure ${deployment} -> ${r.status} in ${Date.now() - t0}ms`);
  if (!r.ok) console.error('[wren] azure error:', JSON.stringify(d.error || d).slice(0, 500));
  if (r.status === 400 && body.reasoning_effort && /reasoning/i.test(d.error?.message || '')) { azureNoEffort = true; return callAzure(user, system, { design }); }
  if (r.status === 401 || r.status === 403) throw new AiError('Azure refused the key. Check AZURE_OPENAI_API_KEY.');
  if (r.status === 404) throw new AiError(`Azure deployment "${deployment}" not found. Check AZURE_OPENAI_DEPLOYMENT (the deployment name, not the model name).`);
  if (r.status === 429) throw new AiError('Azure rate limit reached. Wait a minute and try again.');
  if (!r.ok) throw new AiError(`Azure error (${r.status}): ${d.error?.message || 'unknown'}`);
  const text = d.choices?.[0]?.message?.content || '';
  if (d.choices?.[0]?.finish_reason === 'length') { console.warn('[wren] azure answer cut (length)'); throw new AiError('This part is too big for Wren to rewrite in one go. Select a smaller part, or ask for one change at a time.'); }
  if (!text) { console.error('[wren] azure empty answer:', JSON.stringify(d).slice(0, 500)); throw new AiError('Wren could not answer this one. Try rephrasing.'); }
  return { text, usage: { input: d.usage?.prompt_tokens || 0, output: d.usage?.completion_tokens || 0 } };
}

function callMock(user, { mode, html, instruction }) {
  let j;
  if (/colou?r|couleur/i.test(instruction)) j = { style: { 'background-color': '#C8F031', color: '#0D1221' }, note: 'Mock: colour changed.' };
  else if (/nothing|rien/i.test(instruction)) j = { note: 'Mock: nothing to change.' };
  else j = { html: mode === 'text' ? 'Wren rewrote this text.' : html.replace(/>([^<]{3,})</, '>Wren rewrote this section.<'), note: 'Mock: rewritten.' };
  const text = [j.note && `<wren-note>${j.note}</wren-note>`, j.style && `<wren-style>${JSON.stringify(j.style)}</wren-style>`, j.html && `<wren-html>${j.html}</wren-html>`].filter(Boolean).join('\n');
  return { text, usage: { input: user.length / 4, output: text.length / 4 } };
}

/** Ask Wren to edit an element. Returns { html, style, note, usage }. */
export async function wren({ mode, html, instruction, context, style }) {
  const st = aiStatus();
  if (!st.enabled) throw new AiError('Wren is not set up yet: add an AI key in the app settings.');
  const user = prompt({ mode, html, instruction, context, style });
  if (PROVIDER === 'mock' && process.env.AI_MOCK_DELAY_MS) await sleep(Number(process.env.AI_MOCK_DELAY_MS));
  const out = PROVIDER === 'gemini' ? await callGemini(user) : PROVIDER === 'anthropic' ? await callAnthropic(user)
    : PROVIDER === 'azure' ? await callAzure(user, SYSTEM, { design: mode === 'block' }) : callMock(user, { mode, html, instruction });
  return { ...parseAnswer(out.text), usage: out.usage };
}

/** Quick health check of the AI connection (used by /api/ai/ping). */
export async function ping() {
  const st = aiStatus();
  if (!st.enabled) return { ok: false, error: 'No AI key configured' };
  const t0 = Date.now();
  try {
    const out = PROVIDER === 'gemini' ? await callGemini('Reply with the single word: OK', 'You are a test.')
      : PROVIDER === 'anthropic' ? await callAnthropic('Reply with the single word: OK')
      : PROVIDER === 'azure' ? await callAzure('Reply with the single word: OK', 'You are a test.') : { text: 'OK' };
    const model = { gemini: process.env.GEMINI_MODEL || 'gemini-flash-latest', anthropic: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5', azure: process.env.AZURE_OPENAI_DEPLOYMENT, mock: 'mock' }[PROVIDER];
    return { ok: true, provider: st.provider, model, reply: out.text.trim().slice(0, 50), ms: Date.now() - t0 };
  } catch (e) { return { ok: false, provider: st.provider, error: e.message, ms: Date.now() - t0 }; }
}

/**
 * Ask the AI for a JSON object (used for theme personalisation and photo suggestions).
 * @param {{system: string, user: string, mock: () => object, maxTokens?: number}} q
 */
export async function askJson({ system, user, mock }) {
  const st = aiStatus();
  if (!st.enabled) throw new AiError('Wren is not set up yet: add an AI key in the app settings.');
  if (PROVIDER === 'mock') {
    if (process.env.AI_MOCK_DELAY_MS) await sleep(Number(process.env.AI_MOCK_DELAY_MS));
    return { data: mock(), usage: { input: user.length / 4, output: 200 } };
  }
  const sys = `${system}\nAnswer with ONE valid JSON object only, no Markdown, no explanation.`;
  const out = PROVIDER === 'gemini' ? await callGemini(user, sys) : PROVIDER === 'anthropic' ? await callAnthropic(user, sys) : await callAzure(user, sys);
  const t = clean(out.text);
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a === -1 || b <= a) throw new AiError('Wren\'s answer could not be read. Try again.');
  try { return { data: JSON.parse(t.slice(a, b + 1)), usage: out.usage }; }
  catch { console.error('[wren] bad JSON:', t.slice(0, 300)); throw new AiError('Wren\'s answer could not be read. Try again.'); }
}
