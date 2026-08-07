import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { splitAliases } from '@/lib/entities/operations'

export const dynamic = 'force-dynamic'

/**
 * POST /api/entities/split  { fromId, aliases: string[], newName? }
 * Splits the given aliases out of fromId into a NEW entity (v5 §4). The original
 * is not retired; only the new entity gets split_from lineage. No Memory Note is
 * rewritten.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const { fromId, aliases, newName } = (await req.json().catch(() => ({}))) as {
    fromId?: string
    aliases?: string[]
    newName?: string
  }
  if (!fromId || !Array.isArray(aliases) || aliases.length === 0) {
    return NextResponse.json({ error: 'fromId and a non-empty aliases[] are required' }, { status: 400 })
  }

  const result = await splitAliases(auth.email, fromId, aliases, newName)
  return NextResponse.json(result, { status: result.ok ? 200 : 400 })
}
