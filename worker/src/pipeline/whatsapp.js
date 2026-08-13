import { admin } from '../lib/supabase.js';
import {
  decomposeChatDayFacets,
  updatesGistAndFailsafe,
} from '../lib/prompts.js';
import { chunkText } from '../lib/chunk.js';
import { resolveEntitiesForNote, recordResolvedEntity } from '../lib/resolver.js';
import { resolveWhatsappContact } from '../lib/wa-resolver.js';
import { appendRollup } from './ingest.js';
import { classifyMany, TIER_IGNORE, TIER_UPDATES, TIER_IMPORTANT } from '../lib/wa-classification.js';

// WhatsApp ingestion — the vectorize half of the WhatsApp connector.
//
// -----------------------------------------------------------------------------
// Phase 3: entity-day batching + facet decomposition.
// -----------------------------------------------------------------------------
// The old shape was one whatsapp_message row -> one Memory Note. The WhatsApp
// Ingestion Read Me (§1) requires a different note boundary: a coherent day's
// exchange for ONE entity is read ONCE and decomposed by FACET (topic+intent),
// producing one note per facet — not one per message, and not one per day by
// default. So this module now:
//
//   1. Pulls the run's unprocessed messages and BUCKETS them by
//      (identity_key, calendar-day) before any LLM call.
//   2. Classifies each entity once (Phase 2 wa-classification):
//        Ignore    -> write NOTHING; mark the day's rows processed (Read Me §4)
//        Important -> decompose the day into facets; one Memory Note per facet
//        Updates   -> collapse the day to ONE note (no facet split). This is the
//                     Phase 3 BRIDGE; Phase 4 replaces it with the gist-line
//                     rollup + dual failsafe.
//   3. For each produced note runs the SAME v5 path as before — insert
//      memory_note, resolve entities (cross-channel unification), chunk+embed —
//      so WhatsApp notes still land in one entity graph + one RAG index.
//
// Idempotency is preserved: every constituent message row of a processed
// entity-day is stamped processed_at, so a re-run never re-buckets it. The
// backfill/delta high-water-mark bookkeeping in the two entry points is
// unchanged.

const isGroupJid = (jid) => typeof jid === 'string' && jid.endsWith('@g.us');

// Derive the stable identity key for a message row the SAME way the entity
// collector (wa-entities.js) and the classifier do.
function identityKeyForRow(row) {
  const jid = row.chat_id || '';
  if (isGroupJid(jid)) return jid;
  const user = String(jid).split('@')[0].split(':')[0].split('.')[0];
  return /^\d{6,15}$/.test(user) ? `+${user}` : jid;
}

function dayOf(row) {
  return new Date(row.msg_timestamp).toISOString().slice(0, 10);
}

// True when a stored label is really just the phone number (the "weird looking
// phone number" we want to stop surfacing), so we know to look for a real name.
function isPhoneLabel(s) {
  return typeof s === 'string' && /^\+?\d[\d\s()\-]{4,}$/.test(s.trim());
}

// Best human label for an entity-day. Prefers the display name persisted on
// whatsapp_entity (harvested from the contact/pushName the user actually sees),
// then a non-numeric chat/sender name off the row, and only falls back to the
// bare phone/jid when nothing better exists. This upgrades BOTH freshly captured
// rows and rows captured before the name harvest shipped.
async function resolveEntityLabel(userEmail, anchorRow) {
  const rowName = anchorRow.chat_name || anchorRow.sender_name;
  if (rowName && !isPhoneLabel(rowName)) return rowName;

  const identityKey = identityKeyForRow(anchorRow);
  const { data: meta } = await admin
    .from('whatsapp_entity')
    .select('display_name')
    .eq('user_email', userEmail)
    .eq('identity_key', identityKey)
    .maybeSingle();

  if (meta?.display_name && !isPhoneLabel(meta.display_name)) return meta.display_name;
  return rowName || anchorRow.chat_id;
}

