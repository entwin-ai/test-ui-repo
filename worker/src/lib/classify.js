// classify-type step (Email Ingestion Read Me) — now a persisted, per-address
// sender-list lookup, not the old overlapping-filters draft. The real logic
// lives in sender-classification.js; this thin wrapper preserves the import
// name used by the pipeline and exposes the async classifier.
//
// NOTE: classify() is now ASYNC (it reads the sender_classification table and
// may write a provisional row for an unseen sender). Callers must await it.

import { classifySender } from './sender-classification.js';

export async function classify(userEmail, { headers, sender }) {
  return classifySender(userEmail, { headers, sender });
}
