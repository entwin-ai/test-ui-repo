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
import { backfillEntities } from './entity-backfill.js';
import { runPool } from './lib/pool.js';

const MODE = process.env.MODE || 'delta'; // backfill | delta | entity-backfill
const CONCURRENCY = Math.max(1, parseInt(process.env.INGEST_CONCURRENCY || '6', 10));
const ONLY_USER = process.env.ONLY_USER || null; // optional single-user run
const ONLY_CARD = process.env.ONLY_CARD || null; // optional single-card run

// The app writes a sync_state row when a Gmail card connects. That's the
// worker's enumeration source (Redis keys are hashed, so not enumerable back to
// user+card). Each row also holds this account's backfill/delta cursors.
async function accounts() {
  let q = admin.from('sync_state').select('*');
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
    .update({ last_history_id: latestHistoryId, updated_at: new Date().toISOString() })
    .eq('id', acct.id);
}

async function main() {
  // Entity backfill reuses existing memory_notes — no Gmail token, no LLM key,
  // no per-account loop needed. Handle it up front and return.
  if (MODE === 'entity-backfill') {
    console.log('MODE=entity-backfill (building entity layer from existing notes)');
    await backfillEntities();
    return;
  }

  const list = await accounts();
  console.log(`MODE=${MODE} accounts=${list.length}`);
  for (const acct of list) {
    try {
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
