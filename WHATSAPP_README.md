# WhatsApp connector — hourly batch, cross-channel memory (v4.8)

WhatsApp is a first-class ingestion source that flows through the **same memory
pipeline as Gmail** (notes → embeddings → entities), so messages are queryable
via RAG and drawn on the memory map, unified with email by entity. This version
ingests WhatsApp in an **hourly batch** with **no always-on host** — everything
runs on GitHub Actions + Supabase + Redis (all free tiers).

## The model in one paragraph

WhatsApp linked devices receive an **offline sync**: when a linked device
reconnects, WhatsApp replays everything it missed while offline. So instead of
holding a socket open 24/7, a **bounded hourly GitHub Actions job** opens a
short-lived socket, lets WhatsApp drain the backlog since the last run, writes
those messages to the ledger, vectorizes them, and exits. No process runs
between hours. At hourly cadence the offline buffer comfortably covers the gap.

## Flow

```
ONE-TIME, per user:
  whatsapp-pair workflow  ─┐  opens socket, prints pairing code, you enter it on
  (or `npm run pair`)      ┘  your phone, saves creds → Redis, exits

EVERY HOUR (whatsapp-sync workflow), per linked account:
  load creds from Redis
    → open short-lived socket
    → drain WhatsApp offline backlog  ── capture → whatsapp_message rows
    → close socket, save rotated creds → Redis
    → vectorize unprocessed rows       ── memory_note + entities + note_chunk
    → done
```

The **first** hourly run after pairing does the 30-day backfill; every run after
that is delta. Both only touch `processed_at IS NULL` rows, so it's safe to run
every hour regardless of volume.

## Why this runs on GitHub Actions (when live capture couldn't)

A *continuous* socket is unbounded — wrong for Actions (6-hour job cap, fresh VM
each run). A *per-run drain* is bounded — exactly what Actions is for. The trick
is that credentials live in **Redis**, not on the ephemeral runner disk, so each
run re-authenticates from durable storage. Pairing (the one step needing an
interactive code round-trip) is done once, out of band.

## Files

**New:**
- `worker/src/lib/wa-auth-store.js` — Redis-backed Baileys auth state
  (`useRedisAuthState`, `hasCreds`, `clearAuthState`). Serializes creds/keys with
  Baileys `BufferJSON` so binary key material round-trips through Redis.
- `worker/src/pipeline/whatsapp-capture.js` — bounded per-run capture: connect,
  drain offline sync (quiet-timer + hard ceiling), persist rows, disconnect.
- `worker/src/pair-whatsapp.js` — one-time pairing (`npm run pair`).
- `.github/workflows/whatsapp-sync.yml` — hourly capture+vectorize.
- `.github/workflows/whatsapp-pair.yml` — manual one-time pairing.

**Changed:**
- `worker/src/index.js` — `MODE=whatsapp-sync` (capture then vectorize per
  account). `whatsapp-backfill|whatsapp-delta` kept as vectorize-only modes for
  manual re-processing.
- `worker/package.json` — adds `@whiskeysockets/baileys`, `@hapi/boom`, `pino`;
  `npm run pair` script.
- `lib/whatsapp/service.ts` — **no Baileys import**. Now stateless: `connect()`
  dispatches the pair workflow (or returns local `npm run pair` instructions);
  `status()` reads Redis (linked?) + Supabase (counts); `disconnect()` purges
  creds. Runs on any host, serverless included.
- `app/api/whatsapp/{connect,sync,ingest,status,disconnect,messages}` — updated
  to the dispatch/status model.
- `app/page.tsx` — `WhatsAppModal` now: enter number → pairing job dispatched →
  link to the job log for the code → polls status until linked.
- `package.json` (app) — Baileys/boom/pino removed (app holds no socket).

**Unchanged:** DB schema (migrations 0006/0007), the vectorize pipeline
(`worker/src/pipeline/whatsapp.js`), the RAG/graph cross-channel logic.

## Deploy runbook

1. **Run migrations** `0006` then `0007` on Supabase (additive; Gmail untouched).
2. **Host the app anywhere** — Vercel/serverless is fine now; no persistent host
   needed. Set the usual env vars (`.env.local.example`).
3. **Add the two WhatsApp workflows.** They reuse the existing `ingestion`
   environment secrets — no new Actions secrets (except `VOYAGE_API_KEY` if any
   user uses Claude).
4. **Pair each user once:** dispatch `whatsapp-pair` (email + phone) from the
   Actions tab, open the run log, copy the code, enter it on the phone. Or run
   `cd worker && USER_EMAIL=… WA_PHONE=… npm run pair` locally.
5. The hourly `whatsapp-sync` job then ingests unattended. "Sync now" in the UI
   dispatches an immediate run.

## Caveats (all tolerable at hourly cadence)

- **Offline-buffer dependency.** You rely on WhatsApp holding missed messages
  between runs (comfortable for an hour). The only exposure is the job failing
  *silently for many days*, letting the oldest missed messages age out — add
  failure alerting on the workflow.
- **GitHub cron is best-effort** (delays of 15–45 min; auto-disables after 60
  days of repo inactivity). For guaranteed timing, drive `workflow_dispatch`
  from Upstash QStash or Supabase pg_cron; the job body is unchanged.
- **Concurrency.** The workflow uses a concurrency group so two runs never open
  two sockets for the same device at once (which WhatsApp would reject).
- **ToS/ban risk.** Baileys is unofficial. The connector stays passive (read
  only, `markOnlineOnConnect:false`, no sending). Connect-drain-disconnect hourly
  is well within how a normal linked device behaves.
- **Media** is not ingested yet (text + captions only).
