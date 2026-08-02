import { NextRequest, NextResponse } from "next/server"
import { requireUser } from "@/lib/whatsapp/route-helpers"
import { recentMessages } from "@/lib/whatsapp/service"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const auth = await requireUser()
  if ("error" in auth) return auth.error
  const limit = Number(req.nextUrl.searchParams.get("limit") || 20)
  return NextResponse.json({ messages: recentMessages(auth.email, Math.min(limit, 100)) })
}
