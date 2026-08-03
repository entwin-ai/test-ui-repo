import { NextResponse } from "next/server"
import { requireUser } from "@/lib/whatsapp/route-helpers"
import { status } from "@/lib/whatsapp/service"

export const dynamic = "force-dynamic"

/**
 * POST /api/whatsapp/ingest
 *
 * Nudge an immediate capture+vectorize run after the user reports they've
 * entered the pairing code, rather than waiting for the hourly cron. Same effect
 * as /sync; kept as a distinct endpoint the UI calls once post-pairing.
 */
export async function POST() {
  const auth = await requireUser()
  if ("error" in auth) return auth.error
  if (process.env.GH_REPO && process.env.GH_DISPATCH_TOKEN) {
    fetch(
      `https://api.github.com/repos/${process.env.GH_REPO}/actions/workflows/whatsapp-sync.yml/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.GH_DISPATCH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ ref: "main", inputs: { user_email: auth.email } }),
      },
    ).catch(() => {})
  }
  return NextResponse.json({ status: "sync queued", ...(await status(auth.email)) }, { status: 202 })
}
