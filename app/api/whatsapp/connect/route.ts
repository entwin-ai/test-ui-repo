import { NextRequest, NextResponse } from "next/server"
import { requireUser } from "@/lib/whatsapp/route-helpers"
import { connect } from "@/lib/whatsapp/service"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  // WhatsApp linking needs a persistent Node process holding a live
  // websocket. Serverless platforms kill the process right after the HTTP
  // response, so pairing can never complete there — fail fast and clearly.
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY) {
    return NextResponse.json(
      {
        error:
          'WhatsApp linking is not supported on serverless hosting (Vercel/Lambda/Netlify). ' +
          'Run the app under a persistent Node server instead: locally with `npm run dev`, or on Railway/Render/Fly.io/a VPS.',
      },
      { status: 501 }
    )
  }
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
