import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Server-only Supabase client using the SERVICE ROLE key. This bypasses RLS,
 * so it MUST only ever be imported by route handlers / server code — never in a
 * client component. Every query built on top of it is scoped by the session
 * email (see lib/rag/query.ts), which is derived from getServerSession and
 * never from request input.
 *
 * LAZY singleton: the client is created on first use, not at module load. This
 * avoids `createClient` throwing "supabaseUrl is required" during `next build`
 * (which evaluates route modules for page-data collection before runtime env
 * vars are necessarily present).
 */
let _client: SupabaseClient | null = null

export function getSupabaseAdmin(): SupabaseClient {
  if (_client) return _client
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  }
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return _client
}
