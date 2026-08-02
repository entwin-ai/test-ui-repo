import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/gmail/debug  —  TEMPORARY diagnostic. Delete before shipping.
 *
 * Dumps everything we need to tell apart the three suspects:
 *   1. token store not wired  (Redis env missing / unreachable)
 *   2. OAuth client id/secret mismatch or missing
 *   3. code not actually deployed  (buildMarker below)
 *
 * No secret VALUES are printed — only presence, length, and a short fingerprint
 * (first/last 4 chars) so you can eyeball a match against the console without
 * exposing the secret.
 */

// Bump this string whenever you deploy. If the response doesn't echo the value
// you just set, the deployment did NOT include your latest code — full stop.
const BUILD_MARKER = 'debug-v3-2026-07-28'

function fingerprint(v: string | undefined): string | null {
  if (!v) return null
  if (v.length <= 8) return `len=${v.length} (too short to fingerprint)`
  return `len=${v.length} ${v.slice(0, 4)}…${v.slice(-4)}`
}

async function redisRoundTrip(url?: string, token?: string) {
  if (!url || !token) return { attempted: false }
  try {
    const key = 'entwin:debug:ping'
    const val = `ok-${Date.now()}`
    const setRes = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SET', key, val, 'EX', 60]),
    })
    const getRes = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['GET', key]),
    })
    const getJson = (await getRes.json().catch(() => null)) as { result?: unknown } | null
    return {
      attempted: true,
      setStatus: setRes.status,
      getStatus: getRes.status,
      roundTripOk: getJson?.result === val,
    }
  } catch (e) {
    return { attempted: true, error: (e as Error).message }
  }
}

export async function GET() {
  const redisUrl =
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL ||
    process.env.REDIS_REST_URL ||
    process.env.STORAGE_REST_URL
  const redisToken =
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN ||
    process.env.REDIS_REST_TOKEN ||
    process.env.STORAGE_REST_TOKEN

  const redis = await redisRoundTrip(redisUrl, redisToken)

  return NextResponse.json({
    buildMarker: BUILD_MARKER,
    oauth: {
      clientIdFingerprint: fingerprint(process.env.GOOGLE_CLIENT_ID),
      clientSecretFingerprint: fingerprint(process.env.GOOGLE_CLIENT_SECRET),
      clientIdEndsWithGoogleusercontent:
        process.env.GOOGLE_CLIENT_ID?.endsWith('.apps.googleusercontent.com') ?? false,
      clientSecretStartsWithGocspx:
        process.env.GOOGLE_CLIENT_SECRET?.startsWith('GOCSPX-') ?? false,
    },
    store: {
      redisUrlPresent: Boolean(redisUrl),
      redisTokenPresent: Boolean(redisToken),
      redisUrlHost: redisUrl ? safeHost(redisUrl) : null,
      redis,
    },
    allRelatedEnvVarNames: Object.keys(process.env).filter((k) =>
      /redis|kv|upstash|storage|google|nextauth/i.test(k),
    ),
  })
}

function safeHost(u: string): string {
  try {
    return new URL(u).host
  } catch {
    return 'unparseable-url'
  }
}
