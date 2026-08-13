// WhatsApp name resolution.
//
// Raw message events don't reliably carry human names: `pushName` is only on
// INCOMING messages (null on your own / in history replay), and in a GROUP it's
// the participant's name, NOT the group subject — so using it as the chat name
// pollutes the label with whoever spoke last. Baileys delivers names through
// OTHER events: contacts.upsert / history `contacts`, chats.upsert / history
// `chats` (chat.name = group subject or 1:1 contact name), and group metadata.
// This registry harvests all of those and resolves a stable display name for a
// chat and for an individual sender, with sensible fallbacks. Per-run in-memory.

import { isJidGroup } from '@whiskeysockets/baileys';

function jidToPhone(jid) {
  if (!jid) return null;
  const user = String(jid).split('@')[0].split(':')[0].split('.')[0];
  if (!/^\d{6,15}$/.test(user)) return null;
  return `+${user}`;
}

// A display candidate that is just the phone number (with or without the +) is
// NOT a human name — WhatsApp shows those only when it has nothing better, and
// persisting them is exactly the "weird looking phone number" we want to avoid.
// This ALSO catches WhatsApp's own privacy-masked form for an unsaved contact,
// e.g. "+1∙∙∙∙∙∙∙∙64" / "+1 •••••• 64" / "+44…22": a string whose only visible
// glyphs are digits, spaces, a leading +, and mask characters (bullet operator
// U+2219, bullet U+2022, middle dot U+00B7, ellipsis U+2026, or ASCII dots).
// None of these is a real name, so we reject them all and let a genuine
// pushName / contact name win instead.
const MASK_CHARS = '\\u2219\\u2022\\u00b7\\u2026.';
const PHONE_OR_MASK_RE = new RegExp(`^\\+?[\\d\\s()\\-${MASK_CHARS}]{4,}$`);
function looksLikePhone(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (!t) return false;
  // Must contain at least one digit and, apart from separators/mask glyphs,
  // nothing else — a real name has letters, which fail this test.
  return /\d/.test(t) && PHONE_OR_MASK_RE.test(t);
}

export function createNameRegistry() {
  const contactNames = new Map(); // jid -> display name (never a bare number)
  const chatNames = new Map();    // chat jid -> label (group subject / 1:1 name)
  // phone (e.g. +13125551234) -> best human display name seen this run, keyed
  // the SAME way the entity identity key is derived. This is what lets the
  // vectorize/memory-note layer swap a bare number for the name WhatsApp shows.
  const phoneNames = new Map();

  const cleaner = (s) => {
    if (typeof s !== 'string') return null;
    const t = s.trim();
    if (!t.length) return null;
    if (looksLikePhone(t)) return null; // a number is not a name
    return t;
  };

  function rememberPhoneName(jid, name) {
    const phone = jidToPhone(jid);
    if (!phone || !name) return;
    if (!phoneNames.has(phone)) phoneNames.set(phone, name);
  }

  function setContact(jid, ...candidates) {
    if (!jid) return;
    const next = candidates.map(cleaner).find(Boolean);
    if (!next) return;
    if (!contactNames.has(jid)) contactNames.set(jid, next);
    rememberPhoneName(jid, next); // mirror onto the phone key for the note layer
  }
  function setChat(jid, ...candidates) {
    if (!jid) return;
    const next = candidates.map(cleaner).find(Boolean);
    if (!next) return;
    if (!chatNames.has(jid)) chatNames.set(jid, next);
    if (!isJidGroup(jid)) rememberPhoneName(jid, next);
  }

  function ingestContacts(contacts) {
    for (const c of contacts || []) setContact(c.id, c.name, c.verifiedName, c.notify);
  }
  function ingestChats(chats) {
    for (const ch of chats || []) {
      setChat(ch.id, ch.name);
      if (ch.id && !isJidGroup(ch.id)) setContact(ch.id, ch.name);
    }
  }
  function ingestGroupMetadata(meta) {
    if (!meta?.id) return;
    setChat(meta.id, meta.subject);
    for (const p of meta.participants || []) setContact(p.id, p.notify, p.name);
  }
  function ingestMessage(m) {
    const key = m?.key;
    if (!key) return;
    const sender = key.participant || (key.fromMe ? null : key.remoteJid);
    if (sender && !key.fromMe) setContact(sender, m.pushName);
    if (key.remoteJid && !isJidGroup(key.remoteJid) && !key.fromMe) {
      setChat(key.remoteJid, m.pushName);
    }
  }

  function resolveChatName(chatJid) {
    if (!chatJid) return null;
    if (chatNames.has(chatJid)) return chatNames.get(chatJid);
    if (!isJidGroup(chatJid)) return contactNames.get(chatJid) || jidToPhone(chatJid);
    return null;
  }
  function resolveSenderName(m, selfName) {
    const key = m?.key || {};
    if (key.fromMe) return selfName || 'Me';
    const sender = key.participant || key.remoteJid;
    return cleaner(m.pushName) || contactNames.get(sender) || jidToPhone(sender) || null;
  }

  // Best human display name for a phone-keyed person (+<digits>), or null if the
  // only thing we ever saw for them was the number itself. Used by the memory-
  // note layer to replace a bare number with the name WhatsApp displays.
  function resolveDisplayForPhone(phone) {
    if (!phone) return null;
    return phoneNames.get(phone) || null;
  }

  // Flat { phone -> name } snapshot for persistence into whatsapp_entity so the
  // name survives across runs (later deltas don't re-see contact events).
  function phoneNamePairs() {
    return [...phoneNames.entries()];
  }

  return {
    ingestContacts,
    ingestChats,
    ingestGroupMetadata,
    ingestMessage,
    resolveChatName,
    resolveSenderName,
    resolveDisplayForPhone,
    phoneNamePairs,
    _sizes: () => ({ contacts: contactNames.size, chats: chatNames.size, phones: phoneNames.size }),
  };
}
