import { admin } from '../lib/supabase.js';
import { writeChatNoteAndEntities } from '../lib/prompts.js';
import { chunkText } from '../lib/chunk.js';
import { resolveEntitiesForNote } from '../lib/resolver.js';
import {
  listConversations,
  channelHistory,
  userName,
  permalink,
  tsToIso,
} from '../lib/slack.js';

// Slack ingestion — both halves run in the GitHub Actions worker.
//
// Slack is pull-based (Web API, no persistent socket), so unlike WhatsApp the
// worker can CAPTURE (drain the last month into slack_message) and then
// VECTORIZE (turn unprocessed rows into memory notes + entities + embeddings)
// in one bounded job. The output is identical in shape to the Gmail and
// WhatsApp pipelines, so Slack is queryable via RAG and drawn on the memory
// map, unified with the other channels by entity.
//
// Entry points (called from worker/src/index.js):
//   * captureSlack(acct)                     — pull last-month messages into the ledger
//   * ingestSlackBackfill(acct, provider)    — first vectorize pass over the month
//   * ingestSlackDelta(acct, provider)       — subsequent passes (new rows only)

const isChatSubtypeToSkip = (m) =>
  m.subtype === 'channel_join' ||
  m.subtype === 'channel_leave' ||
  m.subtype === 'channel_topic' ||
  m.subtype === 'channel_purpose' ||
  m.subtype === 'channel_name' ||
  m.subtype === 'bot_add' ||
  m.subtype === 'bot_remove';

function classifyChannel(c) {
  if (c.is_im) return 'im';
  if (c.is_mpim) return 'mpim';
  if (c.is_private) return 'private';
  return 'public';
}

function channelLabel(c) {
  if (c.name) return `#${c.name}`;
  if (c.is_im) return 'Direct message';
  if (c.is_mpim) return 'Group DM';
  return c.id;
}

// -----------------------------------------------------------------------------
// CAPTURE: pull the last 1 month of messages across all conversations into the
// slack_message ledger. Idempotent — upsert on (user_email, channel_id, ts).
// Returns the number of new rows written.
// -----------------------------------------------------------------------------
export async function captureSlack(acct, token, authedUserId) {
  const { user_email, card_id } = acct;

  const floorIso =
    acct.slack_backfill_after ||
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const oldest = String(Math.floor(new Date(floorIso).getTime() / 1000));

  const conversations = await listConversations(token);
  const nameCache = new Map(); // slack user id -> display name
  let captured = 0;

  for (const conv of conversations) {
    const channelType = classifyChannel(conv);
    const channelName = channelLabel(conv);

    for await (const page of channelHistory(token, conv.id, oldest)) {
      const rows = [];
      for (const m of page) {
        if (m.type !== 'message') continue;
        if (isChatSubtypeToSkip(m)) continue;
        if (!m.text && !m.attachments && !m.files) continue;

        const senderId = m.user || m.bot_id || null;
        let senderName = null;
        if (senderId && m.user) {
          if (nameCache.has(senderId)) senderName = nameCache.get(senderId);
          else {
            senderName = await userName(token, senderId);
            nameCache.set(senderId, senderName);
          }
        }

        rows.push({
          user_email,
          card_id,
          slack_msg_ts: m.ts,
          channel_id: conv.id,
          channel_name: channelName,
          channel_type: channelType,
          sender: senderId,
          sender_name: senderName,
          from_me: Boolean(authedUserId && m.user === authedUserId),
          msg_timestamp: tsToIso(m.ts),
          body: m.text || '',
          permalink: null, // filled lazily at vectorize time to save API calls
        });
      }

      if (rows.length > 0) {
        // Ignore-duplicates upsert: rows already captured in a prior run stay put
        // (and keep their processed_at), new rows land unprocessed.
        const { error, count } = await admin
          .from('slack_message')
          .upsert(rows, {
            onConflict: 'user_email,channel_id,slack_msg_ts',
            ignoreDuplicates: true,
            count: 'exact',
          });
        if (error) {
          console.error(`[${user_email}/slack] capture ${conv.id}:`, error.message);
        } else {
          captured += count || 0;
        }
      }
    }
  }

  return captured;
}

