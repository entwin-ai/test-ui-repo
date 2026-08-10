// Minimal Slack Web API client for the worker. User-token, read-only.
// Handles Slack's 429 rate limiting (Retry-After) transparently so the capture
// step can walk every conversation's history without tripping Tier-3 limits.

const SLACK_API = 'https://slack.com/api';

async function slackCall(token, method, params) {
  const url = new URL(`${SLACK_API}/${method}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  // Retry loop for 429s. Slack tells us how long to wait via Retry-After.
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 429) {
      const retry = parseInt(res.headers.get('retry-after') || '1', 10);
      await new Promise((r) => setTimeout(r, (retry + 1) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`Slack ${method} HTTP ${res.status}`);
    const json = await res.json();
    if (!json.ok) {
      // ratelimited can also arrive in the body without a 429 status.
      if (json.error === 'ratelimited') {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw new Error(json.error || `Slack ${method} failed`);
    }
    return json;
  }
  throw new Error(`Slack ${method} gave up after repeated rate limiting`);
}

// Enumerate every conversation the user can read (public/private/mpim/im).
//
// Slack Ingestion Read Me §4: archiving is a LIVE state Entwin reads directly,
// and an archived entity is the Ignore tier (write nothing). We therefore do NOT
// pass exclude_archived — we WANT archived conversations in the list so the
// classifier can read their live `is_archived` flag and route them to Ignore,
// rather than silently never seeing them. (An archived channel that later
// unarchives then reappears naturally.)
export async function listConversations(token, { includeArchived = true } = {}) {
  const out = [];
  let cursor = '';
  let pages = 0;
  do {
    const resp = await slackCall(token, 'conversations.list', {
      types: 'public_channel,private_channel,mpim,im',
      exclude_archived: includeArchived ? false : true,
      limit: 200,
      cursor: cursor || undefined,
    });
    for (const c of resp.channels || []) out.push(c);
    cursor = resp.response_metadata?.next_cursor || '';
    pages += 1;
    if (pages >= 25) break;
  } while (cursor);
  return out;
}

// Async-iterate a channel's messages since `oldest` (unix seconds string),
// yielding pages of raw Slack message objects.
export async function* channelHistory(token, channelId, oldest) {
  let cursor = '';
  let pages = 0;
  do {
    let resp;
    try {
      resp = await slackCall(token, 'conversations.history', {
        channel: channelId,
        oldest,
        limit: 200,
        cursor: cursor || undefined,
      });
    } catch (err) {
      // A channel the token can't read contributes nothing rather than aborting
      // the whole capture.
      if (['not_in_channel', 'channel_not_found', 'missing_scope'].includes(err.message)) {
        return;
      }
      throw err;
    }
    yield resp.messages || [];
    cursor = resp.response_metadata?.next_cursor || '';
    pages += 1;
    if (pages >= 20) return; // history page cap per channel (~4,000 msgs)
  } while (cursor);
}

// Resolve a Slack user id -> display name (cached by the caller).
export async function userName(token, userId) {
  if (!userId) return null;
  try {
    const resp = await slackCall(token, 'users.info', { user: userId });
    return resp.user?.profile?.display_name || resp.user?.profile?.real_name || null;
  } catch {
    return null;
  }
}

// Best-effort permalink for a message (deep link back into Slack).
export async function permalink(token, channelId, ts) {
  try {
    const resp = await slackCall(token, 'chat.getPermalink', {
      channel: channelId,
      message_ts: ts,
    });
    return resp.permalink || null;
  } catch {
    return null;
  }
}

// Slack ts ("1699999999.001200") -> ISO timestamp.
export function tsToIso(ts) {
  const seconds = Number(String(ts).split('.')[0]);
  return new Date(seconds * 1000).toISOString();
}
