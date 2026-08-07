import type { LlmProvider } from './llm-keys'

/**
 * Tier-0 LLM key validation.
 *
 * Two layers, cheapest first:
 *
 *   1. prefixCheck(provider, apiKey) — a pure, offline shape check. Catches the
 *      single most common mistake (pasting a Claude key into a Gemini setup, or
 *      vice-versa) instantly, with no network call. Cheap enough to run on every
 *      keystroke-blur or Save.
 *
 *   2. validateKey(provider, apiKey, model?) — a real, lightweight authenticated
 *      call to the provider. This is the only thing that can catch a key with
 *      the right prefix but which is expired, revoked, or lacks scope. It is
 *      deliberately the smallest possible request per provider (a models list or
 *      a 1-token generation) so it costs ~nothing and returns fast.
 *
 * Both are provider-aware. `validateKey` NEVER persists anything and NEVER
 * echoes the key back — it only reports pass/fail plus a short reason.
 *
 * The hosted providers (claude / openai / gemini) hit their public endpoints.
 * Self-hosted providers (neocloud / onprem) are OpenAI-compatible and validated
 * against the caller-supplied endpoint; see validateSelfHosted below.
 */

// ---- Layer 1: offline prefix / shape check ---------------------------------

/**
 * Expected key prefixes per hosted provider. Gemini is intentionally excluded:
 * Google API keys have no reliable, stable prefix to validate against, so a
 * prefix check there produces false rejections. Gemini keys are validated only
 * by the real authenticated probe (Layer 2).
 */
const PREFIX: Partial<Record<LlmProvider, RegExp>> = {
  claude: /^sk-ant-/,
  openai: /^sk-/, // note: sk-ant- also starts with sk-, so check claude first
}

export interface PrefixResult {
  ok: boolean
  /** A short, user-facing reason when ok === false. */
  reason?: string
}

/**
 * Offline shape check for a hosted-provider key. Returns ok:false with a
 * human-readable reason when the key clearly belongs to a different provider or
 * is obviously malformed. Never makes a network call.
 */
export function prefixCheck(provider: LlmProvider, apiKey: string): PrefixResult {
  const key = (apiKey || '').trim()
  if (!key) return { ok: false, reason: 'No API key entered.' }
  if (key.length < 8) return { ok: false, reason: 'Key looks too short.' }

  // Disambiguate the sk- overlap: an Anthropic key (sk-ant-…) must not be
  // accepted as an OpenAI key, and an OpenAI key (sk-…, not sk-ant-) must not be
  // accepted as a Claude key. Providers without a reliable prefix (Gemini) have
  // no entry in PREFIX and are left to the real authenticated probe.
  if (provider === 'claude' && !PREFIX.claude!.test(key)) {
    return { ok: false, reason: 'A Claude key should start with "sk-ant-".' }
  }
  if (provider === 'openai') {
    if (!PREFIX.openai!.test(key)) {
      return { ok: false, reason: 'An OpenAI key should start with "sk-".' }
    }
    if (PREFIX.claude!.test(key)) {
      return { ok: false, reason: 'That looks like a Claude key (sk-ant-…), not an OpenAI key.' }
    }
  }
  return { ok: true }
}

// ---- Layer 2: real authenticated probe -------------------------------------

export interface ValidateResult {
  ok: boolean
  /** Short user-facing status ("Key verified", or why it failed). */
  reason: string
  /** True only when the probe made a real network call and it succeeded. */
  live: boolean
  /**
   * Embedding readiness. Claude chat keys cannot embed on their own (embeddings
   * go through Voyage), so a Claude key can be chat-valid yet not
   * ingestion-ready until VOYAGE_API_KEY is set server-side. We surface that
   * distinction rather than letting ingestion fail opaquely later.
   */
  embeddingsReady?: boolean
  embeddingsNote?: string
}

const PROBE_TIMEOUT_MS = 8000

