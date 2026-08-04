import makeWASocket, {
  Browsers,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { admin } from './lib/supabase.js';
import { useRedisAuthState, hasCreds, clearAuthState } from './lib/wa-auth-store.js';
import { publishPairCode, clearPairCode } from './lib/wa-paircode.js';

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

  // FORCE_REPAIR=1 wipes any existing device link first. Use this when a prior
  // link is half-broken — e.g. the device shows Linked but sync closes with 428,
  // or you unlinked from the phone and need a clean re-pair. WhatsApp refuses to
  // re-pair a number it still considers linked, so clearing the stale creds is
  // what breaks the 428 loop.
  const FORCE_REPAIR = /^(1|true|yes)$/i.test(process.env.FORCE_REPAIR || '');
  if (FORCE_REPAIR) {
    console.log(`pair: FORCE_REPAIR set — clearing existing credentials for ${USER_EMAIL}.`);
    await clearAuthState(USER_EMAIL).catch((e) => console.error(`pair: clear failed: ${e.message}`));
  }

  if (!FORCE_REPAIR && (await hasCreds(USER_EMAIL))) {
    console.log(`pair: ${USER_EMAIL} already has registered credentials — nothing to do.`);
    console.log('pair: to force a clean re-link, re-run this workflow with FORCE_REPAIR=1.');
    // Still make sure the sync_state row exists so the hourly job enumerates it.
    await ensureSyncStateRow();
    process.exit(0);
  }

  await ensureSyncStateRow();

  const { state, saveCreds, flush } = await useRedisAuthState(USER_EMAIL);

  let done = false;
  let codeRequested = false;
  const hardTimer = setTimeout(async () => {
    if (done) return;
    done = true;
    await flush().catch(() => {});
    fail('timed out waiting for the device link to complete');
  }, PAIR_TIMEOUT_MS);

  // After the code is entered, WhatsApp restarts the stream (515) and sometimes
  // drops it (428) once or twice before the session goes `open`. Each is a
  // reconnect, not a failure — rebuild the socket on close, reusing the shared
  // auth state (which by then holds the registered creds), until `open` or the
  // reconnect budget / hard timeout is hit.
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

    // Request the code up front (once), NOT on a `qr` event. Phone-number
    // pairing has no QR; waiting for one lets the server close the socket (428)
    // before we ever ask — which is exactly the 2-second failure you saw.
    if (!codeRequested && !sock.authState.creds.registered) {
      setTimeout(async () => {
        if (done || codeRequested || sock.authState.creds.registered) return;
        codeRequested = true;
        try {
          const code = await sock.requestPairingCode(WA_PHONE);
          const pretty = code.match(/.{1,4}/g)?.join('-') ?? code;
          // Publish to Redis so the app's connectors tab can show the code
          // directly, instead of the user opening the Actions log. Best-effort:
          // never let a Redis hiccup break pairing.
          publishPairCode(USER_EMAIL, code, WA_PHONE).catch((e) =>
            console.error(`pair: could not publish code to Redis: ${e.message}`)
          );
          console.log('\n==================================================');
          console.log(`  WhatsApp pairing code for ${USER_EMAIL}: ${pretty}`);
          console.log('  On your phone: WhatsApp → Settings → Linked devices');
          console.log('  → Link a device → Link with phone number → enter the code');
          console.log('  (this code now also appears in the Entwin connectors tab)');
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
        // Device linked — remove the published code so the UI stops showing it.
        await clearPairCode(USER_EMAIL).catch(() => {});
        console.log(`pair: ${USER_EMAIL} linked successfully. Credentials saved to Redis.`);
        console.log('pair: the hourly whatsapp-sync job will now ingest messages.');
        try { sock.end(undefined); } catch {}
        process.exit(0);
      }

      if (u.connection === 'close') {
        const status = u.lastDisconnect?.error?.output?.statusCode;

        // Never even got to request a code → outright handshake failure.
        if (!codeRequested) {
          done = true;
          clearTimeout(hardTimer);
          fail(`connection closed before pairing (status ${status ?? 'unknown'}) — try again`);
        }
        // Credentials rejected — reconnecting won't help.
        if (status === 401) {
          done = true;
          clearTimeout(hardTimer);
          fail('device link was rejected (status 401) — start a fresh pairing');
        }
        // Otherwise a normal restart in the handshake: reconnect.
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
