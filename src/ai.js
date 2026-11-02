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

const SYSTEM = `You are Wren, the AI assistant inside ili studio, a website editor for small UK businesses.
You edit ONE element of an existing web page at a time.
Rules:
- Write in British English (colour, organise, centre). Plain, warm, professional. No emoji unless the original uses them.
- Never invent facts: no made-up prices, phone numbers, addresses, awards, reviews or statistics. Keep the ones that are already there.
- Keep the existing HTML structure, tags and class names unless the instruction asks for a different layout.
- Never add <script>, <iframe>, inline event handlers (onclick…) or external stylesheets.
- Reply with the HTML only. No explanation, no Markdown code fences.`;

function prompt({ mode, html, instruction, context }) {
  const what = mode === 'text'
    ? 'Rewrite the INNER HTML of this text element. Return only the new inner HTML (text and inline tags such as <strong>, <em>, <a>, <br>).'
    : 'Rewrite this whole element. Return the complete new element (one root element, same tag unless asked otherwise).';
  return `${what}

Instruction from the site owner: ${instruction}

Page context (for tone and facts, do not copy it): ${context}

Element to edit:
${html}`;
}

const clean = (s) => String(s || '')
  .replace(/<think>[\s\S]*?<\/think>/gi, '') // reasoning models (e.g. DeepSeek) may include their thinking
  .trim().replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/, '').trim();

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

async function callAnthropic(user) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 4096, system: SYSTEM, messages: [{ role: 'user', content: user }] }),
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
async function callAzure(user, system = SYSTEM) {
  let base = String(process.env.AZURE_OPENAI_ENDPOINT || '').trim().replace(/\/+$/, '');
  if (!/\/openai\/v1$/.test(base)) base += '/openai/v1';
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const body = {
    model: deployment,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_completion_tokens: 6000,
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
        body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT),
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
  if (r.status === 400 && body.reasoning_effort && /reasoning/i.test(d.error?.message || '')) { azureNoEffort = true; return callAzure(user, system); }
  if (r.status === 401 || r.status === 403) throw new AiError('Azure refused the key. Check AZURE_OPENAI_API_KEY.');
  if (r.status === 404) throw new AiError(`Azure deployment "${deployment}" not found. Check AZURE_OPENAI_DEPLOYMENT (the deployment name, not the model name).`);
  if (r.status === 429) throw new AiError('Azure rate limit reached. Wait a minute and try again.');
  if (!r.ok) throw new AiError(`Azure error (${r.status}): ${d.error?.message || 'unknown'}`);
  const text = d.choices?.[0]?.message?.content || '';
  if (!text) { console.error('[wren] azure empty answer:', JSON.stringify(d).slice(0, 500)); throw new AiError('Wren could not answer this one. Try rephrasing.'); }
  return { text, usage: { input: d.usage?.prompt_tokens || 0, output: d.usage?.completion_tokens || 0 } };
}

function callMock(user, { mode, html }) {
  const m = html.match(/^<([a-z0-9]+)/i);
  const text = mode === 'text' ? 'Wren rewrote this text.' : html.replace(/>([^<]{3,})</, '>Wren rewrote this section.<').replace(/^<([a-z0-9]+)/i, `<${m ? m[1] : 'div'}`);
  return { text, usage: { input: user.length / 4, output: text.length / 4 } };
}

/** Ask Wren to rewrite an element. Returns { html, usage }. */
export async function wren({ mode, html, instruction, context }) {
  const st = aiStatus();
  if (!st.enabled) throw new AiError('Wren is not set up yet: add an AI key in the app settings.');
  const user = prompt({ mode, html, instruction, context });
  if (PROVIDER === 'mock' && process.env.AI_MOCK_DELAY_MS) await sleep(Number(process.env.AI_MOCK_DELAY_MS));
  const out = PROVIDER === 'gemini' ? await callGemini(user) : PROVIDER === 'anthropic' ? await callAnthropic(user)
    : PROVIDER === 'azure' ? await callAzure(user) : callMock(user, { mode, html });
  return { html: clean(out.text), usage: out.usage };
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
