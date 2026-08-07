# Hotfix — Gmail connect failing on missing `connector_state.last_read_at`

## Symptom

Connecting Gmail failed with:

    Gmail scan failed: column connector_state.last_read_at does not exist

## Cause

The Gmail `scan` path reads connector settings via
`getConnectorState()`, which (since Tier 2) selects `last_read_at`. That column
is added by migration `0019_connector_last_read.sql`. On a database where 0019
hadn't been applied, the SELECT errored and took the whole Gmail scan down with
it — a hard failure of an unrelated feature over an optional column.

## Fix

Two parts:

1. **Code is now resilient** (`lib/connectors/state.ts`). `getConnectorState`,
   `getAllConnectorState`, and `touchLastRead` detect the "column does not exist"
   error (Postgres `42703` / PostgREST message) and transparently fall back to
   reading/writing WITHOUT `last_read_at`. So an un-migrated database no longer
   breaks Gmail connect (or any other connector-state reader) — the only
   degradation is that the modal's "Last read" line stays "Never" until the
   migration is applied. The worker's poll-time write was already best-effort.

2. **Permanent fix: apply the migration.** Run
   `supabase/migrations/0019_connector_last_read.sql` against your database:

       alter table connector_state
         add column if not exists last_read_at timestamptz;

   It's idempotent (`add column if not exists`). After this, the "Last read"
   line and Read Now timestamps work fully.

## Files touched

- `lib/connectors/state.ts` — missing-column detection + fallback in the two
  reads and the touch-write.

Verified: `tsc --noEmit` clean, `next build` compiled successfully.
