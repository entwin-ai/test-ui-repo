import { admin } from './supabase.js';

// Per-user Gmail delta scheduling.
//
// The user's chosen "Reading frequency" (Poll every N hours) is stored by the
// app in connector_state.settings.pollHours, keyed by (user_email,
// connector_key) where connector_key === the Gmail card_id
// (gmail-personal | gmail-professional). We read it here and compare against
// sync_state.last_delta_at to decide whether an account is due on this tick.

// Mirror the app's stepper bounds (lib/connectors/state.ts) so a bad/hand-edited
// value can never make the job hammer Gmail or never run.
const POLL_MIN_HOURS = 1;
const POLL_MAX_HOURS = 24;
const POLL_DEFAULT_HOURS = 24; // used when the user never saved settings

function clampHours(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return POLL_DEFAULT_HOURS;
  return Math.min(POLL_MAX_HOURS, Math.max(POLL_MIN_HOURS, Math.trunc(v)));
}

/**
 * Resolve this account's poll interval, in hours, from the user's saved
 * connector settings. Falls back to the default when no settings row exists yet
 * (e.g. an older account connected before the settings feature) or the value is
 * missing/out of range.
 */
export async function pollHoursFor(userEmail, cardId) {
  const { data, error } = await admin
    .from('connector_state')
    .select('settings')
    .eq('user_email', userEmail)
    .eq('connector_key', cardId)
    .maybeSingle();

  if (error) {
    // Don't let a settings read failure block ingestion — fall back to default.
    console.error(`[${userEmail}/${cardId}] pollHours read failed:`, error.message);
    return POLL_DEFAULT_HOURS;
  }
  const raw = data && data.settings ? data.settings.pollHours : undefined;
  return clampHours(raw);
}

// "Initial ingestion (one-time backfill)" window, in days, from the user's saved
// settings. Mirrors the UI stepper bounds (1..100) and the 30-day default so the
// backfill ingests exactly the window the scan counted.
const BACKFILL_MIN_DAYS = 1;
const BACKFILL_MAX_DAYS = 100;
const BACKFILL_DEFAULT_DAYS = 30;

function clampDays(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return BACKFILL_DEFAULT_DAYS;
  return Math.min(BACKFILL_MAX_DAYS, Math.max(BACKFILL_MIN_DAYS, Math.trunc(v)));
}

export async function backfillDaysFor(userEmail, cardId) {
  const { data, error } = await admin
    .from('connector_state')
    .select('settings')
    .eq('user_email', userEmail)
    .eq('connector_key', cardId)
    .maybeSingle();
  if (error) {
    console.error(`[${userEmail}/${cardId}] backfillDays read failed:`, error.message);
    return BACKFILL_DEFAULT_DAYS;
  }
  const raw = data && data.settings ? data.settings.backfillDays : undefined;
  return clampDays(raw);
}

// "Total ingestion window", in days — the rolling range Entwin keeps indexed
// going forward. Mirrors the UI stepper bounds (lib/connectors/state.ts:
// 30..3650, default 365). Data older than this window is pruned. The window can
// never be shorter than the backfill (enforced app-side on save; re-floored here
// defensively so a stale row can't prune inside freshly-backfilled history).
const WINDOW_MIN_DAYS = 30;
const WINDOW_MAX_DAYS = 3650;
const WINDOW_DEFAULT_DAYS = 365;

export async function windowDaysFor(userEmail, cardId) {
  const { data, error } = await admin
    .from('connector_state')
    .select('settings')
    .eq('user_email', userEmail)
    .eq('connector_key', cardId)
    .maybeSingle();
  if (error) {
    console.error(`[${userEmail}/${cardId}] totalWindowDays read failed:`, error.message);
    return WINDOW_DEFAULT_DAYS;
  }
  const s = (data && data.settings) || {};
  let v = Number(s.totalWindowDays);
  if (!Number.isFinite(v)) v = WINDOW_DEFAULT_DAYS;
  v = Math.min(WINDOW_MAX_DAYS, Math.max(WINDOW_MIN_DAYS, Math.trunc(v)));
  const backfill = clampDays(s.backfillDays);
  return Math.max(v, backfill);
}

/**
 * Decide whether this account's delta is due now.
 * Due when it has never run (last_delta_at is null) or when at least
 * pollHours have elapsed since the last successful delta.
 *
 * Returns { due, pollHours, nextDueAt } so the caller can log a clear reason.
 */
export async function deltaDue(acct, now = new Date()) {
  const pollHours = await pollHoursFor(acct.user_email, acct.card_id);

  if (!acct.last_delta_at) {
    return { due: true, pollHours, nextDueAt: null };
  }
  const last = new Date(acct.last_delta_at).getTime();
  const nextDueAt = new Date(last + pollHours * 3600_000);
  return { due: now.getTime() >= nextDueAt.getTime(), pollHours, nextDueAt };
}

/** Stamp a successful delta so the next tick measures from now. */
export async function markDeltaRan(acctId, now = new Date()) {
  await admin
    .from('sync_state')
    .update({ last_delta_at: now.toISOString() })
    .eq('id', acctId);
}
