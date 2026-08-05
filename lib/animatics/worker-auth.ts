import { NextRequest, NextResponse } from 'next/server'

/**
 * The Colab worker is not a logged-in user, so it authenticates with a shared
 * secret sent in the `x-animatics-worker-token` header (or `?token=`). Set
 * ANIMATICS_WORKER_TOKEN in the environment and put the same value in the
 * Colab notebook. Kept separate from user auth so worker endpoints never touch
 * the session.
 */
export function checkWorker(req: NextRequest): NextResponse | null {
  const expected = process.env.ANIMATICS_WORKER_TOKEN
  if (!expected) {
    return NextResponse.json(
      { error: 'Render worker is not configured (ANIMATICS_WORKER_TOKEN unset).' },
      { status: 503 },
    )
  }
  const got =
    req.headers.get('x-animatics-worker-token') ||
    req.nextUrl.searchParams.get('token') ||
    ''
  if (got !== expected) {
    return NextResponse.json({ error: 'Unauthorized worker.' }, { status: 401 })
  }
  return null
}
