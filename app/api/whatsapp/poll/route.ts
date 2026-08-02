import { NextRequest, NextResponse } from "next/server"
import { requireUser } from "@/lib/whatsapp/route-helpers"
import { setPolling, status } from "@/lib/whatsapp/service"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ("error" in auth) return auth.error
  const { enabled } = await req.json().catch(() => ({}))
  setPolling(auth.email, !!enabled)
  return NextResponse.json(status(auth.email))
}
