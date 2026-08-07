import { getSupabaseAdmin } from '@/lib/rag/supabase'

/**
 * Entity merge & split operations (Memory Notes v5 §4, §7). These are the shared
 * server-side operations the Entity Review dashboard (Phase 4) invokes. They
 * maintain the entity layer, the entity_mention references, and the
 * note_ownership index — and CRUCIALLY never rewrite any Memory Note. A note's
 * frozen related_entities is immutable; only Entity files and the ownership
 * index change (v5 §7).
 *
 * Every function is scoped by userEmail, which the route handler derives from
 * the session — never from request input.
 *
 * Asymmetry (v5 §4):
 *   - MERGE retires the SOURCE entity, marking it merged_into the target, since
 *     old notes' related_entities still point at it and need a redirect. The
 *     redirect lives in note_ownership.current_entity_id, not in the note.
 *   - SPLIT retires NOTHING. The original keeps a shorter reference list; only
 *     the NEW entity carries split_from. Which references move is decided by
 *     matched_alias — the reason §7 requires matched_alias per reference.
 */

export interface MergeResult {
  ok: boolean
  sourceId: string
  targetId: string
  movedMentions: number
  error?: string
}

export interface SplitResult {
  ok: boolean
  fromId: string
  newEntityId: string
  movedAliases: string[]
  movedMentions: number
  error?: string
}

/**
 * Merge `sourceId` INTO `targetId`.
 *   1. Repoint every entity_mention from source -> target (dedupe on the target).
 *   2. Redirect note_ownership.current_entity_id from source -> target
 *      (resolved_entity_id, the frozen anchor, is left untouched).
 *   3. Fold source's aliases into the target.
 *   4. Retire the source: mark it merged_into = target, clear any pending_review.
 * The source row is kept (not deleted) so historical related_entities that name
 * it still resolve through the merged_into redirect.
 */
