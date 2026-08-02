import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'

export const dynamic = 'force-dynamic'

/**
 * POST /api/graph/rebuild
 * Dispatches the entity-backfill GitHub Action for the signed-in user, which
 * rebuilds the entity/graph layer from their existing memory_notes (no email
 * re-parse). user_email comes from the session — never from the request body.
 */
export async function POST() {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const gh = await fetch(
    `https://api.github.com/repos/${process.env.GH_REPO}/actions/workflows/entity-backfill.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GH_DISPATCH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: { user_email: auth.email },
      }),
    },
  )
  if (!gh.ok) {
    const detail = await gh.text().catch(() => '')
    return NextResponse.json({ error: 'dispatch failed', detail }, { status: 502 })
  }
  return NextResponse.json({ status: 'rebuild queued' }, { status: 202 })
}
