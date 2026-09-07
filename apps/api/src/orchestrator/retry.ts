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

export async function withRetry<T>(
  task: () => Promise<T>,
  { maxAttempts = 3, baseDelayMs = 500 }: RetryOptions = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await task();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts || !isRetryable(err)) throw err;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
