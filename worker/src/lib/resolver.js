import { admin } from './supabase.js';

// Resolver (v4 §1 "Resolver", §4 alias matching). Code-only: takes the raw
// related_entities strings from a note and resolves each to a canonical entity
// row, creating one if no alias match exists, then records the mention.
//
// Alias matching here is deliberately conservative and deterministic:
//   - normalize: lowercase, strip punctuation/extra whitespace, drop a trailing
//     email in angle brackets, collapse to "first last" form.
//   - a normalized-name exact match to an existing entity (canonical or alias)
//     => same entity.
//   - otherwise => new entity.
// This is the "clean, unambiguous match updates; no match auto-creates" rule.
// The spec's "uncertain match => pending review queue" is left as a future
// step; we do not fuzzy-merge, which keeps us from silently merging wrong.

export function normalizeName(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  // drop a trailing email in <...> or (...)
  s = s.replace(/[<(][^>)]*@[^>)]*[>)]/g, '').trim();
  // if it's just an email, keep the local part as a name hint
  const bareEmail = s.match(/^([^@\s]+)@[^@\s]+$/);
  if (bareEmail) s = bareEmail[1].replace(/[._]/g, ' ');
  s = s
    .toLowerCase()
    .replace(/["'`]/g, '')
    .replace(/[^a-z0-9\s.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

function guessType(name) {
  // very light heuristic; refine later. Org-ish if it contains a company word.
  const orgWords = /\b(inc|ltd|llc|corp|company|bank|group|team|university|dept|gmbh|technologies|systems)\b/;
  return orgWords.test(name) ? 'organisation' : 'person';
}

// Resolve one raw entity string to an entity id for this user, creating if new.
async function resolveOne(userEmail, rawName, noteDate) {
  const norm = normalizeName(rawName);
  if (!norm || norm.length < 2) return null;

  // 1. exact normalized match on canonical name
  const { data: existing } = await admin
    .from('entity')
    .select('id, aliases, first_seen, last_seen')
    .eq('user_email', userEmail)
    .eq('norm_name', norm)
    .maybeSingle();

  if (existing) {
    // update seen range + ensure the raw display form is in aliases
    const patch = {};
    if (noteDate && (!existing.first_seen || noteDate < existing.first_seen)) patch.first_seen = noteDate;
    if (noteDate && (!existing.last_seen || noteDate > existing.last_seen)) patch.last_seen = noteDate;
    if (rawName && !(existing.aliases || []).includes(rawName)) {
      patch.aliases = [...(existing.aliases || []), rawName].slice(0, 20);
    }
    if (Object.keys(patch).length) {
      patch.updated_at = new Date().toISOString();
      await admin.from('entity').update(patch).eq('id', existing.id);
    }
    return existing.id;
  }

  // 2. no match -> create a new canonical entity
  const { data: created, error } = await admin
    .from('entity')
    .insert({
      user_email: userEmail,
      canonical_name: rawName.trim(),
      norm_name: norm,
      entity_type: guessType(norm),
      aliases: [rawName.trim()],
      first_seen: noteDate || null,
      last_seen: noteDate || null,
    })
    .select('id')
    .single();
  if (error) {
    // race: another concurrent insert created it — re-read
    const { data: again } = await admin
      .from('entity')
      .select('id')
      .eq('user_email', userEmail)
      .eq('norm_name', norm)
      .maybeSingle();
    return again?.id || null;
  }
  return created.id;
}

// Resolve all related_entities of a note and record mentions. Idempotent:
// mention upsert on (user_email, entity_id, note_id).
export async function resolveEntitiesForNote(userEmail, noteRowId, relatedEntities, noteDate) {
  const names = Array.isArray(relatedEntities) ? relatedEntities : [];
  const entityIds = new Set();
  for (const raw of names) {
    const id = await resolveOne(userEmail, raw, noteDate);
    if (id) entityIds.add(id);
  }
  for (const entityId of entityIds) {
    await admin
      .from('entity_mention')
      .upsert(
        { user_email: userEmail, entity_id: entityId, note_id: noteRowId },
        { onConflict: 'user_email,entity_id,note_id' }
      );
  }
  return [...entityIds];
}
