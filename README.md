# Entwin — Frontend v3 (Google sign-in + static screens)

A Next.js app whose screens are ported from `entwin_frontend_v3.html`. The navigation is reproduced exactly; **Google authentication is the only wired behavior** — every other screen is static / local-only, matching the reference prototype.

1. **Login screen** with a **Continue with Google** button.
2. Clicking it redirects to the **real Google sign-in screen** (OAuth via NextAuth, basic scopes: `openid email profile`).
3. After successful authentication, the app shell loads with the exact v3 sidebar navigation: **New chat**, **Chat**, **Connectors**, **Dashboard**, **Memory**, **Settings**, plus a collapse toggle and the signed-in user row.

### Screens (all static except Google login)

- **Chat** — local echo placeholder with a model picker (Opus 4.8 / Sonnet 5 / Haiku 4.5).
- **Connectors** — the full v3 grid (Gmail, Drive, Calendar, WhatsApp, Telegram, Slack, Browser history) with local Connect/Disconnect toggles.
- **Dashboard** — Overview / Sender Kanban (drag-and-drop) / Entity Review sub-tabs.
- **Memory** — illustrative sample graph; title follows the Entwin name set in Settings.
- **Settings** — Entwin identity, LLM backend selector, per-provider model dropdown, credential fields, Save.

The signed-in user's Google name, email, and avatar initials appear at the bottom of the sidebar, with a **Sign out** menu.

## Setup

### 1. Google OAuth credentials

1. Go to [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).
2. Create an **OAuth client ID** → Application type: **Web application**.
3. Add authorized redirect URI: `http://localhost:3000/api/auth/callback/google`
4. Copy the Client ID and Client Secret.

### 2. Environment

```bash
cp .env.local.example .env.local
```

Fill in:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=$(openssl rand -base64 32)
```

### 3. Run

```bash
npm install
npm run dev
```

Open http://localhost:3000 — you'll see the sign-in screen. Click **Continue with Google**, complete Google's consent screen, and you'll land on the Connectors page.

## Gmail connector setup

The Gmail cards ("Personal" / "Professional") connect a Google account and scan the
last 12 months of INBOX and SENT to show message counts. Two pieces of external setup
are required beyond the basic OAuth above.

### A. Enable the Gmail API

The OAuth client authenticates the user, but the Gmail **API** must be enabled in the
same Google Cloud project or scans fail with a 403 `SERVICE_DISABLED`:

1. Go to [Gmail API in the API Library](https://console.cloud.google.com/apis/library/gmail.googleapis.com), select your project, and click **Enable**.
2. Enabling takes a few minutes to propagate. (Enable **Google Drive API** too if you'll use the Drive cards.)
3. The Gmail scope `https://www.googleapis.com/auth/gmail.readonly` is requested during the Gmail card's own consent step (separate from basic login).

### B. Durable token store (Upstash Redis) — required on Vercel

On serverless platforms the OAuth callback and the scan often run on **different**
instances. Without a shared store the token saved by the callback is invisible to the
scan, which then fails with *"Gmail is not connected for this card."* A shared Redis
store fixes this.

