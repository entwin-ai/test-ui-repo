# Change — persist WhatsApp display names, stop showing bare phone numbers

## What was asked

In the graph and in the memory notes, unsaved WhatsApp contacts were surfacing as
raw phone numbers (`+595 4980 544…`, `+1……94`, etc.). Extract the display name
WhatsApp actually shows for a contact — whether or not it is saved in the phone's
address book, as long as a display name is visible — persist it, and use that
name in the chats/memory notes in place of the phone number wherever possible.

## Why the numbers were showing

The name a WhatsApp contact shows comes from several Baileys events, in order of
strength: a saved contact `name`, a business `verifiedName`, and the `pushName`
(`notify`) that rides on incoming messages. `pushName` is the label WhatsApp
renders for an **unsaved** incoming contact — but the pipeline only persisted a
`display_name` for a contact that also carried a durable **username**, so every
username-less unsaved contact lost its name and decayed to the phone number:

- `wa-entities.js#ingestContact` returned early when there was no username, so the
  pushName/verifiedName it had in hand was thrown away.
- `pushName` harvested off messages was never fed to the entity registry at all.
- The message-row label (`chat_name`/`sender_name`) fell straight back to the
  jid-derived phone number, and the memory-note layer used that number as the
  note's entity label.

## What changed

**`worker/src/lib/wa-entities.js`**
- `ingestContact` now records `display_name` from `name → verifiedName → notify`
  **even when there is no username** (an unsaved contact still has a visible
  name). A source-strength rank (saved 3 / verified 2 / pushName 1) means a
  weaker pushName never overwrites a stronger saved name regardless of event
  order.
- New `ingestPushName(jid, pushName)` records the pushName off a message as the
  weakest-rank display name.
- `cleaner()` rejects a bare phone number as a "name", so a numeric
  `notify`/`name` is never persisted as `display_name`.

**`worker/src/lib/wa-names.js`**
- Harvests every contact/chat/pushName into a `phone → best human name` map and
  exposes `resolveDisplayForPhone(phone)`. `cleaner()` rejects numeric strings so
  a number can never win as a name; a real pushName is preferred over it.

**`worker/src/pipeline/whatsapp-capture.js`**
- Feeds each incoming message's `pushName` into the entity registry
  (`entityReg.ingestPushName`).
- `toRow` now labels a 1:1 `chat_name`/`sender_name` with the resolved human name
  (entity `display_name`, then the phone-keyed name map) and only falls back to
  the phone when nothing better exists. Groups keep their subject.

**`worker/src/pipeline/whatsapp.js`**
- New `resolveEntityLabel()` picks the memory-note label as: a non-numeric row
  name → the persisted `whatsapp_entity.display_name` → (last resort) the
  phone/jid. `processEntityDay` uses it, so **both** newly captured rows and rows
  captured before this change render with the real name once the entity's
  `display_name` is known.

## Schema

None. `whatsapp_entity.display_name` (migration 0016) already exists — this change
just populates it for unsaved contacts and reads it at note time. No migration to
apply.

## Notes / limits

- The name persists across runs via `whatsapp_entity`, so later deltas that don't
  re-see the contact events still resolve the name.
- If WhatsApp genuinely has no name for a number (never saved, no pushName, not a
  business), it stays a phone number — that's the true fallback, unchanged.
- Old memory-note rows whose entity had no name at capture time upgrade
  automatically on their next processing pass once `display_name` is populated;
  already-written note text is not rewritten retroactively (the label field is).

## Verify

- `node --check` clean on all four changed files.
- 7 behavioral assertions pass: pushName harvest, numeric-name rejection,
  saved-name-beats-pushName precedence (both registries), and pushName-only
  person persisted.
