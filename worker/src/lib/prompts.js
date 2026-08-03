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

// ---------------------------------------------------------------------------
// WhatsApp variant. Produces the SAME Memory Note schema as writeNoteAndEntities
// so notes from chat and email are structurally identical and unify into the
// same entity graph + RAG index. Only the framing differs: a WhatsApp "message"
// is a single chat turn (often short, informal, part of an ongoing thread with
// one person or a group), not a subject-lined email.
// ---------------------------------------------------------------------------
export async function writeChatNoteAndEntities(provider, userEmail, { chatName, sender, body, date, isGroup }) {
  const system = `You read ONE WhatsApp message (a single chat turn) and return a Memory Note as strict JSON, no prose, no markdown.
Context: this is informal chat, possibly part of an ongoing conversation. "${isGroup ? 'This is a group chat.' : 'This is a 1:1 chat.'}"
Schema:
{
  "raw_summary": string,              // one line: what this message conveys
  "urgency": "critical"|"high"|"medium"|"low",
  "life_domain": "personal"|"professional",
  "action": string[],                 // subset of ["respond","give","schedule","decision","await","none","blank"]; "none"/"blank" stand alone
  "free_text": string,
  "confidentiality": "yes"|"no"|"blank",
  "related_entities": string[]        // canonical names of people/orgs this message is about; exclude the account owner. Use real names when the sender/chat name gives one.
}`;
  const { text, usage } = await provider.chatJSON({
    system,
    user: `Date: ${date}\nChat: ${chatName || sender}\nFrom: ${sender}\n\n${body}`,
    maxTokens: 1000,
  });
  await logCost(userEmail, provider, 'write_chat_note_and_entities', usage);
  const parsed = JSON.parse(text);
  const related = Array.isArray(parsed.related_entities) ? parsed.related_entities : [];
  return { note: parsed, related };
}
