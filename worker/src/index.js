import { admin } from './lib/supabase.js';
import { getGmailSession } from './lib/redis.js';
import { getLlmConfig } from './lib/llm-keys.js';
import { makeProvider } from './lib/provider.js';
import {
  ensureAccessToken,
  listMessageIds,
  historySince,
  currentHistoryId,
} from './lib/gmail.js';
import { ingestMessage } from './pipeline/ingest.js';
import { ingestWhatsappBackfill, ingestWhatsappDelta } from './pipeline/whatsapp.js';
import { captureWhatsapp } from './pipeline/whatsapp-capture.js';
import { getSlackSession } from './lib/redis-slack.js';
import { captureSlack, ingestSlackBackfill, ingestSlackDelta } from './pipeline/slack.js';
import { backfillEntities } from './entity-backfill.js';
import { runPool } from './lib/pool.js';
import { deltaDue, markDeltaRan } from './lib/schedule.js';

// backfill | delta                    -> Gmail
// whatsapp-sync                       -> WhatsApp: capture (drain offline) + vectorize, one bounded run
// whatsapp-backfill | whatsapp-delta  -> WhatsApp vectorize-only (advanced/manual)
// slack-sync                          -> Slack: capture (pull last month) + vectorize, one bounded run
// entity-backfill                     -> rebuild entity layer from existing notes
const MODE = process.env.MODE || 'delta';
const CONCURRENCY = Math.max(1, parseInt(process.env.INGEST_CONCURRENCY || '6', 10));
const ONLY_USER = process.env.ONLY_USER || null; // optional single-user run
const ONLY_CARD = process.env.ONLY_CARD || null; // optional single-card run

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
  // Backfill window: the last 1 year, consistently. Computed the same way as the
  // scan (see windowQuery in lib/gmail/service.ts) so scan counts and backfill
  // coverage line up. The date is formatted as after:YYYY/MM/DD by listMessageIds.
  const afterDate = new Date();
  afterDate.setFullYear(afterDate.getFullYear() - 1);

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

async function main() {
  // Entity backfill reuses existing memory_notes — no token, no LLM key,
  // no per-account loop needed. Handle it up front and return.
  if (MODE === 'entity-backfill') {
    console.log('MODE=entity-backfill (building entity layer from existing notes)');
    await backfillEntities();
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

      const llmConfig = await getLlmConfig(acct.user_email);
      if (!llmConfig) {
        console.log(`[${acct.user_email}/${acct.card_id}] no LLM key set — skipping`);
        continue;
      }
      const provider = makeProvider(llmConfig);
      const accessToken = await tokenFor(acct);
      if (MODE === 'backfill') await runBackfill(acct, accessToken, provider);
      else await runDelta(acct, accessToken, provider);
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
