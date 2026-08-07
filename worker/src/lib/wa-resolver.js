import { admin } from './supabase.js';
import { normalizeName } from './resolver.js';

// WhatsApp phone-first identity resolution (WhatsApp Ingestion Read Me appendix:
// "Same-name and number-change resolution order").
//
// The shared resolver matches on NAME. For WhatsApp that is the wrong key: two
// different people with two different numbers must NEVER collide, and a display
// name that merely looks like someone already on file must NEVER by itself push
// a new number into review. WhatsApp's identity key is the PHONE NUMBER; the
// real ambiguity is a number CHANGE (same person, new number). This module owns
// that ordering for a 1:1 contact, producing the entity the WhatsApp note should
// attribute to.
//
// Resolution order for a phone number (Read Me appendix):
//   0. EXACT phone match. We've seen this number before -> that entity. (This is
//      the everyday case and short-circuits everything below.)
//   1. New number, but a DURABLE WhatsApp USERNAME matches an existing entity's
//      username alias -> AUTO-MERGE at exact-match confidence, no review. The
//      username is designed to travel with the account rather than the number,
//      so this is a stronger signal than shared context. GATED on durability:
//      only a username Phase 0 (0.2) / Phase 1 flagged username_is_durable may
//      auto-merge. A text-only username degrades to the fuzzy band below.
//   2. New number, no durable username match: fall to the FUZZY band — shared
//      display name (+ any context). Flagged pending_review with BOTH phone
//      numbers on the card (old + new), so a human confirms the number change.
//   3. Neither: NEW entity outright. (A never-seen number with no username and
//      no name match is a new person — never pending_review on name alone,
//      Read Me §6.1.)
//
// A never-seen number NEVER enters pending_review on name similarity alone: step
// 3 creates a clean new entity. pending_review is reserved for the genuine
// number-change judgment in step 2, where the display name matches AND we can
// show the reviewer the two numbers.

// The fuzzy band for a number-change judgment. We only treat a display-name
// match as a number-change candidate when it's a STRONG, MUTUAL name match — a
// shared full name, not a first-name coincidence. Read Me §6.1 is explicit that
// a new number must not be flagged "purely on a first-name coincidence", so the
// number-change scorer below is jaccard-DOMINANT (both names must largely
// overlap), unlike the shared resolver's containment-friendly blend where
// "alice" ⊂ "alice smith" would score high. A single shared token against a
// two-token name yields jaccard 0.5 and does NOT clear the bar.
const NAME_CHANGE_LOW = 0.8;

// Jaccard-dominant name similarity for the number-change judgment: a shared
// FIRST name inside a fuller name must not by itself qualify. Weighted 0.8
// jaccard / 0.2 containment so mutual overlap dominates.
function nameChangeSimilarity(a, b) {
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
  return 0.8 * jaccard + 0.2 * containment;
}

// Look up this user's WhatsApp person-entity for an exact phone.
async function byPhone(userEmail, phone) {
  if (!phone) return null;
  const { data } = await admin
    .from('entity')
    .select('id, aliases, first_seen, last_seen, wa_phone, wa_username')
    .eq('user_email', userEmail)
    .eq('wa_phone', phone)
    .maybeSingle();
  return data || null;
}

// Look up this user's entity carrying a given durable username alias.
async function byUsername(userEmail, username) {
  if (!username) return null;
  const { data } = await admin
    .from('entity')
    .select('id, aliases, wa_phone, wa_username')
    .eq('user_email', userEmail)
    .eq('wa_username', username)
    .maybeSingle();
  return data || null;
}

// Best name-match among this user's EXISTING WhatsApp-keyed entities (ones that
// already have a wa_phone), for the number-change judgment. We restrict to
// WhatsApp-keyed entities so we compare a new number against actual prior
// WhatsApp contacts, not arbitrary email entities.
async function bestNameMatchAmongWhatsapp(userEmail, norm, excludePhone) {
  const { data: rows } = await admin
    .from('entity')
    .select('id, norm_name, aliases, wa_phone')
    .eq('user_email', userEmail)
    .is('merged_into', null)
    .not('wa_phone', 'is', null)
    .limit(500);
  if (!rows || rows.length === 0) return null;
  let best = null;
  for (const e of rows) {
    if (excludePhone && e.wa_phone === excludePhone) continue;
    const candidates = [e.norm_name, ...((e.aliases || []).map(normalizeName))];
    let s = 0;
    for (const c of candidates) {
      const score = nameChangeSimilarity(norm, c);
      if (score > s) s = score;
    }
    if (!best || s > best.score) best = { id: e.id, score: s, wa_phone: e.wa_phone };
  }
  return best;
}

