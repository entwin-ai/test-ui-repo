-- ============================================================================
-- Per-user Gmail delta scheduling (migration 0011).
--
-- Goal: run each user's Gmail delta job at THEIR chosen cadence — the "Reading
-- frequency" (Poll every N hours) they set in a Gmail card's settings modal —
-- instead of running every connected account on one global 15-minute cron.
--
-- Mechanism (no external scheduler needed):
--   • A single workflow (delta.yml) still fires on a coarse heartbeat cron.
--   • On each tick the worker looks at every gmail row in sync_state and, per
--     account, reads that user's pollHours from connector_state.settings, then
--     runs delta for the account ONLY if pollHours have elapsed since its last
--     successful delta. This column is that per-account "last ran" cursor.
--
-- The authoritative frequency lives in connector_state.settings.pollHours
-- (written by the settings modal). We deliberately do NOT copy it here to avoid
-- a second source of truth; we only track WHEN delta last ran per account.
-- ============================================================================

alter table sync_state
  add column if not exists last_delta_at timestamptz;

-- Cheap lookup for "which accounts are due" scans by the worker.
create index if not exists sync_state_last_delta_idx
  on sync_state (channel, last_delta_at);

comment on column sync_state.last_delta_at is
  'Timestamp of the last successful Gmail delta run for this (user_email, card_id). '
  'The worker compares now() against last_delta_at + connector_state.settings.pollHours '
  'to decide whether this account is due this tick. NULL = never run yet (always due).';
