# Fix — Gmail "Connect" doesn't persist (flips back after connecting / reload)

## Symptom

Connecting Gmail personal: after Google auth, the button showed "Disconnect"
for ~1 second, then reverted to "Connect". Closing and reopening the browser and
returning to Connectors also showed "Connect" — the connection didn't stick.

## Root cause

Two issues:

1. **The connect flag was never persisted.** On return from Google consent,
   `runGmailScan()` set `connected: true` in local React state but never called
   `persistConnectorState()`. Every other connector's connect path writes the
   flag to `connector_state`; the Gmail OAuth-return path was the one that
   didn't. So `connector_state.connected` stayed `false`, and on the next load
   the grid repainted "Connect."

2. **The status hydrator could wrongly downgrade.** On mount, the Gmail status
   hydrator sets `connected = (status === 'connected')` authoritatively. The
   Gmail token session lives in Redis + an in-memory cache; if the durable token
   store (Upstash Redis) isn't configured, a `disconnected` reading may just be a
   lost in-memory session after a serverless cold start — not a real disconnect.
   Treating that as authoritative flipped a genuinely-connected card back to
   "Connect" (the ~1s flicker right after connecting is the same effect: callback
   and status can hit different instances).

## Fix

- `app/page.tsx` (`runGmailScan`): persist `connected: true` to
  `connector_state` as soon as the Gmail connection succeeds, so it survives a
  browser close / reopen.
- `lib/gmail/service.ts` (`status`): return `storeConfigured` (whether the Redis
  token store is set). A `disconnected` reading is only authoritative when the
  store IS configured.
- `app/page.tsx` (Gmail status hydrator): when `storeConfigured === false` and
  the status reads disconnected, keep the persisted connect flag instead of
  downgrading. When the store IS configured, `disconnected` is honored (a real
  revoke/disconnect still correctly clears the card). Disconnect still persists
  `connected: false` and clears the token, so it reflects correctly on reload.

Net: the connected state now persists across reloads and browser restarts, and
no longer flickers back to "Connect" right after connecting.

## Files touched

- `app/page.tsx` — persist connect flag on OAuth return; hydrator no longer
  downgrades when the token store is unavailable.
- `lib/gmail/service.ts` — `GmailStatus.storeConfigured`.

## Note

For the strongest guarantee across serverless instances, configure the Upstash
Redis token store (`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`) — the
same store used for LLM keys. With it set, the Gmail token (and connected state)
is fully durable server-side; without it, the persisted `connector_state` flag
now keeps the UI correct across reloads regardless.

Verified: `tsc --noEmit` clean, `next build` compiled successfully.
