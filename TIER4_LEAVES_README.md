# Tier 4 — Independent leaves: name gate, email sign-in, debug route, copy

Built on Tier 3. Four small, independent items, each done honestly rather than
faked.

## 1. "Name your Entwin" — now persisted AND required before Save

The name was local-only React state: cosmetic (used for the Memory title) and
lost on every reload, with no save at all. The v6 spec wanted naming to be a
required step before Save. Both are now real:

- **Persistence.** New `lib/twin/profile.ts` stores the name in the same Upstash
  Redis as LLM keys (`entwin:profile:<hash>`), so it survives reloads and device
  switches. New `GET/POST /api/settings/profile` load and save it; `AppShell`
  loads it on mount.
- **Required gate.** The identity section now has a "Save name" button that is
  disabled until the field has a value, with Saved/error states. The server also
  rejects an empty/whitespace name (`sanitizeName`), so the name can't be blanked
  once the app depends on it — the gate is enforced both client- and server-side.
- **Teardown.** The profile key is added to `redisKeysForUser` in
  `lib/twin/teardown.ts`, so Kill My Twin removes the stored name too.

## 2. Email sign-in — dead affordance removed

The login screen showed "Continue with email" whose only behavior was a toast
saying it "isn't wired up in this prototype." Real email/password auth needs a
password store and a database adapter that Entwin deliberately doesn't have (no
users table — see `KILL_MY_TWIN_README.md`), so faking a second path would be
dishonest. The truthful fix is to remove the affordance: the button, its
handler, the now-unused `note` state, and the divider content are gone. Google
OAuth remains the single, real sign-in path — which is what the backend actually
supports.

## 3. `/api/gmail/debug` — removed

Self-labeled "TEMPORARY diagnostic. Delete before shipping," with a manual
`BUILD_MARKER`, and no callers anywhere. Deleted.

## 4. "digital twin" → "entangled twin" copy

The open question (apply the v5 kill-dialog correction everywhere) is resolved by
making the app copy consistent. The two remaining user-facing "digital twin"
strings — the Kill My Twin confirm dialog and the identity-section help text —
now read "entangled twin," matching the product term. (Internal READMEs are left
as-is; this is about user-facing copy.)

## Files touched / added

- **added** `lib/twin/profile.ts` — name persistence
- **added** `app/api/settings/profile/route.ts` — load/save name (required gate)
- **removed** `app/api/gmail/debug/route.ts`
- `app/page.tsx` — name Save button + gate, name load on mount, email affordance
  removed, "entangled twin" copy
- `lib/twin/teardown.ts` — profile key included in teardown

Verified: `tsc --noEmit` clean, `next build` compiled successfully with
`/api/settings/profile` registered and `/api/gmail/debug` gone.

## Deploy note

No migration. Uses the existing Upstash Redis (`UPSTASH_REDIS_REST_*`). Existing
users have no saved name until they set one — the field shows empty and Save is
disabled until they name it, which is the intended required state.
