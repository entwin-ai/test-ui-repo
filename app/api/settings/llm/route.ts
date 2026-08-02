import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { saveLlmConfig, hasLlmConfig, type LlmProvider } from '@/lib/rag/llm-keys'

export const dynamic = 'force-dynamic'

const VALID: LlmProvider[] = ['claude', 'openai', 'gemini']

/**
 * POST /api/settings/llm  { provider, model, apiKey }
 * Stores the user's LLM credentials encrypted in Redis. The key is write-only:
 * it is never returned by any endpoint after saving.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const { provider, model, apiKey } = await req.json().catch(() => ({}))
  if (!VALID.includes(provider)) {
    return NextResponse.json({ error: 'Unsupported provider' }, { status: 400 })
  }
  if (!model || typeof model !== 'string') {
    return NextResponse.json({ error: 'Model required' }, { status: 400 })
  }
  if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 8) {
    return NextResponse.json({ error: 'Valid API key required' }, { status: 400 })
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
 * Returns only whether a key is configured, plus the provider/model — NEVER the
 * key itself. Lets the UI show "configured" state on load.
 */
export async function GET() {
  const auth = await requireUser()
  if ('error' in auth) return auth.error
  return NextResponse.json(await hasLlmConfig(auth.email))
}
