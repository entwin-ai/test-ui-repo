import { admin } from '../lib/supabase.js';
import { getMessage, extractParts } from '../lib/gmail.js';
import { cleanBody, contentHash } from '../lib/clean.js';
import { classify } from '../lib/classify.js';
import { writeNoteAndEntities, updatesSummary } from '../lib/prompts.js';
import { chunkText } from '../lib/chunk.js';
import { resolveEntitiesForNote } from '../lib/resolver.js';

// Process ONE Gmail message for an account. `acct` = { user_email, card_id }.
// `provider` is the user's bound LLM provider (from makeProvider). user_email is
// taken from the account row and threaded into every write.
export async function ingestMessage(accessToken, acct, provider, gmailMsgId) {
  const { user_email, card_id } = acct;

  const { data: existing } = await admin
    .from('email_message')
    .select('id')
    .eq('user_email', user_email)
    .eq('gmail_msg_id', gmailMsgId)
    .maybeSingle();
  if (existing) return { skipped: true };

  const raw = await getMessage(accessToken, gmailMsgId);
  const { headers, text, html, labels, threadId, internalDate } = extractParts(raw);
  const sender = headers['from'] || '';
  const subject = headers['subject'] || '(no subject)';
  const recipients = (headers['to'] || '').split(',').map((s) => s.trim());
  const clean = cleanBody({ text, html });
  const hash = contentHash(clean);

  let decision = await classify(user_email, { headers, sender });

  const { data: msgRow, error: msgErr } = await admin
    .from('email_message')
    .upsert(
      {
        user_email,
        card_id,
        gmail_msg_id: gmailMsgId,
        thread_id: threadId,
        internal_date: internalDate.toISOString(),
        sender,
        recipients,
        subject,
        labels,
        tier: decision.tier,
        tier_reason: decision.reason,
        clean_body: clean,
        content_hash: hash,
      },
      { onConflict: 'user_email,gmail_msg_id' }
    )
    .select()
    .single();
  if (msgErr) throw new Error(`ledger upsert: ${msgErr.message}`);

  try {
    if (decision.tier === 'ignore') {
      await appendRollup(acct, internalDate, 'ignored', {
        time: hhmm(internalDate),
        sender,
        subject,
        reason: decision.reason,
      });
    } else if (decision.tier === 'storage') {
      const { summary, urgent } = await updatesSummary(provider, user_email, { subject, sender, body: clean });
      if (urgent) {
        decision = { tier: 'memory', reason: 'reclassified-urgent' };
        await admin
          .from('email_message')
          .update({ tier: 'memory', tier_reason: 'reclassified-urgent' })
          .eq('id', msgRow.id);
        await runMemoryPipeline(acct, provider, msgRow, { subject, sender, body: clean, internalDate, gmailMsgId });
      } else {
        await appendRollup(acct, internalDate, 'updates', {
          time: hhmm(internalDate),
          sender,
          category: decision.category || 'update',
          summary,
          msg_id: gmailMsgId,
        });
      }
    } else {
      await runMemoryPipeline(acct, provider, msgRow, { subject, sender, body: clean, internalDate, gmailMsgId });
    }

    await admin
      .from('email_message')
      .update({ processed_at: new Date().toISOString(), process_error: null })
      .eq('id', msgRow.id);
    return { tier: decision.tier };
  } catch (err) {
    await admin.from('email_message').update({ process_error: String(err.message || err) }).eq('id', msgRow.id);
    throw err;
  }
}

