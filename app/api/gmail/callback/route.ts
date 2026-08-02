import { NextRequest, NextResponse } from 'next/server'
import { handleCallback } from '@/lib/gmail/service'

export const dynamic = 'force-dynamic'

/**
 * GET /api/gmail/callback?code=...&state=...
 * Google redirects here after consent. We exchange the code for tokens, attach
 * them to the right connector card, then bounce the browser back to the app
 * with a hint so the UI can auto-start the scan.
 */
export async function GET(req: NextRequest) {
  const base = process.env.NEXTAUTH_URL || req.nextUrl.origin
  const code = req.nextUrl.searchParams.get('code')
  const state = req.nextUrl.searchParams.get('state')
  const error = req.nextUrl.searchParams.get('error')

  if (error) {
    return NextResponse.redirect(`${base}/?gmail=denied`)
  }
  if (!code || !state) {
    return NextResponse.redirect(`${base}/?gmail=error`)
  }

  try {
    const { cardId } = await handleCallback(code, state)
    // ?gmail=connected&card=... tells the client to open Connectors and scan.
    return NextResponse.redirect(`${base}/?gmail=connected&card=${cardId}`)
  } catch (e) {
    // Surface a short reason so the failure isn't silent. Without this, a real
    // backend error (bad state, token exchange failure, missing env var) looks
    // identical to "nothing happened" on the client.
    const reason = encodeURIComponent((e as Error).message || 'callback failed')
    return NextResponse.redirect(`${base}/?gmail=error&reason=${reason}`)
  }
}
