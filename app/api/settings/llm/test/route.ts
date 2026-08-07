import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import type { LlmProvider } from '@/lib/rag/llm-keys'
import { validateKey, validateSelfHosted } from '@/lib/rag/validate-key'

export const dynamic = 'force-dynamic'
export const maxDuration = 15

const HOSTED: LlmProvider[] = ['claude', 'openai', 'gemini']
const SELF_HOSTED = new Set(['neocloud', 'onprem'])

/**
 * POST /api/settings/llm/test  { provider, apiKey?, endpoint? }
 *
 * Tier-0 validation. Runs a real, lightweight authenticated probe against the
 * provider and reports whether the key/endpoint actually works — WITHOUT saving
 * anything. This is what makes the Settings "Test" button meaningful: it catches
 * a valid-looking-but-dead key (expired, revoked, wrong scope, wrong provider)
 * before the user commits to it and before ingestion/chat fail opaquely.
 *
 * The key is used only for the probe and is never persisted or echoed back.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const { provider, apiKey, endpoint } = await req.json().catch(() => ({}))

  if (typeof provider !== 'string') {
    return NextResponse.json({ ok: false, reason: 'Provider required.' }, { status: 400 })
  }

  // Self-hosted (OpenAI-compatible) endpoints.
  if (SELF_HOSTED.has(provider)) {
    const result = await validateSelfHosted(String(endpoint || ''), apiKey ? String(apiKey) : undefined)
    return NextResponse.json(result)
  }

  if (!HOSTED.includes(provider as LlmProvider)) {
    return NextResponse.json({ ok: false, reason: `Unsupported provider: ${provider}` }, { status: 400 })
  }
  if (!apiKey || typeof apiKey !== 'string') {
    return NextResponse.json({ ok: false, reason: 'Enter an API key to test.' }, { status: 400 })
  }

  const result = await validateKey(provider as LlmProvider, apiKey)
  return NextResponse.json(result)
}
