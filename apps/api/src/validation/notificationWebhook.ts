import type { ApprovalConfig } from "@openbots/graph-schema";

/**
 * Operator-level allowlist for approval-gate notification webhook URLs —
 * the same empty-deny, save-time-plus-delivery-time shape as
 * ALLOWED_HTTP_ENDPOINTS/ALLOWED_MCP_SERVERS, and for the same reason.
 * Without it, anyone who can edit a graph (open signup) can make the
 * worker POST to http://169.254.169.254/ or an internal service the
 * instant a run pauses. Prefixes are scheme+host[+path]; a candidate
 * must share origin with a prefix and sit on or under that prefix's path.
 *
 * Comma-separated, e.g.
 * "https://hooks.slack.com/services,https://api.example.com/webhooks"
 */
export function getAllowedNotificationWebhookPrefixes(): string[] {
  const raw = process.env.ALLOWED_NOTIFICATION_WEBHOOKS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

// Same reasoning as httpEndpoint.ts's identical set: a credential sitting
// in a webhook URL would end up in plaintext in node config, logs, and
// browser history. There's no credentialProvider field to redirect to
// here (a notification webhook has no configurable auth), so this is a
// flat rejection rather than a pointer elsewhere.
const CREDENTIAL_SHAPED_QUERY_PARAMS = new Set([
  "api_key",
  "apikey",
  "key",
  "token",
  "access_token",
  "secret",
  "client_secret",
  "password",
]);

function parseHttpUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  for (const key of url.searchParams.keys()) {
    if (CREDENTIAL_SHAPED_QUERY_PARAMS.has(key.toLowerCase())) return null;
  }
  return url;
}

/** Path-boundary prefix: /webhooks matches /webhooks and /webhooks/x, not /webhooks-internal. */
function pathIsUnderPrefix(candidatePath: string, prefixPath: string): boolean {
  if (prefixPath === "/" || prefixPath === "") return true;
  if (candidatePath === prefixPath) return true;
  const prefixDir = prefixPath.endsWith("/") ? prefixPath : `${prefixPath}/`;
  return candidatePath.startsWith(prefixDir);
}

export function isNotificationWebhookUrlAllowed(candidate: string): boolean {
  const url = parseHttpUrl(candidate);
  if (!url) return false;
  return getAllowedNotificationWebhookPrefixes().some((raw) => {
    const prefix = parseHttpUrl(raw);
    if (!prefix) return false;
    if (prefix.protocol !== url.protocol) return false;
    if (prefix.host !== url.host) return false;
    return pathIsUnderPrefix(url.pathname, prefix.pathname);
  });
}

/**
 * Callable directly (not just via zod), same reasoning as
 * checkHttpEndpointsAllowed/checkMcpServersAllowed: graphMutations builds
 * plain objects rather than always parsing an HTTP body.
 */
export function checkNotificationWebhookAllowed(approvalConfig: ApprovalConfig | null | undefined): string | null {
  const url = approvalConfig?.notifyWebhookUrl;
  if (!url) return null;
  if (!parseHttpUrl(url)) {
    return "approvalConfig.notifyWebhookUrl must be http(s) with no embedded credentials";
  }
  if (!isNotificationWebhookUrlAllowed(url)) {
    return "approvalConfig.notifyWebhookUrl must be within an operator-configured prefix (see ALLOWED_NOTIFICATION_WEBHOOKS)";
  }
  return null;
}
