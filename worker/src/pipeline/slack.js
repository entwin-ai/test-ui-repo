import { admin } from '../lib/supabase.js';
import {
  decomposeSlackDayFacets,
  slackUpdatesGistAndFailsafe,
} from '../lib/prompts.js';
import { chunkText } from '../lib/chunk.js';
import { resolveEntitiesForNote } from '../lib/resolver.js';
import { appendRollup } from './ingest.js';
import {
  classifyMany,
  TIER_IGNORE,
  TIER_UPDATES,
  TIER_IMPORTANT,
} from '../lib/slack-classification.js';
import { createSlackEntityRegistry } from '../lib/slack-entities.js';
import {
  listConversations,
  channelHistory,
  userName,
  permalink,
  tsToIso,
} from '../lib/slack.js';

// Slack ingestion — both halves run in the GitHub Actions worker.
//
// This is the FULL Slack Ingestion Read Me implementation: a three-tier,
// entity-day, facet-decomposition pipeline mirroring WhatsApp's shape (Read Me
// preamble: Slack "follows closely" WhatsApp's two-tier Kanban shape and
// entity-day boundary).
//
//   * CAPTURE (captureSlack): enumerate every readable conversation, harvest its
//     entity metadata into slack_entity (identity keyed to a durable platform ID,
//     Read Me §2), FILTER bot/system posts BEFORE classification (Read Me §10),
//     and drain the last month of real messages + attachments into the
//     slack_message ledger.
//   * VECTORIZE (ingestSlackBackfill / ingestSlackDelta): bucket unprocessed
//     rows by (entity, calendar day) — the fixed outer boundary (Read Me §1) —
//     classify each entity once (Read Me §3-5), then route the entity-day:
//        Ignore    -> write NOTHING (Read Me §4)
//        Updates   -> one gist line per channel-day, unless a failsafe fires
//                     (Read Me §5, §6)
//        Important -> one facet-split Memory Note per facet, plus a linked note
//                     per attachment (Read Me §1, §3, §9), with thread continuity
//                     preserved through action_edges across days (Read Me §1).
//
// Entry points (called from worker/src/index.js):
//   * captureSlack(acct, token, authedUserId)   — pull month + build entities
//   * ingestSlackBackfill(acct, provider, token, runPool, concurrency, authedUserId)
//   * ingestSlackDelta(acct, provider, token, runPool, concurrency, authedUserId)
//   * reprocessSlackEntityAsImportant(...)      — Kanban Updates->Important move

// Read Me §10 — bot posts (CI, issue-tracker, other integrations) and system
// messages are filtered AHEAD of the tier classification step, so a bot-heavy
// channel's automated traffic never reaches facet decomposition or the Updates
// gist. Applied at CAPTURE time so bot traffic never even lands in the ledger.
function isBotOrSystem(m) {
  const systemSubtypes = new Set([
    'channel_join',
    'channel_leave',
    'channel_topic',
    'channel_purpose',
    'channel_name',
    'channel_archive',
    'channel_unarchive',
    'group_join',
    'group_leave',
    'bot_add',
    'bot_remove',
    'bot_message',
    'reminder_add',
    'tombstone',
  ]);
  if (m.subtype && systemSubtypes.has(m.subtype)) return true;
  if (m.bot_id && !m.user) return true;
  if (m.subtype === 'bot_message') return true;
  if (m.app_id && !m.user) return true;
  return false;
}