async function runMemoryPipeline(acct, provider, msgRow, m) {
  const { user_email, card_id } = acct;
  const noteDate = m.internalDate.toISOString().slice(0, 10);

  // MERGED single LLM call: note fields + related_entities together.
  const { note, related } = await writeNoteAndEntities(provider, user_email, {
    subject: m.subject,
    sender: m.sender,
    body: m.body,
    date: noteDate,
  });

  const noteId = await nextNoteId(user_email, noteDate, 'email');
  const sourceUrl = `https://mail.google.com/mail/u/0/#all/${m.gmailMsgId}`;

  const { data: noteRow, error: noteErr } = await admin
    .from('memory_note')
    .insert({
      user_email,
      card_id,
      note_id: noteId,
      message_id: msgRow.id,
      gmail_msg_id: m.gmailMsgId,
      source: 'email',
      note_date: noteDate,
      name: m.subject,
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

  // Resolver: build the entity/graph layer. Non-fatal.
  try {
    await resolveEntitiesForNote(user_email, noteRow.id, related, noteDate);
  } catch (err) {
    console.error(`[${user_email}] resolver:`, err.message);
  }

  // action_edges (v5 §3/§6): link this note to prior Memory Notes in the SAME
  // email thread, symmetrically. This is the note-to-note edge the schema
  // defines — direction is read from date when needed, never stored. Email is
  // the channel with a first-class thread signal (thread_id). Non-fatal.
  try {
    await linkThreadEdges(user_email, noteRow.id, msgRow.thread_id);
  } catch (err) {
    console.error(`[${user_email}] action_edges:`, err.message);
  }

  // Full-body RAG with BATCHED embeddings: build all chunk texts, embed them in
  // ONE request, then bulk-insert. Chunk 0 carries a context header.
  const header = `From: ${m.sender} | Date: ${noteDate} | Subject: ${m.subject}\nSummary: ${note.raw_summary}`;
  const bodyChunks = chunkText(m.body);
  const pieces = bodyChunks.length > 0 ? bodyChunks : [note.raw_summary || m.subject];
  const contents = pieces.map((p, i) => (i === 0 ? `${header}\n\n${p}` : p));

  const vectors = await provider.embedBatch(contents); // one API call for all chunks

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
}

async function nextNoteId(userEmail, noteDate, source) {
  // Under concurrency a count-based sequence races (two parallel notes read the
  // same count -> same id -> unique-constraint reject). Keep the date-source
  // shape but append a short random suffix for collision-resistance.
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

// Symmetric action_edges linking within one email thread. memory_note has no
// thread_id of its own, so we resolve the thread through email_message: find
// every email_message in this thread, then the memory_notes built from them.
// Adds the new note to each prior note's action_edges and all priors to the new
// note's. Direction is never stored (read from date when needed). Edges are
// de-duplicated. No-op when there is no thread or no prior notes.
async function linkThreadEdges(userEmail, newNoteRowId, threadId) {
  if (!threadId) return;

  // All email_message rows in this thread for this user.
  const { data: msgs } = await admin
    .from('email_message')
    .select('id')
    .eq('user_email', userEmail)
    .eq('thread_id', threadId);
  if (!msgs || msgs.length === 0) return;
  const msgIds = msgs.map((r) => r.id);

  // Memory notes built from those messages, excluding the one we just created.
  const { data: priors } = await admin
    .from('memory_note')
    .select('id, action_edges')
    .eq('user_email', userEmail)
    .in('message_id', msgIds)
    .neq('id', newNoteRowId);
  if (!priors || priors.length === 0) return;

  const priorIds = priors.map((p) => p.id);

  // New note points at all priors.
  await admin
    .from('memory_note')
    .update({ action_edges: priorIds })
    .eq('id', newNoteRowId);

  // Each prior gains the new note (de-duplicated).
  for (const p of priors) {
    const edges = new Set(p.action_edges || []);
    if (edges.has(newNoteRowId)) continue;
    edges.add(newNoteRowId);
    await admin
      .from('memory_note')
      .update({ action_edges: [...edges] })
      .eq('id', p.id);
  }
}

export async function appendRollup(acct, date, kind, entry) {
  const { user_email, card_id } = acct;
  const rollupDate = date.toISOString().slice(0, 10);
  const { data: existing } = await admin
    .from('daily_rollup')
    .select('id, entries, entry_count')
    .eq('user_email', user_email)
    .eq('card_id', card_id)
    .eq('rollup_date', rollupDate)
    .eq('kind', kind)
    .maybeSingle();

  if (existing) {
    await admin
      .from('daily_rollup')
      .update({
        entries: [...existing.entries, entry],
        entry_count: existing.entry_count + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id);
  } else {
    await admin.from('daily_rollup').insert({
      user_email,
      card_id,
      rollup_date: rollupDate,
      kind,
      entries: [entry],
      entry_count: 1,
    });
  }
}

export function hhmm(d) {
  return d.toISOString().slice(11, 16);
}
