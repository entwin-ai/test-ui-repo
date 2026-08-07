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

// ---------------------------------------------------------------------------
// WhatsApp IMPORTANT-tier facet decomposition (WhatsApp Ingestion Read Me §1,
// §10 "Important tier · facet decomposition"). Reads ONE entity's whole day of
// messages and returns ONE Memory Note PER FACET — a facet being one coherent
// domain-plus-intent cluster (topic + purpose together), NOT the whole day by
// default and NOT one note per message. Two messages share a facet only if they
// share BOTH topic and intent; a change in either starts a new facet.
//
// This replaces the old per-message shape for Important entities: a day's
// exchange that crosses a work thread and dinner plans becomes TWO notes, while
// a quiet single-topic day becomes one. Each facet carries the same v5 Memory
// Note fields as every other channel so notes unify into one entity graph.
// ---------------------------------------------------------------------------
export async function decomposeChatDayFacets(provider, userEmail, { chatName, date, isGroup, transcript }) {
  const system = `You read one ${isGroup ? 'group' : '1:1'} WhatsApp chat's messages for a SINGLE calendar day and split them into FACETS.
A facet is ONE coherent domain-plus-intent cluster — topic and purpose together — NOT the whole day by default, and NOT one note per message. Two messages belong to the same facet only if they share BOTH topic and intent; a change in either starts a new facet. Do not merge unrelated topics into one facet for convenience, and do not split a single continuous exchange into artificial fragments.

Return strict JSON, no prose, no markdown:
{
  "facets": [
    {
      "raw_summary": string,            // one line: what this facet's exchange was about
      "urgency": "critical"|"high"|"medium"|"low",
      "life_domain": "personal"|"professional",
      "action": string[],               // subset of ["respond","give","schedule","decision","await","none","blank"]; "none"/"blank" stand alone
      "free_text": string,              // nuance, tone, why it matters, any date named
      "confidentiality": "yes"|"no"|"blank",
      "related_entities": string[]      // canonical names of people/orgs this facet is about; exclude the account owner
    }
  ]
}
A quiet, single-topic day yields exactly one facet. A busy multi-topic day yields several. Always return at least one facet.`;
  const { text, usage } = await provider.chatJSON({
    system,
    user: `Date: ${date}\nChat: ${chatName || '(unknown)'}\n\nMessages (chronological, "sender: text" per line):\n${transcript}`,
    maxTokens: 2000,
  });
  await logCost(userEmail, provider, 'decompose_chat_day_facets', usage);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { facets: [] };
  }
  const facets = Array.isArray(parsed.facets) ? parsed.facets : [];
  // Normalize each facet; guarantee related_entities is an array.
  return facets
    .filter((f) => f && typeof f === 'object')
    .map((f) => ({
      raw_summary: f.raw_summary || '',
      urgency: f.urgency || 'low',
      life_domain: f.life_domain === 'professional' ? 'professional' : 'personal',
      action: Array.isArray(f.action) ? f.action : [],
      free_text: f.free_text || '',
      confidentiality: f.confidentiality === 'yes' || f.confidentiality === 'no' ? f.confidentiality : 'blank',
      related_entities: Array.isArray(f.related_entities) ? f.related_entities : [],
    }));
}

// ---------------------------------------------------------------------------
// WhatsApp UPDATES-tier gist + dual failsafe (WhatsApp Ingestion Read Me §6,
// §10 "Updates tier · gist and failsafe check"). ONE narrow LLM call over a
// low-priority group/community's day that does two jobs at once (the same
// one-call design as email's updatesSummary): produce a one-LINE gist, AND run
// the dual failsafe — was the user directly @mentioned, and does anything read
// as genuinely urgent (a pending action, a deadline, something this kind of
// group wouldn't normally carry).
//
// If EITHER failsafe trigger fires, the gist is discarded and the caller routes
// the entity-day into the full facet-split Memory Note pipeline instead (Read Me
// §6). Keeping the mention check inside this same call (rather than pre-filtering
// in code) is deliberate: a mention that fires still needs the model to produce
// note content downstream, so there's no saving in a separate pass.
// ---------------------------------------------------------------------------
export async function updatesGistAndFailsafe(provider, userEmail, { chatName, date, isGroup, transcript }) {
  const system = `You read one ${isGroup ? 'group' : 'group/community'} WhatsApp chat's messages for a SINGLE calendar day, already classified as a low-priority Updates entity.
Do two things and return strict JSON, no prose, no markdown:
{
  "gist": string,        // ONE line: what was discussed. Not a detailed summary.
  "mentioned": boolean,  // was the account owner directly @mentioned anywhere in the day's messages?
  "urgent": boolean      // does any message read as genuinely urgent — a pending action, a deadline, or something a group like this would NOT normally carry? Be conservative: routine chatter is NOT urgent.
}`;
  const { text, usage } = await provider.chatJSON({
    system,
    user: `Date: ${date}\nChat: ${chatName || '(unknown)'}\n\nMessages (chronological, "sender: text" per line):\n${transcript}`,
    maxTokens: 400,
  });
  await logCost(userEmail, provider, 'updates_gist_and_failsafe', usage);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // On a parse failure, fail SAFE: treat as urgent so the day is not silently
    // dropped into a gist — it routes to full notes instead.
    return { gist: '', mentioned: false, urgent: true, parseError: true };
  }
  return {
    gist: typeof parsed.gist === 'string' ? parsed.gist : '',
    mentioned: parsed.mentioned === true,
    urgent: parsed.urgent === true,
  };
}