// Extract attachment/file metadata Read Me §9 wants persisted. Slack files live
// on m.files; legacy message attachments on m.attachments.
function extractAttachments(m) {
  const out = [];
  if (Array.isArray(m.files)) {
    for (const f of m.files) {
      if (!f) continue;
      out.push({
        id: f.id || null,
        name: f.name || f.title || 'file',
        title: f.title || f.name || null,
        mimetype: f.mimetype || f.filetype || null,
        url: f.permalink || f.url_private || null,
      });
    }
  }
  if (Array.isArray(m.attachments)) {
    for (const a of m.attachments) {
      if (!a || (!a.title && !a.text && !a.fallback)) continue;
      out.push({
        id: a.id != null ? String(a.id) : null,
        name: a.title || a.fallback || 'attachment',
        title: a.title || null,
        mimetype: 'application/vnd.slack.attachment',
        url: a.title_link || a.from_url || null,
        text: a.text || a.fallback || null,
      });
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// CAPTURE
// -----------------------------------------------------------------------------
export async function captureSlack(acct, token, authedUserId) {
  const { user_email, card_id } = acct;

  const floorIso =
    acct.slack_backfill_after ||
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const oldest = String(Math.floor(new Date(floorIso).getTime() / 1000));

  // Include archived so the classifier can read the live archived state (§4).
  const conversations = await listConversations(token, { includeArchived: true });

  const registry = createSlackEntityRegistry();
  const nameCache = new Map();
  let captured = 0;

  for (const conv of conversations) {
    const rec = registry.ingestConversation(conv);
    const entityType = rec?.slack_entity_type || null;

    // Read Me §4 — an archived entity produces NOTHING and isn't on the Kanban.
    // Skip pulling its history entirely.
    if (conv.is_archived === true) continue;

    for await (const page of channelHistory(token, conv.id, oldest)) {
      const rows = [];
      for (const m of page) {
        if (m.type !== 'message') continue;
        if (isBotOrSystem(m)) continue; // Read Me §10

        const attachments = extractAttachments(m);
        if (!m.text && attachments.length === 0) continue;

        const senderId = m.user || null;
        let senderName = null;
        if (senderId) {
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
          channel_name: rec?.display_name || conv.name || conv.id,
          channel_type: legacyChannelType(conv),
          slack_entity_type: entityType,
          sender: senderId,
          sender_name: senderName,
          from_me: Boolean(authedUserId && m.user === authedUserId),
          msg_timestamp: tsToIso(m.ts),
          body: m.text || '',
          attachments,
          permalink: null,
        });
      }

      if (rows.length > 0) {
        const { error, count } = await admin.from('slack_message').upsert(rows, {
          onConflict: 'user_email,channel_id,slack_msg_ts',
          ignoreDuplicates: true,
          count: 'exact',
        });
        if (error) {
          if (/attachments|slack_entity_type/.test(error.message) && /schema cache|column/.test(error.message)) {
            const trimmed = rows.map(({ attachments, slack_entity_type, ...rest }) => rest);
            const { error: e2, count: c2 } = await admin.from('slack_message').upsert(trimmed, {
              onConflict: 'user_email,channel_id,slack_msg_ts',
              ignoreDuplicates: true,
              count: 'exact',
            });
            if (e2) console.error(`[${user_email}/slack] capture ${conv.id}:`, e2.message);
            else captured += c2 || 0;
          } else {
            console.error(`[${user_email}/slack] capture ${conv.id}:`, error.message);
          }
        } else {
          captured += count || 0;
        }
      }
    }
  }

  await upsertEntities(user_email, card_id, registry.toRows(user_email, card_id));
  return captured;
}

function legacyChannelType(c) {
  if (c.is_im) return 'im';
  if (c.is_mpim) return 'mpim';
  if (c.is_private) return 'private';
  return 'public';
}

async function upsertEntities(userEmail, cardId, rows) {
  if (!rows || rows.length === 0) return;
  const { error } = await admin
    .from('slack_entity')
    .upsert(rows, { onConflict: 'user_email,card_id,identity_key' });
  if (error && !/slack_entity/.test(error.message)) {
    console.error(`[${userEmail}/slack] entity upsert:`, error.message);
  }
}

// -----------------------------------------------------------------------------
// Identity + day helpers
// -----------------------------------------------------------------------------
function identityKeyForRow(row) {
  if (row.slack_entity_type === 'individual') return row.sender || row.channel_id;
  return row.channel_id;
}

function dayOf(row) {
  return new Date(row.msg_timestamp).toISOString().slice(0, 10);
}

function renderTranscript(rows) {
  return rows
    .slice()
    .sort((a, b) => new Date(a.msg_timestamp) - new Date(b.msg_timestamp))
    .map((r) => {
      const who = r.from_me ? 'me' : r.sender_name || r.sender || 'unknown';
      const atts =
        Array.isArray(r.attachments) && r.attachments.length
          ? ` [attachments: ${r.attachments.map((a) => a.name).join(', ')}]`
          : '';
      return `${who}: ${r.body || ''}${atts}`.trim();
    })
    .filter(Boolean)
    .join('\n');
}

// Deterministic @mention detection (Read Me §6): Slack renders a mention of the
// authorizing user as <@Uxxxx> in raw text. Checked in code alongside the LLM.
function mentionsUser(rows, authedUserId) {
  if (!authedUserId) return false;
  const token = `<@${authedUserId}`;
  return rows.some((r) => typeof r.body === 'string' && r.body.includes(token));
}

async function markRowsProcessed(ids, patch) {
  if (!ids || ids.length === 0) return;
  let { error } = await admin.from('slack_message').update(patch).in('id', ids);
  if (error && /slack_tier|slack_tier_reason/.test(error.message) && /schema cache|column/.test(error.message)) {
    const { slack_tier, slack_tier_reason, ...rest } = patch;
    ({ error } = await admin.from('slack_message').update(rest).in('id', ids));
  }
  if (error) throw new Error(`slack_message update: ${error.message}`);
}

async function markRowsError(ids, message) {
  if (!ids || ids.length === 0) return;
  try {
    await admin.from('slack_message').update({ process_error: String(message) }).in('id', ids);
  } catch {
    /* best-effort */
  }
}

// -----------------------------------------------------------------------------
// Write one Memory Note (one facet) + resolve entities + chunk/embed.
// -----------------------------------------------------------------------------
async function writeNoteForFacet(acct, provider, token, { anchorRow, chatName, noteDate, facet }) {
  const { user_email, card_id } = acct;
  const noteId = await nextNoteId(user_email, noteDate, 'slack');

  let sourceUrl = anchorRow.permalink;
  if (!sourceUrl && token) {
    sourceUrl = await permalink(token, anchorRow.channel_id, anchorRow.slack_msg_ts);
  }

  const related = Array.isArray(facet.related_entities) ? facet.related_entities : [];

  const { data: noteRow, error: noteErr } = await admin
    .from('memory_note')
    .insert({
      user_email,
      card_id,
      note_id: noteId,
      slack_message_id: anchorRow.id,
      gmail_msg_id: null,
      source: 'slack',
      source_ref: anchorRow.slack_msg_ts,
      note_date: noteDate,
      name: chatName,
      raw_summary: facet.raw_summary,
      urgency: facet.urgency,
      life_domain: facet.life_domain,
      action: facet.action,
      free_text: facet.free_text,
      confidentiality: facet.confidentiality,
      related_entities: related,
      source_url: sourceUrl,
    })
    .select()
    .single();
  if (noteErr) throw new Error(`note insert: ${noteErr.message}`);

  try {
    await resolveEntitiesForNote(user_email, noteRow.id, related, noteDate);
  } catch (err) {
    console.error(`[${user_email}] slack resolver:`, err.message);
  }

  const header = `Slack — ${chatName} | ${noteDate}\nSummary: ${facet.raw_summary}`;
  const facetBody = [facet.raw_summary, facet.free_text].filter(Boolean).join('\n\n');
  const bodyChunks = chunkText(facetBody);
  const pieces = bodyChunks.length > 0 ? bodyChunks : [facet.raw_summary || ''];
  const contents = pieces.map((p, i) => (i === 0 ? `${header}\n\n${p}` : p));
  const vectors = await provider.embedBatch(contents);
  const chunkRows = contents.map((content, i) => ({
    user_email,
    card_id,
    note_id: noteRow.id,
    chunk_index: i,
    content,
    embedding: vectors[i],
    embed_model: `${provider.provider}:${provider.model}`,
  }));
  const { error: chunkErr } = await admin.from('note_chunk').insert(chunkRows);
  if (chunkErr) throw new Error(`chunk insert: ${chunkErr.message}`);

  return noteRow.id;
}

// Read Me §9 — each attachment in Important-tier activity gets its OWN linked
// Memory Note with a locator back to the parent message + thread.
async function writeAttachmentNotes(acct, provider, token, rows) {
  const { user_email, card_id } = acct;
  const withAtt = rows.filter((r) => Array.isArray(r.attachments) && r.attachments.length > 0);
  const noteIds = [];
  for (const row of withAtt) {
    let parentUrl = row.permalink;
    if (!parentUrl && token) {
      parentUrl = await permalink(token, row.channel_id, row.slack_msg_ts);
    }
    const noteDate = dayOf(row);
    for (const att of row.attachments) {
      try {
        const noteId = await nextNoteId(user_email, noteDate, 'slack');
        const label = att.title || att.name || 'attachment';
        const summary = `Attachment shared in ${row.channel_name || row.channel_id}: ${label}`;
        const locator = `Attachment "${label}"${att.mimetype ? ` (${att.mimetype})` : ''} shared in ${
          row.channel_name || row.channel_id
        }. Locator: parent message ${row.slack_msg_ts}${parentUrl ? ` — ${parentUrl}` : ''}.${
          att.text ? `\n\n${att.text}` : ''
        }`;
        const base = {
          user_email,
          card_id,
          note_id: noteId,
          slack_message_id: row.id,
          gmail_msg_id: null,
          source: 'slack',
          source_ref: row.slack_msg_ts,
          note_date: noteDate,
          name: `${row.channel_name || row.channel_id} · ${label}`,
          raw_summary: summary,
          urgency: 'low',
          life_domain: 'professional',
          action: [],
          free_text: locator,
          confidentiality: 'blank',
          related_entities: [],
          source_url: att.url || parentUrl || null,
        };
        let noteRow;
        const ins = await admin
          .from('memory_note')
          .insert({ ...base, slack_is_attachment: true })
          .select()
          .single();
        if (ins.error) {
          if (/slack_is_attachment/.test(ins.error.message)) {
            const ins2 = await admin.from('memory_note').insert(base).select().single();
            if (ins2.error) throw new Error(ins2.error.message);
            noteRow = ins2.data;
          } else {
            throw new Error(ins.error.message);
          }
        } else {
          noteRow = ins.data;
        }
        noteIds.push(noteRow.id);
        await embedAttachmentNote(acct, provider, noteRow.id, summary, locator);
      } catch (err) {
        console.error(`[${user_email}/slack] attachment note:`, err.message);
      }
    }
  }
  return noteIds;
}

async function embedAttachmentNote(acct, provider, noteId, summary, locator) {
  const { user_email, card_id } = acct;
  const content = `${summary}\n\n${locator}`;
  const vectors = await provider.embedBatch([content]);
  await admin.from('note_chunk').insert({
    user_email,
    card_id,
    note_id: noteId,
    chunk_index: 0,
    content,
    embedding: vectors[0],
    embed_model: `${provider.provider}:${provider.model}`,
  });
}

// Read Me §1 — thread continuity across day boundaries via action_edges. Link
// this day's notes symmetrically to the entity's prior-day Slack notes.
// Immutable: earlier notes are only edge-linked, never reopened.
async function linkThreadAcrossDays(userEmail, entityChannelId, newNoteIds) {
  if (!newNoteIds || newNoteIds.length === 0) return;
  try {
    const { data: priorRows } = await admin
      .from('slack_message')
      .select('id')
      .eq('user_email', userEmail)
      .eq('channel_id', entityChannelId);
    const ledgerIds = (priorRows || []).map((r) => r.id);
    if (ledgerIds.length === 0) return;

    const { data: priorNotes } = await admin
      .from('memory_note')
      .select('id, action_edges')
      .eq('user_email', userEmail)
      .eq('source', 'slack')
      .in('slack_message_id', ledgerIds);
    const priors = (priorNotes || []).filter((n) => !newNoteIds.includes(n.id));
    if (priors.length === 0) return;

    const priorIds = priors.map((n) => n.id);
    for (const newId of newNoteIds) {
      await admin.from('memory_note').update({ action_edges: priorIds }).eq('id', newId);
    }
    for (const p of priors) {
      const edges = new Set(p.action_edges || []);
      for (const newId of newNoteIds) edges.add(newId);
      await admin.from('memory_note').update({ action_edges: [...edges] }).eq('id', p.id);
    }
  } catch (err) {
    console.error(`[${userEmail}/slack] action_edges:`, err.message);
  }
}

// -----------------------------------------------------------------------------
// Process ONE entity-day bucket, routed by tier.
// -----------------------------------------------------------------------------
async function processEntityDay(acct, provider, token, authedUserId, { rows, tier, tierReason }) {
  const { user_email } = acct;
  const ids = rows.map((r) => r.id);
  const anchorRow = rows[rows.length - 1];
  const noteDate = dayOf(anchorRow);
  const chatName = anchorRow.channel_name || anchorRow.channel_id;
  const entityType = anchorRow.slack_entity_type || 'closed_channel';

  // Ignore -> write nothing (Read Me §4). No audit rollup.
  if (tier === TIER_IGNORE) {
    await markRowsProcessed(ids, {
      processed_at: new Date().toISOString(),
      process_error: null,
      slack_tier: TIER_IGNORE,
      slack_tier_reason: tierReason,
    });
    return { ignored: rows.length };
  }

  const transcript = renderTranscript(rows);

  try {
    if (tier === TIER_UPDATES) {
      // Read Me §6 — dual failsafe: deterministic @mention in code + LLM judgment.
      const codeMention = mentionsUser(rows, authedUserId);
      const { gist, mentioned, urgent } = await slackUpdatesGistAndFailsafe(provider, user_email, {
        chatName,
        date: noteDate,
        transcript,
      });
      const anyMention = codeMention || mentioned;

      if (!anyMention && !urgent) {
        await appendRollup(acct, new Date(noteDate), 'slack_updates', {
          entity: chatName,
          identity_key: identityKeyForRow(anchorRow),
          channel_id: anchorRow.channel_id,
          gist: gist || '(no summary)',
          messages: rows.length,
        });
        await markRowsProcessed(ids, {
          processed_at: new Date().toISOString(),
          process_error: null,
          slack_tier: TIER_UPDATES,
          slack_tier_reason: tierReason,
        });
        return { ok: true, tier: TIER_UPDATES, gist: true, messages: rows.length };
      }

      // Failsafe fired -> reroute into the full facet path as Important (§6).
      tier = TIER_IMPORTANT;
      tierReason = anyMention ? 'updates-failsafe-mention' : 'updates-failsafe-urgent';
    }

    const facets = await decomposeSlackDayFacets(provider, user_email, {
      chatName,
      date: noteDate,
      entityType,
      transcript,
    });
    const effective = facets.length > 0 ? facets : [fallbackFacet(transcript)];

    const newNoteIds = [];
    for (const facet of effective) {
      const id = await writeNoteForFacet(acct, provider, token, {
        anchorRow,
        chatName,
        noteDate,
        facet,
      });
      newNoteIds.push(id);
    }

    const attNoteIds = await writeAttachmentNotes(acct, provider, token, rows);
    newNoteIds.push(...attNoteIds);

    await linkThreadAcrossDays(user_email, anchorRow.channel_id, newNoteIds);

    await markRowsProcessed(ids, {
      processed_at: new Date().toISOString(),
      process_error: null,
      slack_tier: tier,
      slack_tier_reason: tierReason,
    });
    return { ok: true, tier, messages: rows.length };
  } catch (err) {
    await markRowsError(ids, err.message || err);
    throw err;
  }
}

function fallbackFacet(transcript) {
  return {
    raw_summary: transcript.slice(0, 200),
    urgency: 'low',
    life_domain: 'professional',
    action: [],
    free_text: '',
    confidentiality: 'blank',
    related_entities: [],
  };
}

// -----------------------------------------------------------------------------
// Page through unprocessed rows, bucket by (entity, day), classify once, process.
// -----------------------------------------------------------------------------
async function processSince(acct, provider, token, authedUserId, floorIso, runPool, concurrency) {
  const page = 500;
  let newest = floorIso;

  const buckets = new Map();
  let cursorFloor = floorIso;
  for (;;) {
    let q = admin
      .from('slack_message')
      .select('*')
      .eq('user_email', acct.user_email)
      .is('processed_at', null)
      .order('msg_timestamp', { ascending: true })
      .limit(page);
    if (cursorFloor) q = q.gte('msg_timestamp', cursorFloor);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;

    for (const row of data) {
      if (row.msg_timestamp > newest) newest = row.msg_timestamp;
      const identityKey = identityKeyForRow(row);
      const key = `${identityKey}\u0000${dayOf(row)}`;
      let b = buckets.get(key);
      if (!b) {
        b = { identityKey, rows: [] };
        buckets.set(key, b);
      }
      b.rows.push(row);
    }

    if (data.length < page) break;
    cursorFloor = data[data.length - 1].msg_timestamp;
  }

  if (buckets.size === 0) return newest;

  const identityKeys = Array.from(new Set([...buckets.values()].map((b) => b.identityKey)));
  const tierByKey = await classifyMany(acct.user_email, identityKeys, { cardId: acct.card_id });

  const work = [...buckets.values()];
  await runPool(work, concurrency, async (bucket) => {
    const decision = tierByKey.get(bucket.identityKey) || {
      tier: TIER_IMPORTANT,
      reason: 'unclassified-default',
    };
    try {
      await processEntityDay(acct, provider, token, authedUserId, {
        rows: bucket.rows,
        tier: decision.tier,
        tierReason: decision.reason,
      });
    } catch (err) {
      console.error(
        `[${acct.user_email}/slack] entity-day ${bucket.identityKey} ${dayOf(bucket.rows[0])}:`,
        err.message,
      );
    }
  });

  return newest;
}

export async function ingestSlackBackfill(acct, provider, token, runPool, concurrency, authedUserId = null) {
  const floorIso =
    acct.slack_backfill_after ||
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const newest = await processSince(acct, provider, token, authedUserId, floorIso, runPool, concurrency);
  await admin
    .from('sync_state')
    .update({
      backfill_done: true,
      slack_last_processed_ts: newest,
      updated_at: new Date().toISOString(),
    })
    .eq('id', acct.id);
}

export async function ingestSlackDelta(acct, provider, token, runPool, concurrency, authedUserId = null) {
  if (!acct.backfill_done) {
    console.log(`[${acct.user_email}/slack] backfill not done — running backfill first`);
    return ingestSlackBackfill(acct, provider, token, runPool, concurrency, authedUserId);
  }
  const floorIso = acct.slack_last_processed_ts || acct.slack_backfill_after || null;
  const newest = await processSince(acct, provider, token, authedUserId, floorIso, runPool, concurrency);
  await admin
    .from('sync_state')
    .update({ slack_last_processed_ts: newest, updated_at: new Date().toISOString() })
    .eq('id', acct.id);
}

// ---------------------------------------------------------------------------
// Kanban Updates -> Important MOVE BACKFILL (Read Me §8).
// ---------------------------------------------------------------------------
export async function reprocessSlackEntityAsImportant(acct, provider, token, identityKey, runPool, concurrency) {
  const { user_email, card_id } = acct;

  const pageSize = 1000;
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await admin
      .from('slack_message')
      .select('*')
      .eq('user_email', user_email)
      .eq('card_id', card_id)
      .order('msg_timestamp', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const r of data) {
      if (identityKeyForRow(r) === identityKey) rows.push(r);
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }
  if (rows.length === 0) {
    console.log(`[${user_email}/slack] move-backfill ${identityKey}: no messages`);
    return { days: 0, messages: 0 };
  }

  const rowIds = rows.map((r) => r.id);
  const { data: oldNotes } = await admin
    .from('memory_note')
    .select('id')
    .eq('user_email', user_email)
    .eq('source', 'slack')
    .in('slack_message_id', rowIds);
  const oldNoteIds = (oldNotes || []).map((n) => n.id);
  if (oldNoteIds.length > 0) {
    await admin.from('note_chunk').delete().eq('user_email', user_email).in('note_id', oldNoteIds);
    await admin.from('memory_note').delete().eq('user_email', user_email).in('id', oldNoteIds);
  }

  const days = Array.from(new Set(rows.map((r) => dayOf(r))));
  await removeEntityFromRollups(acct, identityKey, days);

  const buckets = new Map();
  for (const r of rows) {
    const key = dayOf(r);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  const work = [...buckets.values()];
  await runPool(work, concurrency, async (dayRows) => {
    try {
      await processEntityDay(acct, provider, token, null, {
        rows: dayRows,
        tier: TIER_IMPORTANT,
        tierReason: 'moved-updates-to-important',
      });
    } catch (err) {
      console.error(`[${user_email}/slack] move-backfill day ${dayOf(dayRows[0])}:`, err.message);
    }
  });

  console.log(
    `[${user_email}/slack] move-backfill ${identityKey}: ${buckets.size} days, ${rows.length} messages re-expanded`,
  );
  return { days: buckets.size, messages: rows.length };
}

async function removeEntityFromRollups(acct, identityKey, days) {
  const { user_email, card_id } = acct;
  for (const day of days) {
    try {
      const { data: roll } = await admin
        .from('daily_rollup')
        .select('id, entries')
        .eq('user_email', user_email)
        .eq('card_id', card_id)
        .eq('rollup_date', day)
        .eq('kind', 'slack_updates')
        .maybeSingle();
      if (!roll || !Array.isArray(roll.entries)) continue;
      const kept = roll.entries.filter((e) => e && e.identity_key !== identityKey);
      if (kept.length === roll.entries.length) continue;
      await admin
        .from('daily_rollup')
        .update({ entries: kept, entry_count: kept.length, updated_at: new Date().toISOString() })
        .eq('id', roll.id);
    } catch (err) {
      console.error(`[${user_email}/slack] rollup cleanup ${day}:`, err.message);
    }
  }
}

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
