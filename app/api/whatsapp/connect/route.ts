import { NextRequest, NextResponse } from "next/server"
import { requireUser } from "@/lib/whatsapp/route-helpers"
import { connect } from "@/lib/whatsapp/service"

export const dynamic = "force-dynamic"

/**
 * POST /api/whatsapp/connect  { phone }
 *
 * Starts one-time device pairing. No socket is opened in this request — the app
 * dispatches the `whatsapp-pair` GitHub Actions workflow (or, in local dev,
 * returns instructions to run `npm run pair`). The response tells the UI where
 * to find the pairing code. Works on ANY host, serverless included, because the
 * live-socket work happens in Actions, not here.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ("error" in auth) return auth.error
  const { phone } = await req.json().catch(() => ({}))
  if (!phone || typeof phone !== "string") {
    return NextResponse.json({ error: "phone is required" }, { status: 400 })
  }
  try {
    const result = await connect(auth.email, phone)
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
