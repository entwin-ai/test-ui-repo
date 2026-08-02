// Retry with exponential backoff + jitter. Retries on 429 (rate limit) and 5xx
// (transient server errors). Honors a Retry-After header when the provider sends
// one. Anything else (4xx auth/validation) fails fast — retrying won't help.
//
// This is what makes concurrency safe: instead of a 429 dead-lettering an email,
// the call waits and retries, so we can run many emails at once near the
// provider's ceiling without losing work.

export class RetryableError extends Error {
  constructor(message, status, retryAfterMs) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

// Parse an error thrown by provider calls to decide if it's retryable.
// Provider adapters throw `Error(`name STATUS: body`)`; we sniff the status.
function statusFrom(err) {
  if (err instanceof RetryableError) return err.status;
  const m = /\b(429|500|502|503|504)\b/.exec(String(err?.message || ''));
  return m ? parseInt(m[1], 10) : null;
}

export async function withRetry(fn, { tries = 6, baseMs = 1000, maxMs = 60000, label = 'api' } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const status = statusFrom(err);
      const retryable = status === 429 || (status >= 500 && status <= 504);
      attempt += 1;
      if (!retryable || attempt >= tries) throw err;

      // honor explicit Retry-After if the error carries it, else exp backoff
      let waitMs =
        err instanceof RetryableError && err.retryAfterMs
          ? err.retryAfterMs
          : Math.min(baseMs * 2 ** (attempt - 1), maxMs);
      waitMs += Math.random() * 250; // jitter to avoid thundering herd
      console.warn(`[retry] ${label} ${status} — attempt ${attempt}/${tries}, waiting ${Math.round(waitMs)}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}
