import { NextResponse } from "next/server"
import { requireUser } from "@/lib/whatsapp/route-helpers"
import { status } from "@/lib/whatsapp/service"

export const dynamic = "force-dynamic"

export async function GET() {
  const auth = await requireUser()
  if ("error" in auth) return auth.error
  return NextResponse.json(await status(auth.email))
}
