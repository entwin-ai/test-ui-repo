import { NextResponse } from "next/server"
import { requireUser } from "@/lib/whatsapp/route-helpers"
import { disconnect, status } from "@/lib/whatsapp/service"

export const dynamic = "force-dynamic"

export async function POST() {
  const auth = await requireUser()
  if ("error" in auth) return auth.error
  await disconnect(auth.email)
  return NextResponse.json(status(auth.email))
}
