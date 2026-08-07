import { admin } from './supabase.js';
import { normalizeName } from './resolver.js';

// Email sender classification (Email Ingestion Read Me: "Classify-type step",
// "Granularity", "Dual classification", "Onboarding").
//
// Classification is a PERSISTED per-sender LIST MEMBERSHIP lookup — one sender
// belongs to exactly one of Marketing / Updates / People, decided once and
// reused — NOT overlapping header/filter checks per message. This module owns
// that lookup, the first-seen bootstrap heuristic, and the tier mapping.
//
// Key changes vs the old classify.js it replaces:
//   - keyed to the EXACT sender address, never the parent domain (a bank's
//     marketing@, alerts@, and an RM's own address can each sit on a different
//     list).
//   - List-Unsubscribe is DEMOTED: it is only one input to the first-seen
//     bootstrap guess, never an override on a sender already on a list.

// list -> tier used by the ingest pipeline.
const LIST_TO_TIER = { marketing: 'ignore', updates: 'storage', people: 'memory' };

// Extract the bare, lowercased email address from a From header or raw sender.
export function extractAddress(sender, headers) {
  const raw = String(sender || (headers && headers['from']) || '').trim();
  // "Name <a@b.com>" -> a@b.com ; or a bare a@b.com
  const angle = raw.match(/<([^>]+@[^>]+)>/);
  const bare = raw.match(/([^\s<>]+@[^\s<>]+)/);
  const addr = (angle ? angle[1] : bare ? bare[1] : raw).toLowerCase().trim();
  return addr;
}

function domainOf(address) {
  const m = String(address).match(/@(.+)$/);
  return m ? m[1] : '';
}

// Category (bank | social | transaction | update) for the Daily Updates rollup
// entry. This is NOT the list — it is a functional tag the ReadMe keeps
// separate on the updates note so a future ledger rollup can filter on it.
const CATEGORY_HINTS = [
  [/(bank|hdfc|icici|dbs|chase|citi|wellsfargo|barclays|hsbc)/, 'bank'],
  [/(paypal|stripe|razorpay|venmo|square|wise|payment|invoice|billing)/, 'transaction'],
  [/(linkedin|facebook|instagram|twitter|x\.com|tiktok|reddit|threads)/, 'social'],
];
export function guessCategory(address) {
  const d = domainOf(address);
  for (const [re, cat] of CATEGORY_HINTS) if (re.test(d)) return cat;
  return 'update';
}

// First-seen BOOTSTRAP heuristic (ReadMe "Classify-type step"). Runs ONCE for a
// never-seen sender to place it provisionally. List-Unsubscribe lives here and
// ONLY here — it is a bulk-mail hint for an unknown sender, not an override.
// Returns { list, reason }.
const BULK_LOCALPARTS = /^(no-?reply|noreply|donotreply|do-not-reply|news|newsletter|offers?|deals?|promo|marketing|updates?|mailer|campaign|email|hello|info)@/;
const BULK_DOMAIN_PREFIX = /^(mail|email|em|e|news|enews|marketing|offers|campaign|mailer|reply|notifications?)\./;

export function bootstrapGuess({ address, headers }) {
  const hasUnsub = !!(headers && (headers['list-unsubscribe'] || headers['list-id']));
  const d = domainOf(address);

  // Strong bulk signals -> Marketing (provisional).
  if (hasUnsub) return { list: 'marketing', reason: 'unsubscribe-header' };
  if (BULK_LOCALPARTS.test(address)) return { list: 'marketing', reason: 'bulk-localpart' };
  if (BULK_DOMAIN_PREFIX.test(d)) return { list: 'marketing', reason: 'bulk-domain-pattern' };

  // Otherwise default a new sender to People (memory-worthy) — the ReadMe's
  // "any sender not yet classified" also lands in tier 3. It is provisional and
  // surfaced on the Kanban for confirmation regardless.
  return { list: 'people', reason: 'default-unseen' };
}

// Dual classification (ReadMe "Dual classification: tier and entity"). When a
// sender row carries an entity_id, pre-seed that entity's alias index with the
// sender's display name / address — the same append the Resolver would do on a
// confident match, entered up front. Never inflates bubble size (no mention is
// created here). Best-effort.
async function seedEntityAlias(userEmail, entityId, sender, address) {
  if (!entityId) return;
  try {
    const { data: ent } = await admin
      .from('entity')
      .select('id, aliases')
      .eq('user_email', userEmail)
      .eq('id', entityId)
      .maybeSingle();
    if (!ent) return;
    const display = String(sender || '').replace(/<[^>]*>/, '').trim() || address;
    const additions = [display, address].filter(Boolean);
    const current = ent.aliases || [];
    const merged = Array.from(new Set([...current, ...additions])).slice(0, 40);
    if (merged.length !== current.length) {
      await admin
        .from('entity')
        .update({ aliases: merged, updated_at: new Date().toISOString() })
        .eq('id', entityId)
        .eq('user_email', userEmail);
    }
  } catch (err) {
    console.error(`[${userEmail}] seedEntityAlias:`, err.message);
  }
}

// Main entry: resolve one email's tier from the persisted sender list, creating
// a provisional row via the bootstrap heuristic when the sender is unseen.
// Returns { tier, list, reason, category, entityId } — the same shape the
// pipeline already consumes (tier/reason/category), plus list/entityId.
export async function classifySender(userEmail, { headers, sender }) {
  const address = extractAddress(sender, headers);
  if (!address || !address.includes('@')) {
    // No parseable address — treat as memory-worthy, never silently drop.
    return { tier: 'memory', list: 'people', reason: 'unparseable-sender', category: null, entityId: null };
  }

  // 1. Persisted lookup, keyed to the EXACT address.
  const { data: row } = await admin
    .from('sender_classification')
    .select('list, entity_id, confirmed')
    .eq('user_email', userEmail)
    .eq('sender_address', address)
    .maybeSingle();

  if (row) {
    if (row.entity_id) await seedEntityAlias(userEmail, row.entity_id, sender, address);
    const tier = LIST_TO_TIER[row.list] || 'memory';
    return {
      tier,
      list: row.list,
      reason: row.confirmed ? 'sender-list' : 'sender-list-provisional',
      category: tier === 'storage' ? guessCategory(address) : null,
      entityId: row.entity_id || null,
    };
  }

  // 2. Unseen sender: bootstrap-place it PROVISIONALLY and persist the row so
  //    the Kanban can surface it for confirmation. Never final on its own.
  const guess = bootstrapGuess({ address, headers });
  await admin
    .from('sender_classification')
    .upsert(
      {
        user_email: userEmail,
        sender_address: address,
        list: guess.list,
        confirmed: false,
        source: 'bootstrap',
        bootstrap_reason: guess.reason,
      },
      { onConflict: 'user_email,sender_address' }
    );

  const tier = LIST_TO_TIER[guess.list] || 'memory';
  return {
    tier,
    list: guess.list,
    reason: guess.reason,
    category: tier === 'storage' ? guessCategory(address) : null,
    entityId: null,
  };
}
