import { NextResponse } from "next/server"
import { requireUser } from "@/lib/whatsapp/route-helpers"
import { syncNow, status } from "@/lib/whatsapp/service"

export const dynamic = "force-dynamic"

export async function POST() {
  const auth = await requireUser()
  if ("error" in auth) return auth.error
  try {
    const result = syncNow(auth.email)
    return NextResponse.json({ ...result, ...status(auth.email) })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
