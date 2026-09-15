/**
 * Status-aware retry with exponential backoff: retry on transient failures
 * (429/502/503/504, connection resets) and never on other 4xx errors (bad
 * request, auth, not-found) — matching the policy in warpmux's ai.rs retry
 * helper. Without this, any transient provider hiccup fails the whole hop
 * (see docs/adapters.md).
 */
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"]);

function isRetryable(err: unknown): boolean {
  const statusCode = (err as { statusCode?: number })?.statusCode;
  if (typeof statusCode === "number") return RETRYABLE_STATUS_CODES.has(statusCode);

  const code = (err as { code?: string })?.code;
  if (typeof code === "string") return RETRYABLE_ERROR_CODES.has(code);

  return false;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
}

/**
 * A real hop failed with "Failed after 3 attempts. Last error:
 * AI_APICallError: Cannot connect to API" — a short network blip to the
 * provider outlived all 3 attempts because the old 500ms/1000ms backoff
 * fired them too close together to give a transient connection issue any
 * real chance to clear. baseDelayMs=1000 with a x4 multiplier spaces
 * retries at ~1s then ~4s/~16s (plus jitter, so concurrent hops retrying
 * the same blip don't all land on the same instant). Two exceptions to
 * that fixed schedule: a 429 carrying Retry-After (or a "try again in
 * Xs" message) waits out the server's stated window instead — per-minute
 * rate ceilings can't be beaten by retrying faster — and every delay is
 * capped at MAX_RETRY_DELAY_MS so a long server hint can't park a worker
 * slot past the hop's own deadline budget.
 */
const JITTER_MS = 250;
// Never wait past this even if the server asks for more — the hop has its
// own deadline budget, and a Retry-After of minutes would hold the worker
// slot long past the point of usefulness.
const MAX_RETRY_DELAY_MS = 90_000;

/**
 * Per-minute rate limits (429 on TPM/RPM ceilings) need a wait on the
 * order of the window — the generic ~1s/~4s backoff retries inside the
 * same minute and burns every attempt while the server explicitly says
 * how long to wait. Honor the standard Retry-After header (seconds or
 * HTTP-date) when present; fall back to the "try again in Xs" phrasing
 * some providers embed in the error message (Groq does when the header
 * is absent). Applies to every provider — it's a standard mechanism,
 * not a Groq quirk.
 */
function retryAfterMs(err: unknown): number | null {
  const headers = (err as { responseHeaders?: Record<string, string> })?.responseHeaders;
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (raw) {
    const secs = Number(raw);
    if (Number.isFinite(secs)) return secs * 1000;
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const message = (err as { message?: string })?.message;
  const m = message?.match(/try again in ([\d.]+)\s*s/i);
  return m ? Number(m[1]) * 1000 : null;
}

export async function withRetry<T>(
  task: () => Promise<T>,
  { maxAttempts = 4, baseDelayMs = 1000 }: RetryOptions = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await task();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts || !isRetryable(err)) throw err;
      const delay =
        Math.min(retryAfterMs(err) ?? baseDelayMs * 4 ** (attempt - 1), MAX_RETRY_DELAY_MS) +
        Math.random() * JITTER_MS;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
