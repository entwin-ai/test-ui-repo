-- ============================================================================
-- Gmail onboarding phase tracking (migration 0014).
--
-- Phase 5.1 of the build plan. The Email Ingestion Read Me defines a precise
-- first-connection sequence:
--   1. Pull the last 90 days as a CALIBRATION SAMPLE — classify senders into the
--      three lists provisionally, WITHOUT writing Memory Notes/rollups yet.
--   2. Surface those senders on the Kanban; the user confirms/corrects.
--   3. THEN run the full inbox history using the confirmed sender lists.
--
-- Today the connect flow dispatches a 1-year full backfill immediately. This
-- column lets the worker + routes coordinate the three-step handshake.
--
-- Purely additive: one nullable column on sync_state, defaulted so existing
-- rows (already mid-ingest under the old flow) are treated as 'done' and never
-- regress. RLS already governs sync_state (0002).
-- ============================================================================

alter table sync_state
  add column if not exists onboard_phase text not null default 'done';

-- Values:
--   calibrating           -> 90-day sample running (senders only, no notes)
--   awaiting_confirmation  -> sample done; waiting for the user to confirm on Kanban
--   confirmed              -> user confirmed; full backfill dispatched/running
--   done                   -> full history ingested (or legacy row from old flow)
comment on column sync_state.onboard_phase is
  'Gmail first-connection onboarding stage: calibrating | awaiting_confirmation '
  '| confirmed | done. Drives the 90-day-calibrate -> confirm -> full-ingest '
  'handshake (Email Ingestion Read Me, Onboarding). Defaults to done so pre-existing '
  'rows are never pushed back through onboarding.';