async function withTimeout(input: RequestInfo, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  try {
    return await fetch(input, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

/** Human message for the common auth statuses, shared across providers. */
function statusReason(status: number, provider: string): string {
  if (status === 401 || status === 403) return `${provider} rejected the key (unauthorized). It may be invalid, expired, or lack the right scope.`
  if (status === 429) return `${provider} rate-limited the check, but the key authenticated. Treating it as valid.`
  if (status >= 500) return `${provider} had a server error during the check. The key may still be fine — try again shortly.`
  return `${provider} returned an unexpected status (${status}).`
}

async function validateClaude(apiKey: string): Promise<ValidateResult> {
  // Smallest possible authenticated Anthropic call: a 1-token message. A 401/403
  // means a bad key; a 400 (e.g. model quibble) still proves the key authed.
  const res = await withTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  })
  const voyage = Boolean(process.env.VOYAGE_API_KEY) || apiKey.startsWith('pa-')
  const embeddingsReady = voyage
  const embeddingsNote = voyage
    ? undefined
    : 'Chat is ready. Embeddings for ingestion need a Voyage key (set VOYAGE_API_KEY on the server); Anthropic keys do not embed on their own.'
  if (res.ok || res.status === 429 || res.status === 400) {
    return { ok: true, reason: 'Key verified with Anthropic.', live: true, embeddingsReady, embeddingsNote }
  }
  return { ok: false, reason: statusReason(res.status, 'Anthropic'), live: true }
}

async function validateOpenAI(apiKey: string): Promise<ValidateResult> {
  // GET /models is the canonical lightweight auth check for OpenAI.
  const res = await withTimeout('https://api.openai.com/v1/models', {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (res.ok) return { ok: true, reason: 'Key verified with OpenAI.', live: true, embeddingsReady: true }
  if (res.status === 429) return { ok: true, reason: statusReason(429, 'OpenAI'), live: true, embeddingsReady: true }
  return { ok: false, reason: statusReason(res.status, 'OpenAI'), live: true }
}

async function validateGemini(apiKey: string): Promise<ValidateResult> {
  // Listing models with the key as a query param is the lightest Gemini probe.
  const res = await withTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
    { method: 'GET' },
  )
  if (res.ok) return { ok: true, reason: 'Key verified with Gemini.', live: true, embeddingsReady: true }
  if (res.status === 429) return { ok: true, reason: statusReason(429, 'Gemini'), live: true, embeddingsReady: true }
  return { ok: false, reason: statusReason(res.status, 'Gemini'), live: true }
}

/**
 * Validate a self-hosted, OpenAI-compatible endpoint (neocloud / onprem). We
 * probe GET {endpoint}/models with the (optional) key. Endpoints are frequently
 * unauthenticated on-prem, so a 200 OR a reachable-but-401 both tell us the host
 * exists; we only hard-fail on an unreachable host or a clear auth rejection
 * when a key was supplied.
 */
export async function validateSelfHosted(endpoint: string, apiKey?: string): Promise<ValidateResult> {
  const base = (endpoint || '').trim().replace(/\/+$/, '')
  if (!base) return { ok: false, reason: 'Enter the endpoint URL for the self-hosted model.', live: false }
  if (!/^https?:\/\//.test(base)) {
    return { ok: false, reason: 'Endpoint must start with http:// or https://', live: false }
  }
  const url = `${base}/models`
  try {
    const headers: Record<string, string> = {}
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    const res = await withTimeout(url, { method: 'GET', headers })
    if (res.ok) return { ok: true, reason: 'Reached the self-hosted endpoint.', live: true, embeddingsReady: true }
    if (res.status === 401 || res.status === 403) {
      return apiKey
        ? { ok: false, reason: statusReason(res.status, 'The endpoint'), live: true }
        : { ok: true, reason: 'Endpoint reachable (it requires no key, or a key is optional).', live: true, embeddingsReady: true }
    }
    if (res.status === 404) {
      // Host is up but not OpenAI-compatible at /models — still reachable.
      return { ok: true, reason: 'Endpoint reachable, but it did not expose /models. Confirm it is OpenAI-compatible.', live: true, embeddingsReady: true }
    }
    return { ok: false, reason: statusReason(res.status, 'The endpoint'), live: true }
  } catch (e) {
    return { ok: false, reason: `Could not reach the endpoint: ${(e as Error).message}`, live: false }
  }
}

/**
 * Full validation for a HOSTED provider: offline prefix check first (fail fast,
 * no network), then a real authenticated probe. Returns the first failure, or a
 * success carrying embedding-readiness detail.
 */
export async function validateKey(provider: LlmProvider, apiKey: string): Promise<ValidateResult> {
  const shape = prefixCheck(provider, apiKey)
  if (!shape.ok) return { ok: false, reason: shape.reason || 'Key failed the format check.', live: false }
  try {
    if (provider === 'claude') return await validateClaude(apiKey.trim())
    if (provider === 'openai') return await validateOpenAI(apiKey.trim())
    if (provider === 'gemini') return await validateGemini(apiKey.trim())
    return { ok: false, reason: `Unsupported provider: ${provider}`, live: false }
  } catch (e) {
    // Network/timeout — we can't confirm the key, but the shape check passed.
    return { ok: false, reason: `Could not reach ${provider} to verify the key: ${(e as Error).message}`, live: false }
  }
}