// -----------------------------------------------------------------------------
// VECTORIZE: turn one unprocessed slack_message row into a memory note + chunks
// + entities. Same shape as the WhatsApp pipeline's processOne.
// -----------------------------------------------------------------------------
async function processOne(acct, provider, token, row) {
  const { user_email, card_id } = acct;
  if (row.processed_at) return { skipped: true };
  if (!row.body || !row.body.trim()) {
    // Nothing to summarize (e.g. a bare file share) — mark processed, skip note.
    await admin
      .from('slack_message')
      .update({ processed_at: new Date().toISOString() })
      .eq('id', row.id);
    return { skipped: true };
  }

  const noteDate = new Date(row.msg_timestamp).toISOString().slice(0, 10);
  const chatName =
    row.channel_name || row.channel_id;
  const senderLabel = row.from_me ? 'me' : row.sender_name || row.sender || 'someone';
  const isGroup = row.channel_type !== 'im';

  try {
    // MERGED single LLM call: note fields + related_entities, chat framing —
    // the SAME writer WhatsApp uses, so Slack notes have identical structure.
    const { note, related } = await writeChatNoteAndEntities(provider, user_email, {
      chatName: `Slack ${chatName}`,
      sender: senderLabel,
      body: row.body,
      date: noteDate,
      isGroup,
    });

    const noteId = await nextNoteId(user_email, noteDate, 'slack');

    // Resolve the permalink now (one call per note, not per captured message).
    let sourceUrl = row.permalink;
    if (!sourceUrl) {
      sourceUrl = await permalink(token, row.channel_id, row.slack_msg_ts);
    }

    const { data: noteRow, error: noteErr } = await admin
      .from('memory_note')
      .insert({
        user_email,
        card_id,
        note_id: noteId,
        slack_message_id: row.id,
        gmail_msg_id: null,
        source: 'slack',
        source_ref: row.slack_msg_ts,
        note_date: noteDate,
        name: chatName,
        raw_summary: note.raw_summary,
        urgency: note.urgency,
        life_domain: note.life_domain,
        action: note.action,
        free_text: note.free_text,
        confidentiality: note.confidentiality,
        related_entities: related,
        source_url: sourceUrl,
      })
      .select()
      .single();
    if (noteErr) throw new Error(`note insert: ${noteErr.message}`);

    // Cross-channel entity unification — SAME resolver as email + WhatsApp.
    try {
      await resolveEntitiesForNote(user_email, noteRow.id, related, noteDate);
    } catch (err) {
      console.error(`[${user_email}] slack resolver:`, err.message);
    }

    // RAG embeddings — same note_chunk table + ivfflat index as the other
    // channels, so hybrid retrieval spans all three with no query change.
    const header = `Slack — ${chatName} | ${noteDate} | from ${senderLabel}\nSummary: ${note.raw_summary}`;
    const bodyChunks = chunkText(row.body);
    const pieces = bodyChunks.length > 0 ? bodyChunks : [note.raw_summary || row.body];
    const contents = pieces.map((p, i) => (i === 0 ? `${header}\n\n${p}` : p));
    const vectors = await provider.embedBatch(contents);
    const rows = contents.map((content, i) => ({
      user_email,
      card_id,
      note_id: noteRow.id,
      chunk_index: i,
      content,
      embedding: vectors[i],
      embed_model: `${provider.provider}:${provider.model}`,
    }));
    const { error: chunkErr } = await admin.from('note_chunk').insert(rows);
    if (chunkErr) throw new Error(`chunk insert: ${chunkErr.message}`);

    await admin
      .from('slack_message')
      .update({
        processed_at: new Date().toISOString(),
        process_error: null,
        permalink: sourceUrl,
      })
      .eq('id', row.id);

    return { ok: true };
  } catch (err) {
    await admin
      .from('slack_message')
      .update({ process_error: String(err.message || err) })
      .eq('id', row.id);
    throw err;
  }
}

// Page through this user's unprocessed messages at/after a floor timestamp,
// oldest first. Returns the newest msg_timestamp seen.
async function processSince(acct, provider, token, floorIso, runPool, concurrency) {
  const page = 200;
  let newest = floorIso;
  for (;;) {
    let q = admin
      .from('slack_message')
      .select('*')
      .eq('user_email', acct.user_email)
      .is('processed_at', null)
      .order('msg_timestamp', { ascending: true })
      .limit(page);
    if (floorIso) q = q.gte('msg_timestamp', floorIso);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;

    await runPool(data, concurrency, async (row) => {
      try {
        await processOne(acct, provider, token, row);
        if (row.msg_timestamp > newest) newest = row.msg_timestamp;
      } catch (err) {
        console.error(`[${acct.user_email}/slack] msg ${row.slack_msg_ts}:`, err.message);
      }
    });

    if (data.length < page) break;
  }
  return newest;
}

export async function ingestSlackBackfill(acct, provider, token, runPool, concurrency) {
  const floorIso =
    acct.slack_backfill_after ||
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const newest = await processSince(acct, provider, token, floorIso, runPool, concurrency);
  await admin
    .from('sync_state')
    .update({
      backfill_done: true,
      slack_last_processed_ts: newest,
      updated_at: new Date().toISOString(),
    })
    .eq('id', acct.id);
}

export async function ingestSlackDelta(acct, provider, token, runPool, concurrency) {
  if (!acct.backfill_done) {
    console.log(`[${acct.user_email}/slack] backfill not done — running backfill first`);
    return ingestSlackBackfill(acct, provider, token, runPool, concurrency);
  }
  const floorIso = acct.slack_last_processed_ts || acct.slack_backfill_after || null;
  const newest = await processSince(acct, provider, token, floorIso, runPool, concurrency);
  await admin
    .from('sync_state')
    .update({ slack_last_processed_ts: newest, updated_at: new Date().toISOString() })
    .eq('id', acct.id);
}

// Note-id generator mirroring the other pipelines', with a 'slack' source.
async function nextNoteId(userEmail, noteDate, source) {
  const { count } = await admin
    .from('memory_note')
    .select('id', { count: 'exact', head: true })
    .eq('user_email', userEmail)
    .eq('note_date', noteDate)
    .eq('source', source);
  const seq = String((count || 0) + 1).padStart(3, '0');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${noteDate.replace(/-/g, '')}-${source}-${seq}-${rand}`;
}
