// LLM-agnostic provider layer. One interface, three adapters. The pipeline
// calls chatJSON()/embedBatch() and never touches a vendor SDK directly.
//
// Each provider must support BOTH chat and embeddings. All embeddings are
// normalized to 1536 dims (pad/truncate) to fit the vector(1536) column.
//
// Every network call goes through apiFetch, which turns 429/5xx into a
// RetryableError carrying Retry-After, and the bound methods are wrapped in
// withRetry — so rate limits back off and retry instead of failing. This is
// what makes the concurrency pool safe.

import { withRetry, RetryableError } from './retry.js';

const TARGET_DIM = 1536;

const CHAT_MODEL_ID = {
  claude: {
    'Claude Opus 4.8 (latest)': 'claude-opus-4-8',
    'Claude Sonnet 5 (latest)': 'claude-sonnet-5',
    'Claude Haiku 4.5 (latest)': 'claude-haiku-4-5-20251001',
  },
  openai: {
    'GPT-5.6 Sol (latest)': 'gpt-5.6-sol',
    'GPT-5.6 Terra (latest)': 'gpt-5.6-terra',
    'GPT-5.6 Luna (latest)': 'gpt-5.6-luna',
  },
  gemini: {
    'Gemini 3.1 Pro (latest)': 'gemini-3.1-pro',
    'Gemini 3.6 Flash (latest)': 'gemini-3.6-flash',
    'Gemini 3.5 Flash-Lite (latest)': 'gemini-3.5-flash-lite',
  },
};

const EMBED_MODEL_ID = {
  claude: process.env.CLAUDE_EMBED_MODEL || 'voyage-3',
  openai: process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small',
  gemini: process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001',
};

function resolveChatModel(provider, label) {
  return CHAT_MODEL_ID[provider]?.[label] || label;
}

function normalizeDim(vec) {
  if (vec.length === TARGET_DIM) return vec;
  if (vec.length > TARGET_DIM) return vec.slice(0, TARGET_DIM);
  return vec.concat(new Array(TARGET_DIM - vec.length).fill(0));
}

function stripJson(text) {
  return text.replace(/```json|```/g, '').trim();
}

// Shared fetch: on 429/5xx throw RetryableError (with Retry-After if present);
// other non-2xx throw a plain Error (fail fast). Returns parsed JSON on success.
async function apiFetch(label, url, init) {
  const res = await fetch(url, init);
  if (res.ok) return res.json();
  const body = await res.text().catch(() => '');
  if (res.status === 429 || (res.status >= 500 && res.status <= 504)) {
    const ra = res.headers.get('retry-after');
    let retryAfterMs;
    if (ra) {
      const secs = Number(ra);
      retryAfterMs = Number.isFinite(secs) ? secs * 1000 : undefined;
    }
    throw new RetryableError(`${label} ${res.status}: ${body.slice(0, 200)}`, res.status, retryAfterMs);
  }
  throw new Error(`${label} ${res.status}: ${body.slice(0, 200)}`);
}

// ---- CLAUDE (Anthropic; embeddings via Voyage) ------------------------------
const claude = {
  async chatJSON({ apiKey, model, system, user, maxTokens }) {
    const json = await apiFetch('anthropic', 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    });
    return {
      text: stripJson(json.content[0].text),
      usage: { input_tokens: json.usage?.input_tokens, output_tokens: json.usage?.output_tokens },
    };
  },
  async embedBatch({ apiKey, texts }) {
    // Voyage uses its own keys (prefix "pa-"); a Claude key (sk-ant-…) will 401.
    // Prefer a dedicated VOYAGE_API_KEY from the worker env.
    const voyageKey =
      process.env.VOYAGE_API_KEY ||
      (apiKey && apiKey.startsWith('pa-') ? apiKey : '');
    if (!voyageKey) {
      throw new Error(
        'Claude embeddings require a Voyage AI key. Set VOYAGE_API_KEY in the worker environment (voyageai.com). The Anthropic key is used for chat only.',
      );
    }
    const json = await apiFetch('voyage', 'https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${voyageKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL_ID.claude, input: texts }),
    });
    return json.data.map((d) => normalizeDim(d.embedding));
  },
};

// ---- OPENAI -----------------------------------------------------------------
const openai = {
  async chatJSON({ apiKey, model, system, user, maxTokens }) {
    const json = await apiFetch('openai', 'https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
    return {
      text: stripJson(json.choices[0].message.content),
      usage: { input_tokens: json.usage?.prompt_tokens, output_tokens: json.usage?.completion_tokens },
    };
  },
  async embedBatch({ apiKey, texts }) {
    const json = await apiFetch('openai-embed', 'https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL_ID.openai, input: texts }),
    });
    return json.data.sort((a, b) => a.index - b.index).map((d) => normalizeDim(d.embedding));
  },
};

// ---- GEMINI (Google Generative Language API) --------------------------------
const gemini = {
  async chatJSON({ apiKey, model, system, user, maxTokens }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const json = await apiFetch('gemini', url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: maxTokens, responseMimeType: 'application/json' },
      }),
    });
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return {
      text: stripJson(text),
      usage: { input_tokens: json.usageMetadata?.promptTokenCount, output_tokens: json.usageMetadata?.candidatesTokenCount },
    };
  },
  async embedBatch({ apiKey, texts }) {
    const model = EMBED_MODEL_ID.gemini;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${apiKey}`;
    const json = await apiFetch('gemini-embed', url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: texts.map((t) => ({ model: `models/${model}`, content: { parts: [{ text: t }] } })),
      }),
    });
    return (json.embeddings || []).map((e) => normalizeDim(e.values));
  },
};

const ADAPTERS = { claude, openai, gemini };

// Public factory: returns bound, retry-wrapped chat + batch-embed callables.
export function makeProvider(config) {
  const { provider, model, apiKey } = config;
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error(`unsupported provider: ${provider}`);
  const chatModel = resolveChatModel(provider, model);
  return {
    provider,
    model: chatModel,
    chatJSON: (args) =>
      withRetry(() => adapter.chatJSON({ apiKey, model: chatModel, ...args }), { label: `${provider}.chat` }),
    embedBatch: (texts) =>
      withRetry(() => adapter.embedBatch({ apiKey, texts }), { label: `${provider}.embed` }),
    embed: async (text) => {
      const [v] = await withRetry(() => adapter.embedBatch({ apiKey, texts: [text] }), {
        label: `${provider}.embed`,
      });
      return v;
    },
  };
}

export { TARGET_DIM };
