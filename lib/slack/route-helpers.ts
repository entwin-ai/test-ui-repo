import { getServerSession } from 'next-auth'
import { NextResponse } from 'next/server'
import { authOptions } from '@/lib/auth'

/** Returns the signed-in user's email, or a 401 response. */
export async function requireUser(): Promise<{ email: string } | { error: NextResponse }> {
  const session = await getServerSession(authOptions)
  const email = session?.user?.email
  if (!email) {
    return { error: NextResponse.json({ error: 'Not signed in' }, { status: 401 }) }
  }
  return { email }
}

/**
 * Stable id for the single Slack connector card. Modelled on the Gmail card ids
 * so the same per-(user, card) session/token store shape can be reused.
 */
export const SLACK_CARDS = ['slack-workspace'] as const
export type SlackCardId = (typeof SLACK_CARDS)[number]

export function isSlackCard(v: unknown): v is SlackCardId {
  return typeof v === 'string' && (SLACK_CARDS as readonly string[]).includes(v)
}
