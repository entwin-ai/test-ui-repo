import { admin } from './lib/supabase.js';
import { getGmailSession } from './lib/redis.js';
import { getLlmConfig } from './lib/llm-keys.js';
import { makeProvider } from './lib/provider.js';
import {
  ensureAccessToken,
  listMessageIds,
  historySince,
  currentHistoryId,
  getMessage,
  extractParts,
} from './lib/gmail.js';
import { ingestMessage } from './pipeline/ingest.js';
import { appendRollup, hhmm } from './pipeline/ingest.js';
import { classify } from './lib/classify.js';
import { ingestWhatsappBackfill, ingestWhatsappDelta, reprocessEntityAsImportant } from './pipeline/whatsapp.js';
import { captureWhatsapp } from './pipeline/whatsapp-capture.js';
import { probeWhatsapp } from './pipeline/whatsapp-probe.js';
import { getSlackSession } from './lib/redis-slack.js';
import { captureSlack, ingestSlackBackfill, ingestSlackDelta } from './pipeline/slack.js';
import { backfillEntities } from './entity-backfill.js';
import { runPool } from './lib/pool.js';
import { deltaDue, markDeltaRan, backfillDaysFor } from './lib/schedule.js';
import { pruneToWindow } from './lib/prune.js';

// backfill | delta                    -> Gmail
// whatsapp-probe                      -> WhatsApp Phase 0: read-only capability probe (no ingest, no LLM)
// whatsapp-sync                       -> WhatsApp: capture (drain offline) + vectorize, one bounded run
// whatsapp-backfill | whatsapp-delta  -> WhatsApp vectorize-only (advanced/manual)
// slack-sync                          -> Slack: capture (pull last month) + vectorize, one bounded run
// entity-backfill                     -> rebuild entity layer from existing notes
const MODE = process.env.MODE || 'delta';
const CONCURRENCY = Math.max(1, parseInt(process.env.INGEST_CONCURRENCY || '6', 10));
const ONLY_USER = process.env.ONLY_USER || null; // optional single-user run
const ONLY_CARD = process.env.ONLY_CARD || null; // optional single-card run
const ONLY_SENDER = process.env.ONLY_SENDER || null; // optional single-sender backfill
const ONLY_IDENTITY_KEY = process.env.ONLY_IDENTITY_KEY || null; // WhatsApp move-backfill target

