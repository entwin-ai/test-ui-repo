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
