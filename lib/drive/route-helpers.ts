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
 * Valid Drive-backed connector card ids. Two families share the same OAuth +
 * folder-browser flow:
 *   • chorale-recorder            — WRITE flow (Chorale saves recordings)
 *   • drive-personal/-professional — READ/INGEST flow (Read Me: turn Drive
 *                                    files into Memory Notes)
 * They differ only in the OAuth scope requested and what happens after folder
 * selection; the authorize/callback/folders routes are generic across both.
 */
export const DRIVE_CARDS = ['chorale-recorder', 'drive-personal', 'drive-professional'] as const
export type DriveCardId = (typeof DRIVE_CARDS)[number]

export function isDriveCard(v: unknown): v is DriveCardId {
  return typeof v === 'string' && (DRIVE_CARDS as readonly string[]).includes(v)
}

/** The cards whose Connect runs the READ/INGEST pipeline (not Chorale's write). */
export const DRIVE_INGEST_CARDS = ['drive-personal', 'drive-professional'] as const
export type DriveIngestCardId = (typeof DRIVE_INGEST_CARDS)[number]

export function isDriveIngestCard(v: unknown): v is DriveIngestCardId {
  return typeof v === 'string' && (DRIVE_INGEST_CARDS as readonly string[]).includes(v)
}
