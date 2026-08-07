import { admin } from './supabase.js';

// Resolver (Memory Notes v5 §1 "Resolver", §4 alias matching, §7 engineering
// considerations). Code-only: takes the raw related_entities strings from a
// note and resolves each to a canonical entity row, then records the mention
// AND the note-ownership index entry, both carrying the alias that matched.
//
// v5 §4 three-band alias matching (implemented here):
//   - EXACT: normalized-name exact match to an existing entity -> that entity,
//     appended automatically, no review.
//   - NONE:  no candidate above the low threshold -> a brand-new entity.
//   - AMBIGUOUS: a fuzzy candidate scoring between the low and high thresholds
//     -> a NEW provisional entity, flagged pending_review, carrying a
//     merge_candidate pointer at the entity it might be plus the merge_score
//     that tripped the flag. The note still attaches to this provisional entity
//     normally — ingestion is never blocked on a human. Resolution is human-only
//     via the Entity Review dashboard (Phase 4).
//
// Scoring is deterministic and conservative (token-set similarity, no LLM). The
// thresholds are tunable knobs, not the open "alias rule in full" research: an
// exact normalized match still short-circuits before any scoring runs, so the
// common case is unchanged.

// --- tunable thresholds ------------------------------------------------------
// A score in [LOW, HIGH) is ambiguous -> provisional + pending_review. Below
// LOW -> new entity outright. An exact normalized match short-circuits above
// all of this (auto-append), so HIGH is the ceiling of the ambiguous band.
const AMBIGUOUS_LOW = 0.62;
const AMBIGUOUS_HIGH = 0.9;
// Score against a bounded candidate set for performance.
const MAX_CANDIDATES = 200;

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

// Token-set (Jaccard) similarity blended with a containment bonus so "alice"
// vs "alice a" reads as a near-match rather than a weak one. Deterministic.
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  const jaccard = inter / union;
  const containment = inter / Math.min(ta.size, tb.size);
  return 0.5 * jaccard + 0.5 * containment;
}

// Best fuzzy candidate for a normalized name among this user's non-retired
// entities. Returns { id, score } or null. Only used when no exact norm match.
async function bestFuzzyCandidate(userEmail, norm) {
  const { data: rows } = await admin
    .from('entity')
    .select('id, norm_name, aliases, merged_into')
    .eq('user_email', userEmail)
    .is('merged_into', null)
    .limit(MAX_CANDIDATES);
  if (!rows || rows.length === 0) return null;

  let best = null;
  for (const e of rows) {
    const candidates = [e.norm_name, ...((e.aliases || []).map(normalizeName))];
    let s = 0;
    for (const c of candidates) {
      const score = similarity(norm, c);
      if (score > s) s = score;
    }
    if (!best || s > best.score) best = { id: e.id, score: s };
  }
  return best;
}

// Resolve one raw entity string. Returns { id, matchedAlias } or null.
// matchedAlias is the raw display form that justified this reference (v5 §7).
async function resolveOne(userEmail, rawName, noteDate) {
  const norm = normalizeName(rawName);
  if (!norm || norm.length < 2) return null;
  const display = rawName.trim();

  // 1. EXACT normalized match -> that entity (auto-append, no review).
  const { data: existing } = await admin
    .from('entity')
    .select('id, aliases, first_seen, last_seen')
    .eq('user_email', userEmail)
    .eq('norm_name', norm)
    .maybeSingle();

  if (existing) {
    const patch = {};
    if (noteDate && (!existing.first_seen || noteDate < existing.first_seen)) patch.first_seen = noteDate;
    if (noteDate && (!existing.last_seen || noteDate > existing.last_seen)) patch.last_seen = noteDate;
    if (display && !(existing.aliases || []).includes(display)) {
      patch.aliases = [...(existing.aliases || []), display].slice(0, 20);
    }
    if (Object.keys(patch).length) {
      patch.updated_at = new Date().toISOString();
      await admin.from('entity').update(patch).eq('id', existing.id);
    }
    return { id: existing.id, matchedAlias: display };
  }

  // 2. No exact match: score the best fuzzy candidate to pick a band.
  const candidate = await bestFuzzyCandidate(userEmail, norm);
  const score = candidate ? candidate.score : 0;
  const isAmbiguous = candidate && score >= AMBIGUOUS_LOW && score < AMBIGUOUS_HIGH;

  const insertRow = {
    user_email: userEmail,
    canonical_name: display,
    norm_name: norm,
    entity_type: guessType(norm),
    aliases: [display],
    first_seen: noteDate || null,
    last_seen: noteDate || null,
  };
  if (isAmbiguous) {
    // AMBIGUOUS band: provisional entity, flagged for human review, pointing at
    // the entity it might actually be. Note still attaches here (not blocked).
    insertRow.pending_review = true;
    insertRow.merge_candidate = candidate.id;
    insertRow.merge_score = Number(score.toFixed(4));
  }

  const { data: created, error } = await admin
    .from('entity')
    .insert(insertRow)
    .select('id')
    .single();

  if (error) {
    // race: another concurrent insert created it — re-read by norm.
    const { data: again } = await admin
      .from('entity')
      .select('id')
      .eq('user_email', userEmail)
      .eq('norm_name', norm)
      .maybeSingle();
    return again ? { id: again.id, matchedAlias: display } : null;
  }
  return { id: created.id, matchedAlias: display };
}

// Resolve all related_entities of a note and record BOTH the mention and the
// note-ownership index row, each carrying matched_alias. Idempotent:
//   - entity_mention upsert on (user_email, entity_id, note_id)
//   - note_ownership upsert on (user_email, note_id, resolved_entity_id)
// At ingestion current_entity_id == resolved_entity_id; a later merge/split
// redirects current_entity_id only (v5 §7). Signature unchanged so every caller
// (gmail/whatsapp/slack ingest + entity-backfill) keeps working.
export async function resolveEntitiesForNote(userEmail, noteRowId, relatedEntities, noteDate) {
  const names = Array.isArray(relatedEntities) ? relatedEntities : [];
  const resolved = new Map(); // entity_id -> matchedAlias (first wins)
  for (const raw of names) {
    const r = await resolveOne(userEmail, raw, noteDate);
    if (r && !resolved.has(r.id)) resolved.set(r.id, r.matchedAlias);
  }

  for (const [entityId, matchedAlias] of resolved) {
    await admin
      .from('entity_mention')
      .upsert(
        { user_email: userEmail, entity_id: entityId, note_id: noteRowId, matched_alias: matchedAlias },
        { onConflict: 'user_email,entity_id,note_id' }
      );

    await admin
      .from('note_ownership')
      .upsert(
        {
          user_email: userEmail,
          note_id: noteRowId,
          resolved_entity_id: entityId,
          current_entity_id: entityId,
          matched_alias: matchedAlias,
        },
        { onConflict: 'user_email,note_id,resolved_entity_id' }
      );
  }
  return [...resolved.keys()];
}
