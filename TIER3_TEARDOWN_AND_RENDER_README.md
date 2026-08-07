# Tier 3 — Finish Kill My Twin; resolve the orphaned upload TODO

Built on Tier 2. Scope note up front: the original audit listed the animatics
render pipeline as "partially implemented," but on close reading the real
pipeline (parse → characters → screenplay → render queue → claim → complete →
video-ready email) is already **complete and wired** to the Animatics UI
(`app/animatics-flow.tsx` → `/api/animatics/*`). The email module genuinely
sends via Resend or SMTP and only no-ops when no transport is configured, which
is correct fallback behavior, not a gap. So Tier 3's real remaining work was
narrower than implied:

1. Kill My Twin — in-flight GitHub Actions run cancellation (the genuinely
   unfinished piece, explicitly left as a gap in `KILL_MY_TWIN_README.md`).
2. The orphaned `/api/anime/upload` route with its `TODO: enqueue the job`.

## 1. Kill My Twin now cancels in-flight runs

The earlier teardown could stop a user being *picked up* again (by deleting
`sync_state`) and could neutralize a running job by revoking its Redis tokens,
but it did not *cancel* a GitHub Actions run already executing at the moment of
deletion — because dispatch inputs aren't queryable from the runs list, so runs
couldn't be attributed to a user. This closes that gap by making runs
attributable:

- **Attribution marker.** Every user-scoped dispatch workflow now sets a
  `run-name:` embedding the target email as `entwin-user:<email>` (blank scope →
  `entwin-user:all`). Added to: `whatsapp-sync`, `whatsapp-pair`,
  `whatsapp-probe`, `whatsapp-move-backfill`, `calibrate`, `entity-backfill`,
  `sender-backfill`, `slack-sync`, `slack-backfill`. GitHub surfaces `run-name`
  as the run's `display_title`, which **is** queryable — unlike the inputs.

- **Cancellation.** `lib/twin/teardown.ts` gains `cancelInFlightRuns(email)`: it
  lists `in_progress` and `queued` runs (paged, bounded), matches the
  `entwin-user:<email>` marker in each run's title, and POSTs the cancel
  endpoint for the matches only — never touching another user's runs. It runs as
  step 4, **before** the `sync_state` deletion, so a live run is cancelled while
  still attributable. Best-effort: a failure is recorded in the report's
  `errors[]` but does not flip `report.ok` (token revocation remains the
  backstop, and the data deletion is what matters for the 200/207 status).

- **Reporting.** `TeardownReport` gains
  `githubRuns: { attempted, cancelled, matched, error? }`. The existing
  `DELETE /api/twin` passes the whole report through unchanged, and the Kill My
  Twin button already surfaces `errors[]`, so a cancellation problem shows up
  without any UI change.

Requires `GH_REPO` + `GH_DISPATCH_TOKEN` (Actions read+write). When unset the
step is skipped (`attempted: false`) and teardown proceeds exactly as before.

## 2. `/api/anime/upload` — real, not a stub

This route was orphaned dead code (no caller anywhere) that minted a throwaway
`crypto.randomUUID()` and returned `202 queued` with a `TODO: enqueue the job`.
It's now a thin, authenticated alias that delegates to the **same** pipeline the
Animatics UI uses: validate the `.txt`, `cleanNovel`, and `createJob` in Redis
(EXTRACTING state), returning the real job id. Character extraction remains the
next, separate step, so the request stays fast. New integrations should prefer
`/api/animatics/parse`; this alias now does the right thing if hit.

## Files touched / added

- `lib/twin/teardown.ts` — `cancelInFlightRuns`, `githubRuns` report field,
  updated docstring
- `.github/workflows/*.yml` (9 files) — `run-name:` attribution marker
- `app/api/anime/upload/route.ts` — real pipeline delegation (was a TODO stub)
- `.env.local.example` — note GH token also powers run cancellation
- **added** `TIER3_TEARDOWN_AND_RENDER_README.md`

Verified: `tsc --noEmit` clean, `next build` compiled successfully, all 12
workflow YAMLs parse.

## Deploy note

No migration. For the cancellation step to be active, `GH_REPO` and
`GH_DISPATCH_TOKEN` must be set and the workflow `run-name:` changes must be
deployed to the default branch (runs dispatched before the run-name change won't
carry the marker and won't be matched — only a concern for runs already in
flight across the deploy boundary; the token-revocation backstop still covers
those).
