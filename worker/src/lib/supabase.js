import { createClient } from '@supabase/supabase-js';

// Service-role client. Bypasses RLS by design. Isolation rule that replaces RLS:
// every write sets user_email from the account being processed — never from
// untrusted input. This key lives ONLY in GitHub Actions secrets.
//
// realtime disabled: the worker only does REST reads/writes and never needs
// websockets. Leaving realtime on makes @supabase/supabase-js try to construct
// a WebSocket at import time, which throws on Node < 22 ("Node.js 20 detected
// without native WebSocket support"). Disabling it removes that dependency.
export const admin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { disabled: true },
    global: { fetch: fetch },
  }
);