1. Create a free Redis database at [console.upstash.com](https://console.upstash.com) (or via **Vercel → Storage → Upstash Redis**, which auto-injects the vars).
2. Copy the **REST** credentials and set them as env vars:
   ```
   UPSTASH_REDIS_REST_URL=https://your-db.upstash.io
   UPSTASH_REDIS_REST_TOKEN=your-rest-token
   ```
   The store also reads `KV_REST_API_URL`/`KV_REST_API_TOKEN` (Vercel's names) as a fallback.
3. **Redeploy** after adding env vars — Vercel only injects them into a fresh build.

Locally (single `next dev` process) the store falls back to in-memory and works without Redis.

### Large mailboxes

The scan caps at `MAX_PAGES` (20 pages × 500 = 10,000 messages) per label and runs INBOX
and SENT in parallel, so it finishes within the serverless time budget regardless of
mailbox size. If a mailbox exceeds the cap the count is a lower bound (`capped: true`).
On **Vercel Hobby** (60s function limit) a very large account may still need `MAX_PAGES`
lowered in `lib/gmail/service.ts`, or a Pro plan (up to 300s).

> **Note:** `app/api/gmail/debug/route.ts` is a temporary diagnostic that reports env-var
> presence and Redis health. **Delete it before shipping to production.**

## Project structure

```
app/
  api/auth/[...nextauth]/route.ts   # NextAuth — Google provider only, basic scopes
  layout.tsx                        # Root layout
  providers.tsx                     # SessionProvider
  globals.css                       # Styles ported from entwin_frontend_v2.html
  logo.ts                           # Embedded Entwin logo
  page.tsx                          # Login screen + post-login app shell
```

## What was removed from the original repo

- Marketing landing page components (Hero, Features, Pricing, CTA, Footer, Navigation, Privacy, ValueProposition, WelcomePopup, AuthModal) and their CSS modules
- Microsoft / Azure AD sign-in (provider + `/api/auth/microsoft` route)
- Custom JWT auth routes (`/api/auth/google`, `/api/auth/session`, `/api/auth/logout`) — NextAuth handles all of this
- `lib/auth-context.tsx` custom auth context
- Unused dependencies: `axios`, `bcryptjs`, `jsonwebtoken`, `@types/jsonwebtoken`
- Stray `index.html`, old auth docs

## WhatsApp connector (v2.1)

The WhatsApp card is now live. Because WhatsApp chats are end-to-end encrypted, a phone
number alone can't unlock messages — Entwin instead links to the user's account as a
**companion device** (same mechanism as WhatsApp Web), using
[Baileys](https://github.com/WhiskeySockets/Baileys):

1. User clicks **Connect** on the WhatsApp card and enters their mobile number
   (international format).
2. Entwin requests an **8-character pairing code** and shows it in a modal.
3. User enters the code on their phone: *WhatsApp → Settings → Linked devices →
   Link a device → Link with phone number instead*.
4. Once linked, the phone pushes chat history (`syncFullHistory`) and every new
   incoming/outgoing message in real time.

Messages are buffered server-side and flushed into a per-user vault file every
**15 minutes** (`.entwin-data/vault/<user>-whatsapp.jsonl`), toggleable from the card;
**Sync now** flushes immediately. Device credentials live in `.entwin-data/wa-auth/<user>/`
— **Disconnect** logs the device out, revokes the link, and deletes the credentials.

### API routes

| Route | Method | Purpose |
|---|---|---|
| `/api/whatsapp/connect` | POST `{phone}` | Start session, return pairing code |
| `/api/whatsapp/status` | GET | State, phone, counts, last sync |
| `/api/whatsapp/sync` | POST | Flush buffered messages to vault now |
| `/api/whatsapp/poll` | POST `{enabled}` | Toggle the 15-minute auto-sync |
| `/api/whatsapp/disconnect` | POST | Logout, revoke link, wipe credentials |
| `/api/whatsapp/messages` | GET `?limit=20` | Recent vault messages (preview) |

All routes require a signed-in NextAuth session; state is keyed per user email.

### Caveats

- Baileys is an unofficial WhatsApp Web client. It works well for read-only ingestion,
  but review WhatsApp's ToS before shipping — accounts doing bulk/automated *sending*
  get banned. This connector is passive (read-only, `markOnlineOnConnect: false`).
- Sessions are in-process. In dev they survive hot reloads via a `globalThis` handle,
  but a server restart requires re-opening the socket (credentials persist, so it
  reconnects without re-pairing — just hit Connect again with the same number).
- For production, move the service out of Next.js API routes into a long-running
  worker so the socket and 15-minute timer aren't tied to the web process.

### Deployment note (important)

On serverless hosts (Vercel, AWS Lambda) the app directory (`/var/task`) is **read-only**;
the service now falls back to `ENTWIN_DATA_DIR` (set this env var if you have a writable
mount) or the OS temp dir. That fixes the `ENOENT ... mkdir` crash, **but the connector
still can't run properly on serverless**: the Baileys websocket and the 15-minute timer
need a long-lived process, and serverless functions are killed seconds after responding —
before the user finishes entering the pairing code, and temp storage is wiped between
invocations. Deploy on a host with a persistent Node process instead: local `next start`,
a VPS, Railway/Render/Fly.io, a Docker container, or (per the roadmap) inside the Entwin
desktop app — or keep the frontend on Vercel and run the WhatsApp service as a separate
long-running worker the API routes proxy to.

## Gmail connector (v3.1) — read & parse last 1 year

The two **Gmail** cards (Personal / Professional) are now live. Entwin reads a
year of mail so the vault can know pending activities, upcoming appointments,
and who you owe a reply.

Flow, when you click **Connect** on a Gmail card:

1. The browser is sent to Google's **account chooser + consent screen**
   (`prompt=select_account consent`), where you pick the account and grant the
   read-only Gmail scope (`.../auth/gmail.readonly`). This is *incremental* —
   base sign-in only asks for `openid email profile`; mailbox access is asked
   for separately, only when you opt in on a Gmail card.
2. Google redirects to `/api/gmail/callback`, which exchanges the code for
   tokens (with a refresh token, `access_type=offline`) and stores them
   server-side per (user, card) — so the two Gmail cards can hold two accounts.
3. The app returns to **Connectors** and auto-runs a scan.
4. `/api/gmail/scan` walks the **last 12 months** of `INBOX` and `SENT`, pages
   through `messages.list`, and **de-duplicates by RFC822 `Message-Id`**.
5. The card then shows, in small font: *Inbox read: N messages* and
   *Sent read: N messages*.

Per the current spec, **email content is not saved** — messages stream through
only to be counted; the OAuth token is the only thing that persists.

### Setup additions

- Enable the **Gmail API** for your Google Cloud project.
- Add `.../auth/gmail.readonly` on the OAuth consent screen (it's a *sensitive*
  scope — in production this requires Google verification; for local testing add
  yourself as a **test user**).
- Add the second redirect URI: `http://localhost:3000/api/gmail/callback`.

### Files

```
lib/gmail/service.ts                 # OAuth URL build, token exchange/refresh,
                                     #   last-1y INBOX+SENT dedup counting
lib/gmail/route-helpers.ts           # requireUser + card-id validation
app/api/gmail/authorize/route.ts     # GET -> redirect to Google consent
app/api/gmail/callback/route.ts      # GET -> token exchange, back to app
app/api/gmail/scan/route.ts          # POST -> deduped inbox/sent counts
app/api/gmail/status/route.ts        # GET  -> connected account + last scan
app/api/gmail/disconnect/route.ts    # POST -> drop the stored token
```

### Notes

- Tokens live in an in-process `Map` (fine for a prototype). For production,
  persist them encrypted and move scanning to a background worker — a full-year
  scan of a busy mailbox makes many Gmail API calls and can take a while.
- Counting is done with `format=metadata` (Message-Id header only), so message
  bodies are never fetched — cheaper, faster, and matches the "don't save
  email" requirement.
