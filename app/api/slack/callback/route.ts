import { NextRequest, NextResponse } from 'next/server'
import { handleCallback } from '@/lib/slack/service'

export const dynamic = 'force-dynamic'

/**
 * GET /api/slack/callback?code=...&state=...
 * Slack redirects here after consent. We exchange the code for a user token,
 * attach it to the Slack card, then bounce back to the app with a hint so the
 * UI can auto-start the 1-month scan.
 */
export async function GET(req: NextRequest) {
  const base = process.env.NEXTAUTH_URL || req.nextUrl.origin
  const code = req.nextUrl.searchParams.get('code')
  const state = req.nextUrl.searchParams.get('state')
  const error = req.nextUrl.searchParams.get('error')

  if (error) {
    return NextResponse.redirect(`${base}/?slack=denied`)
  }
  if (!code || !state) {
    return NextResponse.redirect(`${base}/?slack=error`)
  }

  try {
    const { cardId } = await handleCallback(code, state)
    return NextResponse.redirect(`${base}/?slack=connected&card=${cardId}`)
  } catch (e) {
    const reason = encodeURIComponent((e as Error).message || 'callback failed')
    return NextResponse.redirect(`${base}/?slack=error&reason=${reason}`)
  }
}
