import makeWASocket, {
  Browsers,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { admin } from './lib/supabase.js';
import { useRedisAuthState, hasCreds } from './lib/wa-auth-store.js';

// ONE-TIME WhatsApp pairing.
//
// The hourly batch job (MODE=whatsapp-sync) reuses saved credentials and never
// needs the interactive code round-trip. But the FIRST device link does — so
// this script is run once per user, out of band, to establish that link and
// store the credentials in Redis. After it succeeds, the hourly job takes over.
//
// Run it either:
//   * locally:   USER_EMAIL=you@x.com WA_PHONE=13125551234 npm run pair
//   * or via the manually-dispatched `whatsapp-pair` GitHub Actions workflow,
//     reading the printed pairing code from the job logs.
//
// It keeps the socket open only long enough for you to type the code on your
// phone (WhatsApp → Settings → Linked devices → Link with phone number), then
// saves creds and exits. This is the only step that needs a live socket, and
// it's a one-minute, one-time operation — not ongoing hosting.

const logger = pino({ level: process.env.WA_LOG_LEVEL || 'silent' });

const USER_EMAIL = process.env.USER_EMAIL;
const WA_PHONE = (process.env.WA_PHONE || '').replace(/\D/g, '');
const PAIR_TIMEOUT_MS = Number(process.env.WA_PAIR_TIMEOUT_MS || 180_000); // 3 min to enter the code
const INITIAL_WINDOW_DAYS = 30;

function fail(msg) {
  console.error(`pair: ${msg}`);
  process.exit(1);
}

async function ensureSyncStateRow() {
  const floorIso = new Date(Date.now() - INITIAL_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await admin.from('sync_state').upsert(
    {
      user_email: USER_EMAIL,
      card_id: 'whatsapp',
      channel: 'whatsapp',
      backfill_done: false,
      wa_backfill_after: floorIso,
    },
    { onConflict: 'user_email,card_id' },
  );
  if (error) throw new Error(`sync_state: ${error.message}`);
}

async function main() {
  if (!USER_EMAIL) fail('set USER_EMAIL');
  if (WA_PHONE.length < 8 || WA_PHONE.length > 15) fail('set WA_PHONE to digits incl. ISD code, e.g. 13125551234');

  if (await hasCreds(USER_EMAIL)) {
    console.log(`pair: ${USER_EMAIL} already has registered credentials — nothing to do.`);
    // Still make sure the sync_state row exists so the hourly job enumerates it.
    await ensureSyncStateRow();
    process.exit(0);
  }

  await ensureSyncStateRow();

  const { state, saveCreds, flush } = await useRedisAuthState(USER_EMAIL);

  // A single hard timeout spans the whole pairing attempt, including any
  // reconnects during the post-code handshake.
  let done = false;
  let codeRequested = false;
  const hardTimer = setTimeout(async () => {
    if (done) return;
    done = true;
    await flush().catch(() => {});
    fail('timed out waiting for the device link to complete');
  }, PAIR_TIMEOUT_MS);

  // After you enter the code, WhatsApp restarts the stream (status 515) and
  // sometimes drops it once or twice (428) before the session goes `open`.
  // Each of those is a *reconnect*, not a failure — so we (re)build the socket
  // on close and only give up once we've exhausted our reconnect budget or the
  // hard timeout fires.
  const MAX_RECONNECTS = 5;
  let reconnects = 0;

  async function connect() {
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: true,
      browser: Browsers.ubuntu('Chrome'),
    });

    sock.ev.on('creds.update', saveCreds);

    // Request the pairing code up front (once), not on a `qr` event. For
    // phone-number pairing there is no QR, and waiting for one lets the server
    // close the socket (428) before we ever ask. Only do this on the first
    // connect, before the device is registered.
    if (!codeRequested && !sock.authState.creds.registered) {
      setTimeout(async () => {
        if (codeRequested || sock.authState.creds.registered) return;
        codeRequested = true;
        try {
          const code = await sock.requestPairingCode(WA_PHONE);
          const pretty = code.match(/.{1,4}/g)?.join('-') ?? code;
          console.log('\n==================================================');
          console.log(`  WhatsApp pairing code for ${USER_EMAIL}: ${pretty}`);
          console.log('  On your phone: WhatsApp → Settings → Linked devices');
          console.log('  → Link a device → Link with phone number → enter the code');
          console.log('==================================================\n');
        } catch (e) {
          if (done) return;
          done = true;
          clearTimeout(hardTimer);
          fail(`WhatsApp rejected the pairing request: ${e.message}`);
        }
      }, 3000);
    }

    sock.ev.on('connection.update', async (u) => {
      if (done) return;

      if (u.connection === 'open') {
        done = true;
        clearTimeout(hardTimer);
        await flush().catch(() => {});
        console.log(`pair: ${USER_EMAIL} linked successfully. Credentials saved to Redis.`);
        console.log('pair: the hourly whatsapp-sync job will now ingest messages.');
        try { sock.end(undefined); } catch {}
        process.exit(0);
      }

      if (u.connection === 'close') {
        const status = u.lastDisconnect?.error?.output?.statusCode;

        // If we never got as far as requesting a code, the handshake failed
        // outright — no point reconnecting.
        if (!codeRequested) {
          done = true;
          clearTimeout(hardTimer);
          fail(`connection closed before pairing (status ${status ?? 'unknown'}) — try again`);
        }

        // 401 = logged out / credentials rejected: reconnecting won't help.
        if (status === 401) {
          done = true;
          clearTimeout(hardTimer);
          fail('device link was rejected (status 401) — start a fresh pairing');
        }

        // Otherwise this is a normal restart in the pairing handshake
        // (515 stream-restart, 428 transient close). Reconnect and let the
        // registered creds carry the session to `open`.
        try { sock.end(undefined); } catch {}
        if (reconnects >= MAX_RECONNECTS) {
          done = true;
          clearTimeout(hardTimer);
          fail(`too many reconnects during pairing (last status ${status ?? 'unknown'}) — try again`);
        }
        reconnects += 1;
        await flush().catch(() => {});
        setTimeout(() => { connect().catch((e) => fail(e.message)); }, 1500);
      }
    });
  }

  await connect();
}

main().catch((e) => fail(e.message));
