-- ============================================================================
-- Connector "last read" timestamp (migration 0019).
--
-- Tier-2: the connector settings modal's "On-demand check" card showed a
-- permanently hardcoded "Last read: Never" and its "Read Now" button did
-- nothing. This adds the single column needed to make that real: the last time
-- an on-demand check (or the recurring poll) actually read this connector for
-- the user.
--
-- Keyed implicitly by the existing (user_email, connector_key) row it lives on.
-- Nullable: a card that has never been read has no timestamp (rendered as
-- "Never"), which is the honest state rather than a stand-in.
-- ============================================================================

alter table connector_state
  add column if not exists last_read_at timestamptz;