// Update many message rows' processing state at once, stamping the resolved
// tier. Resilient to a not-yet-reloaded schema cache (0017 wa_tier columns).
async function markRowsProcessed(ids, patch) {
  if (!ids || ids.length === 0) return;
  let { error } = await admin.from('whatsapp_message').update(patch).in('id', ids);
  if (error && /wa_tier|wa_tier_reason/.test(error.message) && /schema cache|column/.test(error.message)) {
    const { wa_tier, wa_tier_reason, ...rest } = patch;
    ({ error } = await admin.from('whatsapp_message').update(rest).in('id', ids));
  }
  if (error) throw new Error(`whatsapp_message update: ${error.message}`);
}

async function markRowsError(ids, message) {
  if (!ids || ids.length === 0) return;
  try {
    await admin.from('whatsapp_message').update({ process_error: String(message) }).in('id', ids);
  } catch {
    /* best-effort */
  }
}

// Render an entity-day's messages into a chronological "sender: text" transcript
// for the day-level prompts. from_me rows are labelled "me".
function renderTranscript(rows) {
  return rows
    .slice()
    .sort((a, b) => new Date(a.msg_timestamp) - new Date(b.msg_timestamp))
    .map((r) => {
      const who = r.from_me ? 'me' : r.sender_name || r.sender || 'unknown';
      return `${who}: ${r.body || ''}`.trim();
    })
    .filter(Boolean)
    .join('\n');
}

