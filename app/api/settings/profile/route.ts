import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { getProfile, saveProfile, sanitizeName } from '@/lib/twin/profile'

export const dynamic = 'force-dynamic'

/**
 * GET /api/settings/profile
 * Returns the user's saved Entwin name (or null if never set).
 */
export async function GET() {
  const auth = await requireUser()
  if ('error' in auth) return auth.error
  try {
    const profile = await getProfile(auth.email)
    return NextResponse.json({ entwinName: profile?.entwinName ?? null })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

/**
 * POST /api/settings/profile  { entwinName }
 * Saves the Entwin name. Naming is REQUIRED: an empty/whitespace name is
 * rejected server-side (the UI also disables Save until a name is entered), so
 * the name can never be blanked once the app relies on it.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const { entwinName } = await req.json().catch(() => ({}))
  const clean = sanitizeName(entwinName)
  if (!clean) {
    return NextResponse.json({ error: 'Please name your Entwin before saving.' }, { status: 400 })
  }
  try {
    const profile = await saveProfile(auth.email, clean)
    return NextResponse.json({ ok: true, entwinName: profile.entwinName })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
