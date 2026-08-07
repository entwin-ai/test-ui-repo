import { admin } from './supabase.js';
import { windowDaysFor } from './schedule.js';

/**
 * Rolling-window retention.
 *
 * The connector setting "Total ingestion window" is the range Entwin keeps
 * indexed going forward. Until now it was a stored-but-unused number. This makes
 * it real: anything older than the window is pruned so the vault reflects the
 * range the user actually asked for.
 *
 * What gets pruned, per (user_email, card_id), for notes older than the window:
 *   - memory_note        (note_chunk cascades via FK ON DELETE CASCADE)
 *   - daily_rollup       (rollup_date older than the window)
 *
 * We deliberately DON'T touch email_message / whatsapp_message / slack_message:
 * those are raw source rows keyed by their own cursors, and widening the window
 * later should be able to re-derive notes from them without a re-fetch. Pruning
 * derived memory is the reversible, safe layer to trim.
 *
 * Safety:
 *   - Bounded by the same per-connector window reader the rest of the worker
 *     uses, which floors the window at the backfill size — so a prune can never
 *     delete inside freshly-backfilled history.
 *   - Best-effort and isolated: a failure here is logged and swallowed so it can
 *     never fail an ingestion run.
 *   - A cutoff is only computed when a real window exists; there is no "prune
 *     everything" path.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Prune derived memory older than the connector's rolling window.
 * @returns {Promise<{ notes: number, rollups: number, cutoff: string } | null>}
 */
export async function pruneToWindow(userEmail, cardId) {
  try {
    const windowDays = await windowDaysFor(userEmail, cardId);
    if (!Number.isFinite(windowDays) || windowDays <= 0) return null;

    const cutoffDate = new Date(Date.now() - windowDays * DAY_MS);
    const cutoffTs = cutoffDate.toISOString();
    const cutoffDay = cutoffTs.slice(0, 10); // YYYY-MM-DD for date columns

    // 1. Memory notes older than the window (note_chunk cascades).
    const { data: delNotes, error: notesErr } = await admin
      .from('memory_note')
      .delete()
      .eq('user_email', userEmail)
      .eq('card_id', cardId)
      .lt('note_date', cutoffDay)
      .select('id');
    if (notesErr) throw new Error(`memory_note prune: ${notesErr.message}`);

    // 2. Daily rollups older than the window.
    const { data: delRollups, error: rollErr } = await admin
      .from('daily_rollup')
      .delete()
      .eq('user_email', userEmail)
      .eq('card_id', cardId)
      .lt('rollup_date', cutoffDay)
      .select('id');
    if (rollErr) throw new Error(`daily_rollup prune: ${rollErr.message}`);

    const notes = delNotes ? delNotes.length : 0;
    const rollups = delRollups ? delRollups.length : 0;
    if (notes || rollups) {
      console.log(
        `[${userEmail}/${cardId}] pruned to ${windowDays}d window (before ${cutoffDay}): ${notes} notes, ${rollups} rollups`,
      );
    }
    return { notes, rollups, cutoff: cutoffDay };
  } catch (e) {
    // Retention is best-effort — never let it fail a run.
    console.error(`[${userEmail}/${cardId}] prune failed (non-fatal):`, e.message);
    return null;
  }
}
