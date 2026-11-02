// Wren: AI provider layer. Works with Gemini (free tier for testing) or Claude.
//   AI_PROVIDER=gemini     GEMINI_API_KEY=...     GEMINI_MODEL=gemini-flash-latest (optional)
//   AI_PROVIDER=anthropic  ANTHROPIC_API_KEY=...  ANTHROPIC_MODEL=claude-haiku-5-5 (optional)
//   AI_PROVIDER=mock       (for automated tests, no network)

const PROVIDER = (process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY ? 'gemini' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : '')).toLowerCase();

export function aiStatus() {
  const ok = PROVIDER === 'mock' || (PROVIDER === 'gemini' && !!process.env.GEMINI_API_KEY) || (PROVIDER === 'anthropic' && !!process.env.ANTHROPIC_API_KEY);
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

const clean = (s) => String(s || '').trim().replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/, '').trim();

async function callGemini(user) {
  const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0.6, maxOutputTokens: 8192 },
    }),
    signal: AbortSignal.timeout(60000),
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 429) throw new AiError('Wren is busy (free AI limit reached). Wait a minute and try again.');
  if (!r.ok) throw new AiError(`AI error (${r.status}): ${d.error?.message || 'unknown'}`);
  const text = (d.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  if (!text) throw new AiError('Wren could not answer this one. Try rephrasing.');
  return { text, usage: { input: d.usageMetadata?.promptTokenCount || 0, output: d.usageMetadata?.candidatesTokenCount || 0 } };
}

async function callAnthropic(user) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 4096, system: SYSTEM, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(60000),
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 429) throw new AiError('Wren is busy. Wait a minute and try again.');
  if (!r.ok) throw new AiError(`AI error (${r.status}): ${d.error?.message || 'unknown'}`);
  const text = (d.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  return { text, usage: { input: d.usage?.input_tokens || 0, output: d.usage?.output_tokens || 0 } };
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
  const out = PROVIDER === 'gemini' ? await callGemini(user) : PROVIDER === 'anthropic' ? await callAnthropic(user) : callMock(user, { mode, html });
  return { html: clean(out.text), usage: out.usage };
}
