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

/** Valid Gmail connector card ids. */
export const GMAIL_CARDS = ['gmail-personal', 'gmail-professional'] as const
export type GmailCardId = (typeof GMAIL_CARDS)[number]

export function isGmailCard(v: unknown): v is GmailCardId {
  return typeof v === 'string' && (GMAIL_CARDS as readonly string[]).includes(v)
}
