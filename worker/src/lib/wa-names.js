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

export function createNameRegistry() {
  const contactNames = new Map(); // jid -> display name
  const chatNames = new Map();    // chat jid -> label (group subject / 1:1 name)

  const cleaner = (s) => {
    if (typeof s !== 'string') return null;
    const t = s.trim();
    return t.length ? t : null;
  };

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

  return {
    ingestContacts,
    ingestChats,
    ingestGroupMetadata,
    ingestMessage,
    resolveChatName,
    resolveSenderName,
    _sizes: () => ({ contacts: contactNames.size, chats: chatNames.size }),
  };
}
