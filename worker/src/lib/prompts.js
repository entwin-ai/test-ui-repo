import { admin } from './supabase.js';

// Provider-agnostic prompt functions. Cost logged per LLM call.

async function logCost(userEmail, provider, callKind, usage) {
  await admin.from('llm_cost_log').insert({
    user_email: userEmail,
    call_kind: callKind,
    model: provider.model,
    input_tokens: usage?.input_tokens ?? null,
    output_tokens: usage?.output_tokens ?? null,
  });
}

// MERGED call: Write Memory Note + Extract entities in ONE request. Previously
// two calls (v4 spec); merging halves per-email LLM latency and is functionally
// equivalent — the same fields, plus related_entities, in one JSON response.
export async function writeNoteAndEntities(provider, userEmail, { subject, sender, body, date }) {
  const system = `You read one email and return a Memory Note as strict JSON, no prose, no markdown.
Schema:
{
  "raw_summary": string,
  "urgency": "critical"|"high"|"medium"|"low",
  "life_domain": "personal"|"professional",
  "action": string[],                 // subset of ["respond","give","schedule","decision","await","none","blank"]; "none"/"blank" stand alone
  "free_text": string,
  "confidentiality": "yes"|"no"|"blank",
  "related_entities": string[]        // canonical names of people/orgs this email is about; exclude the mailbox owner
}`;
  const { text, usage } = await provider.chatJSON({
    system,
    user: `Date: ${date}\nFrom: ${sender}\nSubject: ${subject}\n\n${body}`,
    maxTokens: 1200,
  });
  await logCost(userEmail, provider, 'write_note_and_entities', usage);
  const parsed = JSON.parse(text);
  const related = Array.isArray(parsed.related_entities) ? parsed.related_entities : [];
  return { note: parsed, related };
}

// Tier-2 narrow call: one-line summary + failsafe urgency check.
export async function updatesSummary(provider, userEmail, { subject, sender, body }) {
  const system = `You summarise a bank/social/transaction notification in ONE line and flag genuine urgency.
Return strict JSON, no prose: {"summary": string, "urgent": boolean}
urgent = true ONLY for a real pending action or deadline a normal update wouldn't carry.`;
  const { text, usage } = await provider.chatJSON({
    system,
    user: `From: ${sender}\nSubject: ${subject}\n\n${body}`,
    maxTokens: 256,
  });
  await logCost(userEmail, provider, 'updates_summary', usage);
  return JSON.parse(text);
}
