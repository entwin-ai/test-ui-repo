// WhatsApp name resolution.
//
// The raw `messaging-history.set` / `messages.upsert` events don't reliably
// carry human names:
//   * `pushName` is the SENDER's display name, and it's only present on
//     INCOMING messages — it's null on your own (`fromMe`) messages and is
//     frequently null in history replay.
//   * In a GROUP chat, `pushName` is the individual participant's name, NOT the
//     group subject — so using it as the chat name pollutes the chat label with
//     whoever spoke last.
//
// Baileys does deliver names through OTHER events and payload fields:
//   * `contacts.upsert` / `messaging-history.set { contacts }` — a directory of
//     { id, name?, notify?, verifiedName? } for known contacts.
//   * `chats.upsert` / `messaging-history.set { chats }` — chats carry a `name`
//     (the group subject for groups, or the contact name for 1:1s).
//   * group metadata (`subject`, `participants[].id/notify`).
//
// This registry harvests all of those into two maps and resolves a stable
// display name for (a) a chat and (b) an individual sender, with sensible
// fallbacks. It is per-run in-memory only — cheap to rebuild each capture.

import { isJidGroup } from '@whiskeysockets/baileys';

// Turn a jid into a readable phone fallback: "13125551234@s.whatsapp.net" -> "+13125551234".
function jidToPhone(jid) {
  if (!jid) return null;
  const user = String(jid).split('@')[0].split(':')[0].split('.')[0];
  if (!/^\d{6,15}$/.test(user)) return null;
  return `+${user}`;
}

export function createNameRegistry() {
  // jid -> best known display name for that individual contact.
  const contactNames = new Map();
  // chat jid -> best known chat label (group subject or 1:1 contact name).
  const chatNames = new Map();

  const cleaner = (s) => {
    if (typeof s !== 'string') return null;
    const t = s.trim();
    return t.length ? t : null;
  };

  // Keep the "best" name we've seen: prefer a real saved name over a notify/
  // pushName, and never downgrade a known name to null.
  function setContact(jid, ...candidates) {
    if (!jid) return;
    const next = candidates.map(cleaner).find(Boolean);
    if (!next) return;
    if (!contactNames.has(jid)) contactNames.set(jid, next);
  }
  function setChat(jid, ...candidates) {
    if (!jid) return;
    const next = candidates.map(cleaner).find(Boolean);
    if (!next) return;
    if (!chatNames.has(jid)) chatNames.set(jid, next);
  }

  // ---- harvesters, wired to socket events -------------------------------

  function ingestContacts(contacts) {
    for (const c of contacts || []) {
      // Priority: saved name > verifiedName (business) > notify (their pushName).
      setContact(c.id, c.name, c.verifiedName, c.notify);
    }
  }

  function ingestChats(chats) {
    for (const ch of chats || []) {
      // `name` on a chat is the group subject for groups, contact name for 1:1.
      setChat(ch.id, ch.name);
      // A 1:1 chat's name is also that contact's name.
      if (ch.id && !isJidGroup(ch.id)) setContact(ch.id, ch.name);
    }
  }

  function ingestGroupMetadata(meta) {
    if (!meta?.id) return;
    setChat(meta.id, meta.subject);
    for (const p of meta.participants || []) {
      setContact(p.id, p.notify, p.name);
    }
  }

  // Learn from a live message: its pushName is the sender's name.
  function ingestMessage(m) {
    const key = m?.key;
    if (!key) return;
    const sender = key.participant || (key.fromMe ? null : key.remoteJid);
    if (sender && !key.fromMe) setContact(sender, m.pushName);
    // For a 1:1 (non-group) incoming chat, pushName also labels the chat.
    if (key.remoteJid && !isJidGroup(key.remoteJid) && !key.fromMe) {
      setChat(key.remoteJid, m.pushName);
    }
  }

  // ---- resolvers, used when building a row -------------------------------

  // Display name for the CHAT (group subject, or the other party in a 1:1).
  function resolveChatName(chatJid) {
    if (!chatJid) return null;
    if (chatNames.has(chatJid)) return chatNames.get(chatJid);
    if (!isJidGroup(chatJid)) {
      // 1:1: fall back to the contact's name, else their phone number.
      return contactNames.get(chatJid) || jidToPhone(chatJid);
    }
    return null; // unknown group subject — leave null rather than guess.
  }

  // Display name for the individual SENDER of a message.
  function resolveSenderName(m, selfName) {
    const key = m?.key || {};
    if (key.fromMe) return selfName || 'Me';
    const sender = key.participant || key.remoteJid;
    return (
      cleaner(m.pushName) ||
      contactNames.get(sender) ||
      jidToPhone(sender) ||
      null
    );
  }

  return {
    ingestContacts,
    ingestChats,
    ingestGroupMetadata,
    ingestMessage,
    resolveChatName,
    resolveSenderName,
    // exposed for diagnostics
    _sizes: () => ({ contacts: contactNames.size, chats: chatNames.size }),
  };
}
