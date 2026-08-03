import { admin } from '../lib/supabase.js';
import { writeChatNoteAndEntities } from '../lib/prompts.js';
import { chunkText } from '../lib/chunk.js';
import { resolveEntitiesForNote } from '../lib/resolver.js';

// WhatsApp ingestion — the vectorize half of the WhatsApp connector.
//
// The persistent Next server (lib/whatsapp/service.ts) captures raw messages
// into the whatsapp_message table. This module, run by the GitHub Actions
// worker, turns UNPROCESSED whatsapp_message rows into the same Memory Note +
// entity + embedding artifacts the Gmail pipeline produces — so WhatsApp is
// queryable via RAG and drawn on the memory map, unified with email by entity.
//
// Two entry points:
//   * ingestWhatsappBackfill(acct, provider): first run — process every message
//     from the last 1 month (>= sync_state.wa_backfill_after), then mark
//     backfill_done and set the delta high-water mark.
//   * ingestWhatsappDelta(acct, provider): hourly — process everything captured
//     since the last high-water mark.
//
// Both share processOne() and are idempotent: a message whose memory_note
// already exists is skipped, and processed_at gates re-processing.

const isGroupJid = (jid) => typeof jid === 'string' && jid.endsWith('@g.us');

// Turn one whatsapp_message row into a memory note + chunks + entities.
async function processOne(acct, provider, row) {
  const { user_email, card_id } = acct;

  // Already vectorized? (defensive — the query already filters processed_at)
  if (row.processed_at) return { skipped: true };

  const noteDate = new Date(row.msg_timestamp).toISOString().slice(0, 10);
  const chatName = row.chat_name || row.sender_name || row.chat_id;
  const senderLabel = row.from_me ? 'me' : row.sender_name || row.sender || row.chat_id;

  try {
    // MERGED single LLM call: note fields + related_entities together, chat framing.
    const { note, related } = await writeChatNoteAndEntities(provider, user_email, {
      chatName,
      sender: senderLabel,
      body: row.body,
      date: noteDate,
      isGroup: isGroupJid(row.chat_id),
    });

    const noteId = await nextNoteId(user_email, noteDate, 'whatsapp');

    // Deep-link back into WhatsApp for the source chip. wa.me opens the chat.
    const phoneOrGroup = String(row.chat_id || '').split('@')[0];
    const sourceUrl = isGroupJid(row.chat_id)
      ? null
      : phoneOrGroup
      ? `https://wa.me/${phoneOrGroup}`
      : null;

    const { data: noteRow, error: noteErr } = await admin
      .from('memory_note')
      .insert({
        user_email,
        card_id,
        note_id: noteId,
        wa_message_id: row.id,          // link to the WhatsApp ledger row
        gmail_msg_id: null,             // not an email note
        source: 'whatsapp',
        source_ref: row.wa_msg_id,
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

    // Entity/graph layer — SAME resolver as email. This is the cross-channel
    // unification point: a person named here resolves to the same entity row as
    // when they appear in an email, so the memory map shows one bubble.
    try {
      await resolveEntitiesForNote(user_email, noteRow.id, related, noteDate);
    } catch (err) {
      console.error(`[${user_email}] wa resolver:`, err.message);
    }

    // RAG embeddings — same note_chunk table + ivfflat index as email, so
    // hybrid retrieval spans both channels with no query change.
    const header = `WhatsApp — ${chatName} | ${noteDate} | from ${senderLabel}\nSummary: ${note.raw_summary}`;
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
      .from('whatsapp_message')
      .update({ processed_at: new Date().toISOString(), process_error: null })
      .eq('id', row.id);

    return { ok: true };
  } catch (err) {
    await admin
      .from('whatsapp_message')
      .update({ process_error: String(err.message || err) })
      .eq('id', row.id);
    throw err;
  }
}

// Page through this user's unprocessed messages at/after a floor timestamp,
// oldest first, processing each. Returns the newest msg_timestamp seen.
async function processSince(acct, provider, floorIso, runPool, concurrency) {
  const page = 200;
  let newest = floorIso;
  for (;;) {
    let q = admin
      .from('whatsapp_message')
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
        await processOne(acct, provider, row);
        if (row.msg_timestamp > newest) newest = row.msg_timestamp;
      } catch (err) {
        console.error(`[${acct.user_email}/wa] msg ${row.wa_msg_id}:`, err.message);
      }
    });

    if (data.length < page) break;
  }
  return newest;
}

export async function ingestWhatsappBackfill(acct, provider, runPool, concurrency) {
  // Floor at the 1-month window set when the number was linked. If missing
  // (older row), default to 30 days back.
  const floorIso =
    acct.wa_backfill_after || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const newest = await processSince(acct, provider, floorIso, runPool, concurrency);

  await admin
    .from('sync_state')
    .update({
      backfill_done: true,
      wa_last_processed_ts: newest,
      updated_at: new Date().toISOString(),
    })
    .eq('id', acct.id);
}

export async function ingestWhatsappDelta(acct, provider, runPool, concurrency) {
  if (!acct.backfill_done) {
    console.log(`[${acct.user_email}/wa] backfill not done — running backfill first`);
    return ingestWhatsappBackfill(acct, provider, runPool, concurrency);
  }
  // Process everything captured since the high-water mark. We still filter on
  // processed_at IS NULL, so the timestamp floor is just an optimization.
  const floorIso = acct.wa_last_processed_ts || acct.wa_backfill_after || null;
  const newest = await processSince(acct, provider, floorIso, runPool, concurrency);
  await admin
    .from('sync_state')
    .update({ wa_last_processed_ts: newest, updated_at: new Date().toISOString() })
    .eq('id', acct.id);
}

// Note-id generator mirroring the email pipeline's, with a 'whatsapp' source.
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