// Insert one Memory Note (one facet, or one collapsed Updates day) + resolve
// entities + chunk/embed. Shared by both tiers so the v5 write path lives in one
// place. `anchorRow` is the representative ledger row the note links back to
// (the day's last message); `chatName` is the human label.
async function writeNoteForFacet(acct, provider, { anchorRow, chatName, noteDate, facet, contact }) {
  const { user_email, card_id } = acct;

  const noteId = await nextNoteId(user_email, noteDate, 'whatsapp');

  // WhatsApp notes have NO addressable web permalink. A wa.me/<number> link is
  // not a citation to a specific message — it just tries to open a 1:1 chat, and
  // for an unsaved / group / non-WhatsApp number it dead-ends on a "this link is
  // not valid" page. So we deliberately do NOT emit a source_url for WhatsApp:
  // the reference chip renders as a non-clickable "date · WhatsApp" label
  // instead of a broken link. (Provenance still lives on the row via
  // wa_message_id / source_ref below.)
  const sourceUrl = null;

  const related = Array.isArray(facet.related_entities) ? facet.related_entities : [];

  const { data: noteRow, error: noteErr } = await admin
    .from('memory_note')
    .insert({
      user_email,
      card_id,
      note_id: noteId,
      wa_message_id: anchorRow.id,      // link to a representative ledger row
      gmail_msg_id: null,
      source: 'whatsapp',
      source_ref: anchorRow.wa_msg_id,
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

  // Entity/graph layer — SAME resolver as email (cross-channel unification).
  try {
    await resolveEntitiesForNote(user_email, noteRow.id, related, noteDate);
  } catch (err) {
    console.error(`[${user_email}] wa resolver:`, err.message);
  }

  // Phase 6: for a 1:1 contact, also attribute the note to the PHONE-resolved
  // contact entity (resolved once per entity-day, passed in as `contact`). This
  // is the WhatsApp identity — keyed on phone, not name — so a number change is
  // handled by the phone-first resolver rather than the name-based one.
  if (contact && contact.id) {
    try {
      await recordResolvedEntity(user_email, noteRow.id, contact.id, contact.matchedAlias);
    } catch (err) {
      console.error(`[${user_email}] wa contact resolve:`, err.message);
    }
  }

  // RAG embeddings — same note_chunk table + ivfflat index as email. We embed
  // the facet's summary + free_text (the facet's own content), not the whole
  // day, so each note's vectors describe that facet.
  const header = `WhatsApp — ${chatName} | ${noteDate}\nSummary: ${facet.raw_summary}`;
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

// Resolve the 1:1 CONTACT entity for a person entity-day by PHONE (Phase 6). It
// loads the entity's WhatsApp identity facts (phone, durable username) from
// whatsapp_entity and hands them to the phone-first resolver, which owns the
// number-change ordering. Returns { id, matchedAlias } or null.
async function resolveContactForDay(acct, anchorRow, noteDate) {
  const { user_email } = acct;
  const identityKey = identityKeyForRow(anchorRow); // phone for a person
  const { data: meta } = await admin
    .from('whatsapp_entity')
    .select('identity_key, wa_entity_type, display_name, wa_username, username_is_durable')
    .eq('user_email', user_email)
    .eq('identity_key', identityKey)
    .maybeSingle();

  const phone = identityKey; // person identity key IS the phone number
  const display = meta?.display_name || anchorRow.chat_name || anchorRow.sender_name || phone;
  return resolveWhatsappContact(user_email, {
    phone,
    username: meta?.wa_username || null,
    durable: meta?.username_is_durable === true,
    display,
    noteDate,
  });
}

// Process ONE entity-day bucket end to end, routed by its already-computed tier.
async function processEntityDay(acct, provider, { rows, tier, tierReason }) {
  const { user_email } = acct;
  const ids = rows.map((r) => r.id);
  const anchorRow = rows[rows.length - 1]; // day's last message (chronological)
  const noteDate = dayOf(anchorRow);
  const chatName = await resolveEntityLabel(user_email, anchorRow);
  const isGroup = isGroupJid(anchorRow.chat_id);

  // Ignore -> write nothing at all (Read Me §4). Mark the day's rows processed
  // so we don't re-bucket them every run.
  if (tier === TIER_IGNORE) {
    await markRowsProcessed(ids, {
      processed_at: new Date().toISOString(),
      process_error: null,
      wa_tier: TIER_IGNORE,
      wa_tier_reason: tierReason,
    });
    return { ignored: rows.length };
  }

  const transcript = renderTranscript(rows);

  try {
    if (tier === TIER_UPDATES) {
      // ONE narrow call: day gist + dual failsafe (@mention / urgency).
      const { gist, mentioned, urgent } = await updatesGistAndFailsafe(provider, user_email, {
        chatName,
        date: noteDate,
        isGroup,
        transcript,
      });

      if (!mentioned && !urgent) {
        // No failsafe trigger -> write ONE gist line to the day's WhatsApp
        // Updates Note. No Memory Note, no entity resolution, no embeddings
        // (Read Me §3 tier 2, §6). appendRollup keys on
        // (user_email, card_id, rollup_date, kind='wa_updates').
        await appendRollup(acct, new Date(noteDate), 'wa_updates', {
          entity: chatName,
          identity_key: identityKeyForRow(anchorRow),
          gist: gist || '(no summary)',
          messages: rows.length,
        });
        await markRowsProcessed(ids, {
          processed_at: new Date().toISOString(),
          process_error: null,
          wa_tier: TIER_UPDATES,
          wa_tier_reason: tierReason,
        });
        return { ok: true, tier: TIER_UPDATES, gist: true, messages: rows.length };
      }

      // Failsafe fired -> DO NOT write a gist. Reroute this entity-day into the
      // full facet-split pipeline exactly as an Important day (Read Me §6). Fall
      // through to the facet path below with a reason that records why.
      tier = TIER_IMPORTANT;
      tierReason = mentioned ? 'updates-failsafe-mention' : 'updates-failsafe-urgent';
    }

    // Important (or an Updates day the failsafe promoted): decompose into facets;
    // one note per facet.
    const facets = await decomposeChatDayFacets(provider, user_email, {
      chatName,
      date: noteDate,
      isGroup,
      transcript,
    });

    // Phase 6: for a 1:1 (person) chat, resolve the CONTACT by phone once for
    // the whole day, so every facet note attributes to the same phone-keyed
    // entity — and a number change is handled by the phone-first resolver.
    // Groups/communities are not a single person, so no contact resolution.
    let contact = null;
    if (!isGroup) {
      try {
        contact = await resolveContactForDay(acct, anchorRow, noteDate);
      } catch (err) {
        console.error(`[${user_email}/wa] contact resolve ${identityKeyForRow(anchorRow)}:`, err.message);
      }
    }

    const effective = facets.length > 0 ? facets : [fallbackFacet(transcript)];
    for (const facet of effective) {
      await writeNoteForFacet(acct, provider, { anchorRow, chatName, noteDate, facet, contact });
    }

    // All notes for the day written — stamp every constituent row processed.
    await markRowsProcessed(ids, {
      processed_at: new Date().toISOString(),
      process_error: null,
      wa_tier: tier,
      wa_tier_reason: tierReason,
    });
    return { ok: true, tier, messages: rows.length };
  } catch (err) {
    // Leave the day's rows UNprocessed (processed_at stays null) so a later run
    // retries the whole bucket; just record the error for visibility.
    await markRowsError(ids, err.message || err);
    throw err;
  }
}

// A minimal single-facet fallback if the model returns no facets for an
// Important day (should be rare — the prompt requires at least one).
function fallbackFacet(transcript) {
  return {
    raw_summary: transcript.slice(0, 200),
    urgency: 'low',
    life_domain: 'personal',
    action: [],
    free_text: '',
    confidentiality: 'blank',
    related_entities: [],
  };
}

// Page through this user's unprocessed messages at/after a floor timestamp,
// bucket them by (identity_key, day), classify each entity once, and process
// each entity-day. Returns the newest msg_timestamp seen.
async function processSince(acct, provider, floorIso, runPool, concurrency) {
  const page = 500;
  let newest = floorIso;

  // 1. Load all unprocessed rows for the window (paged), collecting into buckets
  //    keyed by `${identityKey}\u0000${day}`. We load fully before processing so
  //    a facet decomposition sees the entity's WHOLE day, not a page fragment.
  const buckets = new Map(); // key -> { identityKey, rows: [] }
  let cursorFloor = floorIso;
  for (;;) {
    let q = admin
      .from('whatsapp_message')
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
    // Advance the cursor past the last row's timestamp to page forward. Equal
    // timestamps are rare; the processed_at filter makes re-reads harmless.
    cursorFloor = data[data.length - 1].msg_timestamp;
  }

  if (buckets.size === 0) return newest;

  // 2. Classify every distinct entity in the window in one batched pass.
  const identityKeys = Array.from(new Set([...buckets.values()].map((b) => b.identityKey)));
  const tierByKey = await classifyMany(acct.user_email, identityKeys, { cardId: acct.card_id });

  // 3. Process each entity-day bucket (bounded concurrency). A failure in one
  //    bucket leaves that day unprocessed for a later retry without blocking
  //    the rest.
  const work = [...buckets.values()];
  await runPool(work, concurrency, async (bucket) => {
    const decision = tierByKey.get(bucket.identityKey) || {
      tier: TIER_IMPORTANT,
      reason: 'unclassified-default',
    };
    try {
      await processEntityDay(acct, provider, {
        rows: bucket.rows,
        tier: decision.tier,
        tierReason: decision.reason,
      });
    } catch (err) {
      console.error(
        `[${acct.user_email}/wa] entity-day ${bucket.identityKey} ${dayOf(bucket.rows[0])}:`,
        err.message,
      );
    }
  });

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

// ---------------------------------------------------------------------------
// Phase 5: Updates -> Important MOVE BACKFILL (Read Me §8).
//
// When the user drags an entity from Updates to Important on the Kanban, every
// PAST day that entity spent in Updates must be re-expanded from a one-line gist
// into full facet-split Memory Notes, dated to each day's original messages. This
// can be a heavy one-time job at community scale (a stale subgroup carrying
// months of daily gists), so it runs as its own dispatched workflow, not inline
// in the request.
//
// Idempotent + self-cleaning: it removes this entity's prior WhatsApp notes (and
// their chunks) and its gist lines from the wa_updates rollups for the affected
// days, then re-runs the FULL facet-split path (forced Important) over every day
// of the entity's captured history. Re-running it produces the same end state.
//
// The reverse move (Important -> Updates) needs NO backfill: existing notes stand
// untouched and only NEW days log as gist (Read Me §8), which the normal delta
// pipeline already does once the classification row says 'updates'.
// ---------------------------------------------------------------------------
export async function reprocessEntityAsImportant(acct, provider, identityKey, runPool, concurrency) {
  const { user_email } = acct;

  // 1. Pull the entity's entire captured history from the ledger. We match the
  //    same way identityKeyForRow derives the key: a group/community by its jid,
  //    a person by phone. For a person the ledger's chat_id is the raw jid, so we
  //    reverse the phone key back to a jid prefix match; simplest correct route
  //    is to scan the user's rows and filter in code by identityKeyForRow.
  const page = 1000;
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await admin
      .from('whatsapp_message')
      .select('*')
      .eq('user_email', user_email)
      .order('msg_timestamp', { ascending: true })
      .range(from, from + page - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const r of data) {
      if (identityKeyForRow(r) === identityKey) rows.push(r);
    }
    if (data.length < page) break;
    from += page;
  }
  if (rows.length === 0) {
    console.log(`[${user_email}/wa] move-backfill ${identityKey}: no messages`);
    return { days: 0, messages: 0 };
  }

  // 2. Remove this entity's existing WhatsApp notes + chunks so the re-expansion
  //    doesn't duplicate. Notes are linked to the entity's ledger rows via
  //    wa_message_id; gather those note ids, delete their chunks, then the notes.
  const rowIds = rows.map((r) => r.id);
  const { data: oldNotes } = await admin
    .from('memory_note')
    .select('id')
    .eq('user_email', user_email)
    .eq('source', 'whatsapp')
    .in('wa_message_id', rowIds);
  const oldNoteIds = (oldNotes || []).map((n) => n.id);
  if (oldNoteIds.length > 0) {
    await admin.from('note_chunk').delete().eq('user_email', user_email).in('note_id', oldNoteIds);
    await admin.from('memory_note').delete().eq('user_email', user_email).in('id', oldNoteIds);
  }

  // 3. Remove this entity's gist lines from the affected days' wa_updates rollups
  //    (the entity is leaving Updates, so its gists are being replaced by notes).
  const days = Array.from(new Set(rows.map((r) => dayOf(r))));
  await removeEntityFromRollups(acct, identityKey, days);

  // 4. Re-bucket by day and run the FULL facet path (forced Important) per day.
  const buckets = new Map();
  for (const r of rows) {
    const key = dayOf(r);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  const work = [...buckets.values()];
  await runPool(work, concurrency, async (dayRows) => {
    try {
      await processEntityDay(acct, provider, {
        rows: dayRows,
        tier: TIER_IMPORTANT,
        tierReason: 'moved-updates-to-important',
      });
    } catch (err) {
      console.error(`[${user_email}/wa] move-backfill day ${dayOf(dayRows[0])}:`, err.message);
    }
  });

  console.log(
    `[${user_email}/wa] move-backfill ${identityKey}: ${buckets.size} days, ${rows.length} messages re-expanded`,
  );
  return { days: buckets.size, messages: rows.length };
}

// Strip one entity's entries out of the wa_updates daily rollups for the given
// days. Best-effort; leaves other entities' gists on those days intact.
async function removeEntityFromRollups(acct, identityKey, days) {
  const { user_email, card_id } = acct;
  for (const day of days) {
    try {
      const { data: roll } = await admin
        .from('daily_rollup')
        .select('id, entries')
        .eq('user_email', user_email)
        .eq('card_id', card_id || 'whatsapp')
        .eq('rollup_date', day)
        .eq('kind', 'wa_updates')
        .maybeSingle();
      if (!roll || !Array.isArray(roll.entries)) continue;
      const kept = roll.entries.filter((e) => e && e.identity_key !== identityKey);
      if (kept.length === roll.entries.length) continue; // nothing to remove
      await admin
        .from('daily_rollup')
        .update({ entries: kept, entry_count: kept.length, updated_at: new Date().toISOString() })
        .eq('id', roll.id);
    } catch (err) {
      console.error(`[${user_email}/wa] rollup cleanup ${day}:`, err.message);
    }
  }
}
// Now issues MULTIPLE ids per entity-day (one per facet), so the sequence count
// is read fresh before each insert.
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
