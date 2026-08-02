import { admin } from './lib/supabase.js';
import { resolveEntitiesForNote } from './lib/resolver.js';

// Build the entity layer from memory_notes ALREADY in the database. This reuses
// existing related_entities — no email is re-fetched or re-parsed. Run once
// after deploying the entity layer; safe to re-run (idempotent upserts).
//
// Usage (as a MODE of the worker):  MODE=entity-backfill npm start
// Optional scope: ONLY_USER=you@example.com

const ONLY_USER = process.env.ONLY_USER || null;

export async function backfillEntities() {
  let from = 0;
  const page = 500;
  let total = 0;
  for (;;) {
    let q = admin
      .from('memory_note')
      .select('id, user_email, related_entities, note_date')
      .order('created_at', { ascending: true })
      .range(from, from + page - 1);
    if (ONLY_USER) q = q.eq('user_email', ONLY_USER);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;

    for (const note of data) {
      try {
        await resolveEntitiesForNote(
          note.user_email,
          note.id,
          note.related_entities || [],
          note.note_date
        );
        total++;
      } catch (err) {
        console.error(`note ${note.id}:`, err.message);
      }
    }
    console.log(`entity-backfill: processed ${total} notes so far`);
    if (data.length < page) break;
    from += page;
  }
  console.log(`entity-backfill: done, ${total} notes processed`);
}
