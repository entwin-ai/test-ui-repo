// classify-type step from the Email Ingestion ReadMe.
// PURE CODE, no LLM. Three rules evaluated IN ORDER:
//   1. Marketing  -> tier 1 (ignore)   : List-Unsubscribe header OR bulk-sender list
//   2. Updates    -> tier 2 (storage)  : sender domain in bank/payment/social list
//   3. everything else -> tier 3 (memory-worthy) by default (catch-all)
//
// The two lists are maintained config. Kept here as seeds; move to a DB table
// or env-loaded file as they grow.

const BULK_SENDER_DOMAINS = [
  'enews.', 'email.', 'mail.', 'marketing.', 'news.', 'offers.',
  'e.', 'em.', 'campaign.',
];

const UPDATE_SENDERS = {
  // domain fragment -> category (bank | social | transaction)
  'icici.bank.in': 'bank',
  'dbs.com': 'bank',
  'hdfcbank': 'bank',
  'chase.com': 'bank',
  'paypal.com': 'transaction',
  'stripe.com': 'transaction',
  'linkedin.com': 'social',
  'facebookmail.com': 'social',
  'x.com': 'social',
  'instagram.com': 'social',
};

export function classify({ headers, sender }) {
  const from = (sender || headers['from'] || '').toLowerCase();
  const domain = extractDomain(from);

  // Rule 1: marketing
  if (headers['list-unsubscribe']) {
    return { tier: 'ignore', reason: 'unsubscribe-header' };
  }
  if (BULK_SENDER_DOMAINS.some((frag) => domain.startsWith(frag))) {
    return { tier: 'ignore', reason: 'bulk-sender' };
  }

  // Rule 2: updates (storage tier)
  for (const [frag, category] of Object.entries(UPDATE_SENDERS)) {
    if (domain.includes(frag)) {
      return { tier: 'storage', reason: 'update-sender', category };
    }
  }

  // Rule 3: default catch-all
  return { tier: 'memory', reason: 'default' };
}

function extractDomain(fromHeader) {
  const m = fromHeader.match(/@([^>\s]+)/);
  return m ? m[1] : fromHeader;
}
