/**
 * Shared credential redaction — a DLP-lite safety net inspired by the
 * concept of a regex-based secret scanner (not a literal port of any
 * specific implementation). Lives here, not in apps/api, because the
 * call sites span both packages: apps/api already depends on
 * packages/providers (the correct direction), and this needs to be
 * usable from both this package's own tools.ts (read_file/
 * search_knowledge) and apps/api's tool implementations (MCP,
 * business_metrics, run_remote_command) without packages/providers
 * ever depending back on apps/api.
 *
 * Deliberately scoped to well-known, distinctive credential *shapes*
 * (AWS key IDs, GitHub/Slack/Stripe/OpenAI token prefixes, PEM blocks,
 * JWTs) — not generic high-entropy-string or key=value heuristics,
 * which would have real false-positive cost against ordinary content.
 * This is a safety net for things unambiguously shaped like
 * credentials, not a general secrets scanner.
 */

const PATTERNS: { label: string; re: RegExp }[] = [
  { label: "AWS_KEY", re: /AKIA[0-9A-Z]{16}/g },
  { label: "GITHUB_TOKEN", re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { label: "GITHUB_TOKEN", re: /github_pat_[A-Za-z0-9_]{22,}/g },
  { label: "OPENAI_KEY", re: /sk-[A-Za-z0-9]{20,}/g },
  { label: "STRIPE_KEY", re: /sk_(live|test)_[A-Za-z0-9]{20,}/g },
  { label: "SLACK_TOKEN", re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { label: "PRIVATE_KEY", re: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g },
  { label: "JWT", re: /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g },
];

/**
 * String-level redaction. Bearer/Authorization keep their existing
 * output shape exactly (this consolidates three prior near-duplicate
 * implementations that only handled these two) so no already-shipped
 * behavior changes; the new patterns get a labeled placeholder so it's
 * obvious what kind of value was caught.
 */
export function redactSecrets(text: string): string {
  let out = text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/(Authorization:\s*)\S+/gi, "$1[redacted]");
  for (const { label, re } of PATTERNS) out = out.replace(re, `[REDACTED:${label}]`);
  return out;
}

/**
 * Recursively applies redactSecrets to every string leaf in an
 * arbitrary JSON-like value — covers both plain-text tool output and
 * structured JSON (an MCP tool's structuredContent, a business_metrics
 * API response) with one function, rather than a flat-text-only
 * version that would leave structured responses uncovered.
 */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)])) as T;
  }
  return value;
}