export async function mergeEntities(
  userEmail: string,
  sourceId: string,
  targetId: string,
): Promise<MergeResult> {
  const admin = getSupabaseAdmin()
  if (sourceId === targetId) {
    return { ok: false, sourceId, targetId, movedMentions: 0, error: 'Cannot merge an entity into itself' }
  }

  // Validate both belong to this user.
  const { data: ents, error: entErr } = await admin
    .from('entity')
    .select('id, aliases, merged_into')
    .eq('user_email', userEmail)
    .in('id', [sourceId, targetId])
  if (entErr) return { ok: false, sourceId, targetId, movedMentions: 0, error: entErr.message }
  const source = ents?.find((e) => e.id === sourceId)
  const target = ents?.find((e) => e.id === targetId)
  if (!source || !target) {
    return { ok: false, sourceId, targetId, movedMentions: 0, error: 'Source or target entity not found for this user' }
  }

  // 1. Repoint mentions. Read source's mentions, upsert them onto the target
  //    (unique on (user_email, entity_id, note_id) dedupes), then delete the
  //    source's mention rows.
  const { data: srcMentions } = await admin
    .from('entity_mention')
    .select('note_id, matched_alias')
    .eq('user_email', userEmail)
    .eq('entity_id', sourceId)

  let moved = 0
  for (const m of srcMentions ?? []) {
    await admin.from('entity_mention').upsert(
      { user_email: userEmail, entity_id: targetId, note_id: m.note_id, matched_alias: m.matched_alias },
      { onConflict: 'user_email,entity_id,note_id' },
    )
    moved++
  }
  await admin.from('entity_mention').delete().eq('user_email', userEmail).eq('entity_id', sourceId)

  // 2. Redirect ownership: current_entity_id source -> target. The frozen
  //    resolved_entity_id anchor is deliberately NOT touched, so a note whose
  //    resolved != current becomes the visible trace of this merge (v5 §7).
  await admin
    .from('note_ownership')
    .update({ current_entity_id: targetId })
    .eq('user_email', userEmail)
    .eq('current_entity_id', sourceId)

  // 3. Fold aliases into target (dedupe, cap).
  const mergedAliases = Array.from(
    new Set([...(target.aliases || []), ...(source.aliases || [])]),
  ).slice(0, 40)
  await admin
    .from('entity')
    .update({ aliases: mergedAliases, updated_at: new Date().toISOString() })
    .eq('id', targetId)
    .eq('user_email', userEmail)

  // 4. Retire the source.
  await admin
    .from('entity')
    .update({
      merged_into: targetId,
      pending_review: false,
      merge_candidate: null,
      merge_score: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', sourceId)
    .eq('user_email', userEmail)

  return { ok: true, sourceId, targetId, movedMentions: moved }
}

/**
 * Accept a provisional (pending_review) entity as genuinely DISTINCT — the
 * "Reject" action in the dashboard's Pending Review. Clears the review flag and
 * the merge pointer; the entity simply stands on its own going forward.
 */
export async function rejectPendingReview(userEmail: string, entityId: string): Promise<{ ok: boolean; error?: string }> {
  const admin = getSupabaseAdmin()
  const { error } = await admin
    .from('entity')
    .update({ pending_review: false, merge_candidate: null, merge_score: null, updated_at: new Date().toISOString() })
    .eq('user_email', userEmail)
    .eq('id', entityId)
  return error ? { ok: false, error: error.message } : { ok: true }
}

/**
 * Split a set of aliases out of `fromId` into a NEW entity.
 *   1. Create the new entity, carrying split_from = fromId.
 *   2. Move the aliases out of the original into the new entity.
 *   3. Move the mentions whose matched_alias is in the split set to the new
 *      entity, and redirect their note_ownership.current_entity_id.
 * The original entity is NOT retired (v5 §4) — it keeps a shorter reference
 * list. No Memory Note is rewritten; only Entity files, mentions, and the
 * ownership index change.
 */
export async function splitAliases(
  userEmail: string,
  fromId: string,
  aliasesToSplit: string[],
  newCanonicalName?: string,
): Promise<SplitResult> {
  const admin = getSupabaseAdmin()
  const splitSet = new Set((aliasesToSplit || []).map((a) => a.trim()).filter(Boolean))
  if (splitSet.size === 0) {
    return { ok: false, fromId, newEntityId: '', movedAliases: [], movedMentions: 0, error: 'No aliases given to split' }
  }

  const { data: from, error: fromErr } = await admin
    .from('entity')
    .select('id, canonical_name, norm_name, entity_type, aliases')
    .eq('user_email', userEmail)
    .eq('id', fromId)
    .maybeSingle()
  if (fromErr) return { ok: false, fromId, newEntityId: '', movedAliases: [], movedMentions: 0, error: fromErr.message }
  if (!from) return { ok: false, fromId, newEntityId: '', movedAliases: [], movedMentions: 0, error: 'Source entity not found' }

  const moved = (from.aliases || []).filter((a: string) => splitSet.has(a))
  if (moved.length === 0) {
    return { ok: false, fromId, newEntityId: '', movedAliases: [], movedMentions: 0, error: 'None of the given aliases belong to this entity' }
  }

  const canonical = (newCanonicalName || moved[0]).trim()
  const norm = canonical
    .toLowerCase()
    .replace(/["'`]/g, '')
    .replace(/[^a-z0-9\s.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // 1. Create the new entity with lineage. norm_name must be unique per user;
  //    if it collides, suffix it so the split still succeeds.
  let insErr: string | null = null
  let created: { id: string } | null = null
  for (const candidateNorm of [norm, `${norm} (split)`, `${norm} ${Date.now()}`]) {
    const { data, error } = await admin
      .from('entity')
      .insert({
        user_email: userEmail,
        canonical_name: canonical,
        norm_name: candidateNorm,
        entity_type: from.entity_type || 'person',
        aliases: moved,
        split_from: fromId,
      })
      .select('id')
      .single()
    if (!error) { created = data; insErr = null; break }
    insErr = error.message
  }
  if (!created) {
    return { ok: false, fromId, newEntityId: '', movedAliases: [], movedMentions: 0, error: `new entity insert: ${insErr}` }
  }
  const newEntityId = created.id

  // 2. Remove the moved aliases from the original.
  const remaining = (from.aliases || []).filter((a: string) => !splitSet.has(a))
  await admin
    .from('entity')
    .update({ aliases: remaining, updated_at: new Date().toISOString() })
    .eq('id', fromId)
    .eq('user_email', userEmail)

  // 3. Move mentions whose matched_alias is in the split set, and redirect
  //    their ownership rows to the new entity.
  const { data: mentions } = await admin
    .from('entity_mention')
    .select('id, note_id, matched_alias')
    .eq('user_email', userEmail)
    .eq('entity_id', fromId)

  let movedMentions = 0
  for (const m of mentions ?? []) {
    if (!m.matched_alias || !splitSet.has(m.matched_alias)) continue
    // repoint the mention to the new entity (dedupe on target)
    await admin.from('entity_mention').upsert(
      { user_email: userEmail, entity_id: newEntityId, note_id: m.note_id, matched_alias: m.matched_alias },
      { onConflict: 'user_email,entity_id,note_id' },
    )
    await admin.from('entity_mention').delete().eq('id', m.id)
    // redirect ownership for this note+anchor to the new entity
    await admin
      .from('note_ownership')
      .update({ current_entity_id: newEntityId })
      .eq('user_email', userEmail)
      .eq('note_id', m.note_id)
      .eq('resolved_entity_id', fromId)
    movedMentions++
  }

  return { ok: true, fromId, newEntityId, movedAliases: moved, movedMentions }
}
