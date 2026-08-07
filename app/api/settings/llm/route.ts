import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { saveLlmConfig, hasLlmConfig, isSelfHosted, type AnyProvider, type LlmProvider } from '@/lib/rag/llm-keys'
import { prefixCheck, validateSelfHosted } from '@/lib/rag/validate-key'

export const dynamic = 'force-dynamic'
export const maxDuration = 15

const HOSTED: LlmProvider[] = ['claude', 'openai', 'gemini']

/**
 * POST /api/settings/llm  { provider, model, apiKey, endpoint?, skipValidation? }
 *
 * Stores the user's LLM credentials encrypted in Redis. The key is write-only:
 * it is never returned by any endpoint after saving.
 *
 * Tier-0: before persisting we run a server-side prefix check (catches a
 * wrong-provider key with no network call) so a Claude key can never be saved
 * under a Gemini setup, even if the client is bypassed. Self-hosted providers
 * are validated by reaching their endpoint. The client can pass
 * skipValidation:true when it has ALREADY run the full Test probe and shown the
 * user a green result -- no reason to probe twice -- but the offline prefix
 * guard always runs regardless.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const { provider, model, apiKey, endpoint, skipValidation } = await req.json().catch(() => ({}))

  const allProviders: AnyProvider[] = [...HOSTED, 'neocloud', 'onprem']
  if (!allProviders.includes(provider)) {
    return NextResponse.json({ error: 'Unsupported provider' }, { status: 400 })
  }
  if (!model || typeof model !== 'string') {
    return NextResponse.json({ error: 'Model required' }, { status: 400 })
  }

  // --- Self-hosted (neocloud / onprem) ---
  if (isSelfHosted(provider)) {
    if (!endpoint || typeof endpoint !== 'string') {
      return NextResponse.json({ error: 'Endpoint URL required for a self-hosted provider.' }, { status: 400 })
    }
    if (!skipValidation) {
      const probe = await validateSelfHosted(endpoint, apiKey)
      if (!probe.ok) return NextResponse.json({ error: probe.reason }, { status: 400 })
    }
    try {
      await saveLlmConfig(auth.email, { provider, model, apiKey: typeof apiKey === 'string' ? apiKey : '', endpoint })
      return NextResponse.json({ ok: true })
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 })
    }
  }

  // --- Hosted (claude / openai / gemini) ---
  if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 8) {
    return NextResponse.json({ error: 'Valid API key required' }, { status: 400 })
  }
  // Offline prefix guard -- always enforced server-side, never skippable.
  const shape = prefixCheck(provider as LlmProvider, apiKey)
  if (!shape.ok) {
    return NextResponse.json({ error: shape.reason }, { status: 400 })
  }

  try {
    await saveLlmConfig(auth.email, { provider, model, apiKey })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

/**
 * GET /api/settings/llm
 * Returns only whether a key is configured, plus the provider/model/endpoint --
 * NEVER the key itself. Lets the UI show "configured" state on load.
 */
export async function GET() {
  const auth = await requireUser()
  if ('error' in auth) return auth.error
  return NextResponse.json(await hasLlmConfig(auth.email))
}
