import { NextRequest, NextResponse } from "next/server"
import { requireUser } from "@/lib/whatsapp/route-helpers"
import { getSupabaseAdmin } from "@/lib/rag/supabase"

export const dynamic = "force-dynamic"

/** GET /api/whatsapp/messages?limit=20 — recent captured messages for preview. */
export async function GET(req: NextRequest) {
  const auth = await requireUser()
  if ("error" in auth) return auth.error
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") || 20), 100)
  const { data, error } = await getSupabaseAdmin()
    .from("whatsapp_message")
    .select("wa_msg_id, chat_id, chat_name, sender_name, from_me, msg_timestamp, body, processed_at")
    .eq("user_email", auth.email)
    .order("msg_timestamp", { ascending: false })
    .limit(limit)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ messages: (data || []).reverse() })
}
