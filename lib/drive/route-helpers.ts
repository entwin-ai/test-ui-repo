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
 * Valid Drive-backed connector card ids. Chorale is the only one today, but the
 * flow is written generically so other Drive-write cards can reuse it.
 */
export const DRIVE_CARDS = ['chorale-recorder'] as const
export type DriveCardId = (typeof DRIVE_CARDS)[number]

export function isDriveCard(v: unknown): v is DriveCardId {
  return typeof v === 'string' && (DRIVE_CARDS as readonly string[]).includes(v)
}
