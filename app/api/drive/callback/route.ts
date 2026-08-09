import { NextRequest, NextResponse } from 'next/server'
import { handleCallback } from '@/lib/drive/service'

export const dynamic = 'force-dynamic'

/**
 * GET /api/drive/callback?code=...&state=...
 * Google redirects here after the Drive write-access consent. We exchange the
 * code for tokens, attach them to the Chorale card, then bounce the browser
 * back to the app with ?drive=connected&card=... so the UI opens the Drive
 * Explorer for folder selection.
 */
export async function GET(req: NextRequest) {
  const base = process.env.NEXTAUTH_URL || req.nextUrl.origin
  const code = req.nextUrl.searchParams.get('code')
  const state = req.nextUrl.searchParams.get('state')
  const error = req.nextUrl.searchParams.get('error')

  if (error) {
    return NextResponse.redirect(`${base}/?drive=denied`)
  }
  if (!code || !state) {
    return NextResponse.redirect(`${base}/?drive=error`)
  }

  try {
    const { cardId, pendingFolderUrl, pendingFolderSaved, pendingFolderError } =
      await handleCallback(code, state)
    // If the user came from the "Configure GDrive" URL modal, the folder was
    // already resolved + saved during the token exchange — tell the UI to just
    // hydrate the card (drive=saved) instead of opening the folder explorer.
    if (pendingFolderUrl) {
      if (pendingFolderSaved) {
        return NextResponse.redirect(`${base}/?drive=saved&card=${cardId}`)
      }
      // Consent succeeded but the folder didn't save — carry the real reason so
      // the card can show something actionable instead of a generic message.
      const reason = encodeURIComponent(pendingFolderError || 'Folder could not be saved.')
      return NextResponse.redirect(`${base}/?drive=savefailed&card=${cardId}&reason=${reason}`)
    }
    return NextResponse.redirect(`${base}/?drive=connected&card=${cardId}`)
  } catch (e) {
    const reason = encodeURIComponent((e as Error).message || 'callback failed')
    return NextResponse.redirect(`${base}/?drive=error&reason=${reason}`)
  }
}