async function touchSeen(entityId, existing, noteDate, display, extraPatch = {}) {
  const patch = { ...extraPatch };
  if (noteDate && (!existing.first_seen || noteDate < existing.first_seen)) patch.first_seen = noteDate;
  if (noteDate && (!existing.last_seen || noteDate > existing.last_seen)) patch.last_seen = noteDate;
  if (display && !(existing.aliases || []).includes(display)) {
    patch.aliases = [...(existing.aliases || []), display].slice(0, 20);
  }
  if (Object.keys(patch).length) {
    patch.updated_at = new Date().toISOString();
    await admin.from('entity').update(patch).eq('id', entityId);
  }
}

// Resolve (or create) the person-entity for a WhatsApp 1:1 contact by PHONE.
// Inputs:
//   phone     the contact's phone number (identity key)
//   username  the WhatsApp username, if any (from whatsapp_entity.wa_username)
//   durable   whether that username is a stable, account-tied id (Phase 1
//             username_is_durable / Phase 0 0.2 verdict)
//   display   the human display name for aliases
// Returns { id, matchedAlias } — the entity the note should attribute to.
export async function resolveWhatsappContact(userEmail, { phone, username, durable, display, noteDate }) {
  const displayName = (display || '').trim();
  const norm = normalizeName(displayName);

  // 0. EXACT phone match — the everyday case.
  const existing = await byPhone(userEmail, phone);
  if (existing) {
    // Keep the username alias current if we now have a durable one on file.
    const extra = {};
    if (durable && username && existing.wa_username !== username) extra.wa_username = username;
    await touchSeen(existing.id, existing, noteDate, displayName, extra);
    return { id: existing.id, matchedAlias: displayName || phone };
  }

  // 1. New number, DURABLE username matches an existing entity -> AUTO-MERGE.
  if (durable && username) {
    const byUser = await byUsername(userEmail, username);
    if (byUser) {
      // Same confidence as an exact match: append this new number's context to
      // the existing entity. We record the new phone as an alias but keep the
      // entity's primary wa_phone as-is (its canonical key); the username is the
      // durable through-line. first/last seen + display alias updated.
      await touchSeen(byUser.id, byUser, noteDate, displayName, {});
      return { id: byUser.id, matchedAlias: username };
    }
  }

  // 2. New number, no durable username match: the number-change judgment. Only a
  //    STRONG display-name match becomes a pending_review candidate (never a
  //    first-name coincidence — Read Me §6.1).
  let pending = null;
  if (norm && norm.length >= 2) {
    const nameMatch = await bestNameMatchAmongWhatsapp(userEmail, norm, phone);
    if (nameMatch && nameMatch.score >= NAME_CHANGE_LOW) {
      pending = nameMatch; // { id, score, wa_phone }
    }
  }

  // 3. Create the entity. If a strong name match exists on another WhatsApp
  //    number, create it provisional (pending_review) carrying BOTH numbers so a
  //    human can confirm the change. Otherwise a clean new entity.
  const insertRow = {
    user_email: userEmail,
    canonical_name: displayName || phone,
    norm_name: norm || phone,
    entity_type: 'person',
    aliases: displayName ? [displayName] : [],
    first_seen: noteDate || null,
    last_seen: noteDate || null,
    wa_phone: phone || null,
    wa_username: durable && username ? username : null,
  };
  if (pending) {
    insertRow.pending_review = true;
    insertRow.merge_candidate = pending.id;
    insertRow.merge_score = Number(pending.score.toFixed(4));
    insertRow.wa_prev_phone = pending.wa_phone; // the OLD number, for the review card
  }

  const { data: created, error } = await admin
    .from('entity')
    .insert(insertRow)
    .select('id')
    .single();
  if (error) {
    // Race or unique(norm_name) collision — re-read by phone, then by norm.
    const again = (await byPhone(userEmail, phone)) || null;
    if (again) return { id: again.id, matchedAlias: displayName || phone };
    const { data: byNorm } = await admin
      .from('entity')
      .select('id')
      .eq('user_email', userEmail)
      .eq('norm_name', norm || phone)
      .maybeSingle();
    return byNorm ? { id: byNorm.id, matchedAlias: displayName || phone } : null;
  }
  return { id: created.id, matchedAlias: displayName || phone };
}