// The app writes a sync_state row when a Gmail card connects. That's the
// worker's enumeration source (Redis keys are hashed, so not enumerable back to
// user+card). Each row also holds this account's backfill/delta cursors.
async function accounts(channel) {
  let q = admin.from('sync_state').select('*');
  if (channel) q = q.eq('channel', channel);
  if (ONLY_USER) q = q.eq('user_email', ONLY_USER);
  if (ONLY_CARD) q = q.eq('card_id', ONLY_CARD);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

async function tokenFor(acct) {
  const session = await getGmailSession(acct.user_email, acct.card_id);
  if (!session || session.state !== 'connected') {
    throw new Error('no connected Gmail session in Redis');
  }
  return ensureAccessToken(acct.user_email, acct.card_id, session);
}

async function runBackfill(acct, accessToken, provider) {
  // Backfill window comes from the user's "Initial ingestion (one-time backfill)"
  // setting (connector_state.settings.backfillDays), so what gets ingested
  // matches the count the scan showed at connect time. Falls back to 30 days.
  // Formatted as after:YYYY/MM/DD by listMessageIds.
  const days = await backfillDaysFor(acct.user_email, acct.card_id);
  const afterDate = new Date();
  afterDate.setDate(afterDate.getDate() - days);

  // Enumerate the SAME two labels the scan counts (INBOX + SENT), so backfill
  // coverage matches the scan's numbers. A message in both labels is de-duped
  // downstream by the ledger's unique (user_email, gmail_msg_id).
  const labels = ['INBOX', 'SENT'];
  // Resume support: backfill_cursor is stored as "LABEL:pageToken". If present,
  // start from that label; otherwise start at the first label.
  let startLabelIdx = 0;
  let startToken;
  if (acct.backfill_cursor && acct.backfill_cursor.includes(':')) {
    const [lbl, tok] = acct.backfill_cursor.split(/:(.+)/);
    const idx = labels.indexOf(lbl);
    if (idx >= 0) { startLabelIdx = idx; startToken = tok || undefined; }
  }

  for (let li = startLabelIdx; li < labels.length; li++) {
    const labelId = labels[li];
    const pageToken = li === startLabelIdx ? startToken : undefined;
    for await (const { ids, nextPageToken } of listMessageIds(accessToken, {
      afterDate,
      labelId,
      pageToken,
    })) {
      // Process the page's messages with bounded concurrency instead of one at
      // a time. Each task handles its own errors so one failure doesn't abort.
      await runPool(ids, CONCURRENCY, async (id) => {
        try {
          await ingestMessage(accessToken, acct, provider, id);
        } catch (err) {
          console.error(`[${acct.user_email}/${acct.card_id}] msg ${id}:`, err.message);
        }
      });
      await admin
        .from('sync_state')
        .update({
          backfill_cursor: `${labelId}:${nextPageToken || ''}`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', acct.id);
    }
  }

  const hid = await currentHistoryId(accessToken);
  await admin
    .from('sync_state')
    .update({ backfill_done: true, last_history_id: hid, backfill_cursor: null })
    .eq('id', acct.id);
}

async function runDelta(acct, accessToken, provider) {
  if (!acct.last_history_id) {
    console.log(`[${acct.user_email}/${acct.card_id}] no history cursor — backfill first`);
    return;
  }
  const { ids, latestHistoryId } = await historySince(accessToken, acct.last_history_id);
  await runPool(ids, CONCURRENCY, async (id) => {
    try {
      await ingestMessage(accessToken, acct, provider, id);
    } catch (err) {
      console.error(`[${acct.user_email}/${acct.card_id}] msg ${id}:`, err.message);
    }
  });
  await admin
    .from('sync_state')
    .update({
      last_history_id: latestHistoryId,
      last_delta_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', acct.id);
}

// Onboarding CALIBRATION (Email Ingestion Read Me, Onboarding). Pull the last
// 90 days as a SAMPLE and classify senders into the three lists provisionally —
// WITHOUT writing Memory Notes or rollups. This just populates
// sender_classification so the user has something to confirm on the Kanban. No
// LLM key is needed: classification is code-only. When done, park the account
// at awaiting_confirmation so the full backfill waits for the user's confirm.
async function runCalibrate(acct, accessToken) {
  const afterDate = new Date();
  afterDate.setDate(afterDate.getDate() - 90);
  const labels = ['INBOX', 'SENT'];
  const seen = new Set();

  for (const labelId of labels) {
    for await (const { ids } of listMessageIds(accessToken, { afterDate, labelId })) {
      await runPool(ids, CONCURRENCY, async (id) => {
        if (seen.has(id)) return;
        seen.add(id);
        try {
          const raw = await getMessage(accessToken, id);
          const { headers } = extractParts(raw);
          const sender = headers['from'] || '';
          // classify() reads/writes sender_classification; for an unseen sender
          // it persists a PROVISIONAL row. That is the whole point of calibration.
          await classify(acct.user_email, { headers, sender });
        } catch (err) {
          console.error(`[${acct.user_email}/${acct.card_id}] calibrate ${id}:`, err.message);
        }
      });
    }
  }

  await admin
    .from('sync_state')
    .update({ onboard_phase: 'calibrated', updated_at: new Date().toISOString() })
    .eq('id', acct.id);
  console.log(`[${acct.user_email}/${acct.card_id}] calibration (sender classification) done`);
}

// Daily deleted-email reconciliation (Email Ingestion Read Me, "Deleted email
// handling"). Check Gmail Trash against already-ingested message IDs (well
// within Gmail's 30-day retention). For a deleted email that had produced a
// Memory Note, flag the user directly. For one that landed in Ignore/Updates,
// no notification — one line in a single per-day 'deletions' rollup. Nothing is
// written on a zero-deletion day.
async function runTrashReconcile(acct, accessToken) {
  // Collect current Trash message IDs (bounded to the retention window).
  const afterDate = new Date();
  afterDate.setDate(afterDate.getDate() - 30);
  const trashIds = new Set();
  for await (const { ids } of listMessageIds(accessToken, { afterDate, labelId: 'TRASH' })) {
    for (const id of ids) trashIds.add(id);
  }
  if (trashIds.size === 0) return;

  // Which of those were ingested (are in our ledger) and at what tier?
  const { data: rows } = await admin
    .from('email_message')
    .select('gmail_msg_id, sender, subject, tier, internal_date')
    .eq('user_email', acct.user_email)
    .in('gmail_msg_id', [...trashIds]);
  if (!rows || rows.length === 0) return;

  for (const r of rows) {
    // Already reconciled? mark a flag on the ledger so we don't repeat daily.
    if (r.tier === 'memory') {
      // Significant: a deleted email that became a Memory Note. Flag the user.
      await admin.from('email_message')
        .update({ process_error: 'DELETED_AT_SOURCE_flagged' })
        .eq('user_email', acct.user_email)
        .eq('gmail_msg_id', r.gmail_msg_id);
      // Surface it as a single-line entry too, so there is one place to look.
      await appendRollup(acct, new Date(r.internal_date || Date.now()), 'deletions', {
        time: hhmm(new Date(r.internal_date || Date.now())),
        sender: r.sender,
        subject: r.subject,
        reason: 'memory-note-deleted',
      });
    } else {
      // Ignore/Updates tier: no notification, just one rollup line.
      await appendRollup(acct, new Date(r.internal_date || Date.now()), 'deletions', {
        time: hhmm(new Date(r.internal_date || Date.now())),
        sender: r.sender,
        subject: r.subject,
        reason: `${r.tier}-deleted`,
      });
    }
  }
  console.log(`[${acct.user_email}/${acct.card_id}] trash-reconcile: ${rows.length} ingested deletions`);
}

// Sender-move backfill (Email Ingestion Read Me, "Moving a sender between
// lists", the two confirmed rows). When a sender is moved to a richer tier
// (Marketing -> People or Marketing -> Updates), reprocess that ONE sender's
// full history so past emails get the destination tier's shape — full Memory
// Notes for People, Daily Updates entries for Updates. The move already updated
// sender_classification, so ingestMessage's classify() will now route this
// sender's mail to the richer tier. The ledger's unique (user_email,
// gmail_msg_id) means already-ingested messages are handled idempotently.
async function runSenderBackfill(acct, accessToken, provider, sender) {
  // Full history for this sender (Gmail search: from:<sender>). No date floor
  // beyond Gmail's own; use a wide window.
  const afterDate = new Date('2004-01-01'); // Gmail epoch-ish; effectively "all"
  const labels = ['INBOX', 'SENT'];
  const seen = new Set();
  for (const labelId of labels) {
    for await (const { ids } of listMessageIds(accessToken, { afterDate, labelId, fromSender: sender })) {
      await runPool(ids, CONCURRENCY, async (id) => {
        if (seen.has(id)) return;
        seen.add(id);
        try {
          await ingestMessage(accessToken, acct, provider, id);
        } catch (err) {
          console.error(`[${acct.user_email}/${acct.card_id}] sender-backfill ${id}:`, err.message);
        }
      });
    }
  }
  console.log(`[${acct.user_email}/${acct.card_id}] sender-backfill for ${sender}: ${seen.size} messages`);
}

async function main() {
  // Entity backfill reuses existing memory_notes — no token, no LLM key,
  // no per-account loop needed. Handle it up front and return.
  if (MODE === 'entity-backfill') {
    console.log('MODE=entity-backfill (building entity layer from existing notes)');
    await backfillEntities();
    return;
  }

  // ---- WhatsApp capability probe (Phase 0) ----------------------------------
  // A VERIFICATION spike, not an ingestion path. For each linked account it
  // opens a short-lived READ-ONLY socket and inspects only the metadata surface
  // (group/community/mute/admin/member-count/archived + username durability),
  // writing a machine-readable row to whatsapp_capability_probe. It reads NO
  // message bodies, writes NO memory notes, and never touches sync_state — so
  // it needs no LLM key and is safe to run against a live account any time.
  // Its findings gate whether Phases 1/2/6 can be built as specified.
  if (MODE === 'whatsapp-probe') {
    const list = await accounts('whatsapp');
    console.log(`MODE=whatsapp-probe whatsapp-accounts=${list.length}`);
    for (const acct of list) {
      try {
        const { notPaired } = await probeWhatsapp(acct);
        if (notPaired) continue; // needs one-time pairing first
      } catch (err) {
        console.error(`[${acct.user_email}/wa-probe] failed:`, err.message);
      }
    }
    return;
  }

  // ---- WhatsApp modes -------------------------------------------------------
  // whatsapp-sync is the batch-hourly path: for each linked account, open a
  // short-lived socket to DRAIN the offline backlog into whatsapp_message
  // (capture), then vectorize the freshly captured rows in the SAME run. No
  // socket is held between runs — this is what makes WhatsApp work in bounded
  // GitHub Actions jobs instead of an always-on host.
  if (MODE === 'whatsapp-sync') {
    const list = await accounts('whatsapp');
    console.log(`MODE=whatsapp-sync whatsapp-accounts=${list.length}`);
    for (const acct of list) {
      try {
        const llmConfig = await getLlmConfig(acct.user_email);
        if (!llmConfig) {
          console.log(`[${acct.user_email}/${acct.card_id}] no LLM key set — skipping`);
          continue;
        }
        const provider = makeProvider(llmConfig);

        // 1. CAPTURE: drain WhatsApp's offline sync into the ledger.
        const { captured, notPaired } = await captureWhatsapp(acct);
        if (notPaired) continue; // needs one-time pairing first
        console.log(`[${acct.user_email}/wa] captured ${captured} new rows`);

        // 2. VECTORIZE: turn unprocessed rows into notes/entities/embeddings.
        //    First run does the 1-month backfill; later runs do delta. Both only
        //    touch rows with processed_at IS NULL, so this is safe to run every
        //    hour regardless of how many rows capture produced.
        if (!acct.backfill_done) {
          await ingestWhatsappBackfill(acct, provider, runPool, CONCURRENCY);
        } else {
          await ingestWhatsappDelta(acct, provider, runPool, CONCURRENCY);
        }
        console.log(`[${acct.user_email}/${acct.card_id}] whatsapp-sync done`);
      } catch (err) {
        console.error(`[${acct.user_email}/${acct.card_id}] whatsapp-sync failed:`, err.message);
      }
    }
    return;
  }

  // Vectorize-only WhatsApp modes (no capture) — for manual re-processing of
  // already-captured rows, or if capture is driven from elsewhere.
  if (MODE === 'whatsapp-backfill' || MODE === 'whatsapp-delta') {
    const list = await accounts('whatsapp');
    console.log(`MODE=${MODE} whatsapp-accounts=${list.length}`);
    for (const acct of list) {
      try {
        const llmConfig = await getLlmConfig(acct.user_email);
        if (!llmConfig) {
          console.log(`[${acct.user_email}/${acct.card_id}] no LLM key set — skipping`);
          continue;
        }
        const provider = makeProvider(llmConfig);
        if (MODE === 'whatsapp-backfill') {
          await ingestWhatsappBackfill(acct, provider, runPool, CONCURRENCY);
        } else {
          await ingestWhatsappDelta(acct, provider, runPool, CONCURRENCY);
        }
        console.log(`[${acct.user_email}/${acct.card_id}] ${MODE} done`);
      } catch (err) {
        console.error(`[${acct.user_email}/${acct.card_id}] wa account failed:`, err.message);
      }
    }
    return;
  }

  // ---- WhatsApp Updates->Important move backfill (Phase 5, Read Me §8) -------
  // Dispatched by PATCH /api/whatsapp/entities when the user drags an entity
  // from Updates to Important. Re-expands that ONE entity's past Updates days
  // (gists) into full facet-split Memory Notes. Scoped to one user + identity key.
  if (MODE === 'whatsapp-move-backfill') {
    if (!ONLY_IDENTITY_KEY) {
      console.log('whatsapp-move-backfill requires ONLY_IDENTITY_KEY — skipping');
      return;
    }
    const list = await accounts('whatsapp');
    console.log(`MODE=whatsapp-move-backfill key=${ONLY_IDENTITY_KEY} accounts=${list.length}`);
    for (const acct of list) {
      try {
        const llmConfig = await getLlmConfig(acct.user_email);
        if (!llmConfig) {
          console.log(`[${acct.user_email}/${acct.card_id}] no LLM key set — skipping`);
          continue;
        }
        const provider = makeProvider(llmConfig);
        await reprocessEntityAsImportant(acct, provider, ONLY_IDENTITY_KEY, runPool, CONCURRENCY);
      } catch (err) {
        console.error(`[${acct.user_email}/${acct.card_id}] whatsapp-move-backfill failed:`, err.message);
      }
    }
    return;
  }

  // ---- Slack mode (slack-sync) ---------------------------------------------
  // Slack is pull-based, so ONE bounded run does both halves: CAPTURE pulls the
  // last month of messages across every readable conversation into the
  // slack_message ledger using the user token stored in Redis (written by the
  // OAuth callback), then VECTORIZE turns the unprocessed rows into memory
  // notes + entities + embeddings — the same pipeline Gmail and WhatsApp use.
  if (MODE === 'slack-sync') {
    const list = await accounts('slack');
    console.log(`MODE=slack-sync slack-accounts=${list.length}`);
    for (const acct of list) {
      try {
        const session = await getSlackSession(acct.user_email, acct.card_id);
        if (!session || session.state !== 'connected' || !session.accessToken) {
          console.log(`[${acct.user_email}/${acct.card_id}] no connected Slack session — skipping`);
          continue;
        }
        const llmConfig = await getLlmConfig(acct.user_email);
        if (!llmConfig) {
          console.log(`[${acct.user_email}/${acct.card_id}] no LLM key set — skipping`);
          continue;
        }
        const provider = makeProvider(llmConfig);
        const token = session.accessToken;

        // 1. CAPTURE: pull last-month messages into the ledger (idempotent).
        const captured = await captureSlack(acct, token, session.authedUser);
        console.log(`[${acct.user_email}/slack] captured ${captured} new rows`);

        // 2. VECTORIZE: first run backfills the month, later runs do delta.
        //    Both only touch processed_at IS NULL rows, so re-runs are safe.
        if (!acct.backfill_done) {
          await ingestSlackBackfill(acct, provider, token, runPool, CONCURRENCY);
        } else {
          await ingestSlackDelta(acct, provider, token, runPool, CONCURRENCY);
        }
        console.log(`[${acct.user_email}/${acct.card_id}] slack-sync done`);
      } catch (err) {
        console.error(`[${acct.user_email}/${acct.card_id}] slack-sync failed:`, err.message);
      }
    }
    return;
  }

  // ---- Gmail modes (backfill | delta) --------------------------------------
  const list = await accounts('gmail');
  console.log(`MODE=${MODE} gmail-accounts=${list.length}`);
  for (const acct of list) {
    try {
      // Per-user scheduling: in delta mode, only run this account if the user's
      // chosen "Reading frequency" (pollHours, from connector_state.settings)
      // has elapsed since its last successful delta. Backfill is never gated.
      // This is what makes user X (every 3h) and user Y (every 10h) each run at
      // their own cadence off one shared heartbeat cron.
      if (MODE === 'delta') {
        const { due, pollHours, nextDueAt } = await deltaDue(acct);
        if (!due) {
          console.log(
            `[${acct.user_email}/${acct.card_id}] not due (every ${pollHours}h; ` +
              `next ~${nextDueAt ? nextDueAt.toISOString() : 'n/a'}) — skipping`,
          );
          continue;
        }
        console.log(`[${acct.user_email}/${acct.card_id}] due (every ${pollHours}h) — running delta`);
      }

      // trash-reconcile is metadata only — no LLM key needed.
      if (MODE === 'trash-reconcile') {
        const accessToken = await tokenFor(acct);
        await runTrashReconcile(acct, accessToken);
        console.log(`[${acct.user_email}/${acct.card_id}] trash-reconcile done`);
        continue;
      }

      // CALIBRATE = onboarding first pass. Classify senders (fast, header-only),
      // then IMMEDIATELY run the full backfill in this same job so connecting an
      // account actually ingests mail end-to-end. Sender classification runs
      // first so the backfill routes each email to the right tier. The Kanban
      // remains available for post-hoc corrections (which trigger their own
      // sender-backfills), but ingestion no longer BLOCKS on a manual confirm.
      if (MODE === 'calibrate') {
        const accessToken = await tokenFor(acct);
        await runCalibrate(acct, accessToken); // classify senders (no notes yet)

        const llmConfig = await getLlmConfig(acct.user_email);
        if (!llmConfig) {
          // Can't write notes without an LLM key — leave senders classified and
          // stop here; the delta cron will backfill once a key is set.
          console.log(`[${acct.user_email}/${acct.card_id}] calibrated, but no LLM key — backfill deferred`);
          continue;
        }
        const provider = makeProvider(llmConfig);
        await runBackfill(acct, accessToken, provider); // ingest for real
        await admin
          .from('sync_state')
          .update({ onboard_phase: 'done', backfill_done: true, updated_at: new Date().toISOString() })
          .eq('id', acct.id);
        console.log(`[${acct.user_email}/${acct.card_id}] calibrate + backfill done`);
        continue;
      }

      const llmConfig = await getLlmConfig(acct.user_email);
      if (!llmConfig) {
        console.log(`[${acct.user_email}/${acct.card_id}] no LLM key set — skipping`);
        continue;
      }
      const provider = makeProvider(llmConfig);
      const accessToken = await tokenFor(acct);
      if (MODE === 'backfill') await runBackfill(acct, accessToken, provider);
      else if (MODE === 'sender-backfill') {
        if (!ONLY_SENDER) { console.log('sender-backfill requires ONLY_SENDER — skipping'); continue; }
        await runSenderBackfill(acct, accessToken, provider, ONLY_SENDER);
      }
      else await runDelta(acct, accessToken, provider);
      // Rolling retention: on the recurring delta pass, trim derived memory that
      // has aged out of the connector's total ingestion window. Best-effort —
      // never blocks or fails the run (see prune.js).
      if (MODE === 'delta') await pruneToWindow(acct.user_email, acct.card_id);
      // Record that this connector was just read, so the settings modal's
      // "Last read" line reflects automatic polls, not only manual Read Now.
      // Best-effort: a bookkeeping failure must never fail ingestion.
      if (MODE === 'delta') {
        try {
          await admin
            .from('connector_state')
            .update({ last_read_at: new Date().toISOString() })
            .eq('user_email', acct.user_email)
            .eq('connector_key', acct.card_id);
        } catch (e) {
          console.error(`[${acct.user_email}/${acct.card_id}] last_read_at update failed (non-fatal):`, e.message);
        }
      }
      console.log(`[${acct.user_email}/${acct.card_id}] ${MODE} done`);
    } catch (err) {
      console.error(`[${acct.user_email}/${acct.card_id}] account failed:`, err.message);
      // continue — one account's failure must not block others
    }
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('fatal:', err);
    process.exit(1);
  }
);
