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
 * retries at ~1s then ~4s (plus jitter, so concurrent hops retrying the
 * same blip don't all land on the same instant) — worst case ~5s of added
 * wall clock across 3 attempts, trivial against the 180s+ hop budget, but
 * enough headroom for a brief provider-side network hiccup to pass.
 */
const JITTER_MS = 250;

export async function withRetry<T>(
  task: () => Promise<T>,
  { maxAttempts = 3, baseDelayMs = 1000 }: RetryOptions = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await task();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts || !isRetryable(err)) throw err;
      const delay = baseDelayMs * 4 ** (attempt - 1) + Math.random() * JITTER_MS;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
