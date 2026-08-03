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

  let codeRequested = false;
  const hardTimer = setTimeout(async () => {
    await flush().catch(() => {});
    fail('timed out waiting for you to enter the pairing code on your phone');
  }, PAIR_TIMEOUT_MS);

  // Request the pairing code up front — do NOT wait for a `qr` event. For
  // phone-number pairing the socket never needs a QR, and waiting for one lets
  // the server close the connection (status 428/515) before we ever ask.
  async function requestCode() {
    if (codeRequested) return;
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
      clearTimeout(hardTimer);
      fail(`WhatsApp rejected the pairing request: ${e.message}`);
    }
  }

  // Ask for the code once the socket exists and isn't already registered.
  // A small delay lets the initial WS handshake settle before the request.
  if (!sock.authState.creds.registered) {
    setTimeout(requestCode, 3000);
  }

  sock.ev.on('connection.update', async (u) => {
    if (u.connection === 'open') {
      clearTimeout(hardTimer);
      await flush().catch(() => {});
      console.log(`pair: ${USER_EMAIL} linked successfully. Credentials saved to Redis.`);
      console.log('pair: the hourly whatsapp-sync job will now ingest messages.');
      try { sock.end(undefined); } catch {}
      process.exit(0);
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      // Once the code has been requested, a 428/515 close is a normal restart
      // in the pairing handshake — reconnect instead of failing. Only fatal if
      // we never got to request a code at all.
      if (!codeRequested) {
        clearTimeout(hardTimer);
        fail(`connection closed before pairing (status ${code ?? 'unknown'}) — try again`);
      }
    }
  });
}

main().catch((e) => fail(e.message));
