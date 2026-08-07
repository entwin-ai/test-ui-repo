# Tier 0 — LLM key validation & self-hosted providers

The taproot of the retrieval chain (`LLM key → ingestion → embeddings →
Chat/Dashboard`) is now real. Three gaps closed:

## 1. API-key validation (the "Test" button)

**New:** `lib/rag/validate-key.ts` — two layers, cheapest first:

- `prefixCheck(provider, apiKey)` — offline shape check. Catches the most common
  mistake (a Claude `sk-ant-…` key pasted into a Gemini/OpenAI setup, or vice
  versa) with **no network call**. Correctly disambiguates the `sk-` overlap
  between OpenAI and Anthropic.
- `validateKey(provider, apiKey)` — a real, lightweight authenticated probe:
  Anthropic → 1-token `/v1/messages`; OpenAI → `GET /v1/models`; Gemini →
  `GET /v1beta/models`. This is the only thing that catches a key that has the
  right prefix but is **expired, revoked, or lacks scope**. 8s timeout; a 429 is
  treated as "authenticated but rate-limited" (pass), never as a failure.
- For Claude it also reports **embedding readiness**: an Anthropic chat key can
  be valid while ingestion still can't embed until `VOYAGE_API_KEY` is set. The
  UI surfaces that as a note instead of letting ingestion fail opaquely later.

**New route:** `POST /api/settings/llm/test { provider, apiKey?, endpoint? }` —
validates **without saving**; the key is used only for the probe and never
persisted or echoed back.

**Save route hardened:** `POST /api/settings/llm` now runs the offline prefix
guard server-side, **always** (never skippable), so a wrong-provider key can't be
saved even if the client is bypassed. When the client has already run Test and
shown a green result it may pass `skipValidation:true` to avoid a duplicate probe
— but the prefix guard still runs.

**UI:** a Test button sits beside the key field with `idle → Testing… → ✓/✕`
states and an inline result. Any stale result is cleared the moment the key,
provider, or endpoint changes, so a green check never lingers next to an edited
key.

## 2. Self-hosted providers (neocloud / onprem) — no longer hard-blocked

Previously Save refused these with "not yet supported for ingestion." They are
now wired end-to-end as **OpenAI-compatible** backends:

- `lib/rag/llm-keys.ts` — `LlmConfig` gains an optional `endpoint`; new
  `AnyProvider`/`SelfHostedProvider` types and an `isSelfHosted()` guard. The
  endpoint is stored (encrypted, same as the key) and returned by the GET
  status (never the key).
- `lib/rag/provider.ts` (query path) and `worker/src/lib/provider.js` (ingestion
  path) both gain a self-hosted adapter that speaks `POST {endpoint}/chat/completions`
  and `POST {endpoint}/embeddings`. The bearer key is **optional** (on-prem hosts
  are often unauthenticated). Embedding model defaults to
  `text-embedding-3-small`, overridable via `SELF_HOSTED_EMBED_MODEL`.
- `validateSelfHosted(endpoint, apiKey?)` probes `GET {endpoint}/models`,
  tolerating unauthenticated hosts and non-`/models` deployments.
- **UI:** the endpoint field is now bound to state (it previously did nothing),
  has its own Test button, and an optional-key field. Save sends the endpoint.

## 3. Downstream unblocked

With a validated key and self-hosted support, the Tier-1 items that depended on
this (Chat header truthfulness, Dashboard "Notes indexed"/"Preferences learned",
the rolling ingestion window) are no longer blocked at the root — they can be
built against a provider that's known-good at save time.

## Files touched / added

- **added** `lib/rag/validate-key.ts`
- **added** `app/api/settings/llm/test/route.ts`
- **added** `TIER0_LLM_VALIDATION_README.md`
- `app/api/settings/llm/route.ts` — prefix guard, self-hosted, skipValidation
- `lib/rag/llm-keys.ts` — endpoint + self-hosted types
- `lib/rag/provider.ts` — self-hosted adapter (query path)
- `worker/src/lib/provider.js` — self-hosted adapter (ingestion path)
- `app/page.tsx` — Test button, endpoint field wiring, save changes
- `app/globals.css` — Test button + result styles
- `.env.local.example` — `SELF_HOSTED_EMBED_MODEL`

Verified with `tsc --noEmit` (clean), `next build` (compiled successfully, new
route registered), and `node --check` on the worker.
