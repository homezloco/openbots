import type { HttpEndpoint } from "@openbots/graph-schema";

/**
 * Operator-level allowlist for http_request endpoint base URLs — the same
 * empty-deny, save-time-plus-runtime shape as ALLOWED_MCP_SERVERS, and for
 * the same reason. Without it, anyone who can edit a graph (open signup)
 * can make the worker fetch http://169.254.169.254/ or an internal
 * service. Prefixes are scheme+host[+path]; a candidate must share origin
 * with a prefix and sit on or under that prefix's path.
 *
 * Comma-separated, e.g.
 * "https://api.example.com,https://internal.example.org/v2"
 */
export function getAllowedHttpEndpointPrefixes(): string[] {
  const raw = process.env.ALLOWED_HTTP_ENDPOINTS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

// Exact param-name match (case-insensitive), not substring — so a
// legitimate param merely containing one of these words (e.g. "monkey")
// isn't caught. Same "a credential doesn't belong in a URL" reasoning as
// the userinfo check below: a token sitting in a baseUrl would end up in
// plaintext in node config, logs, and browser history.
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

/** Path-boundary prefix: /v2 matches /v2 and /v2/users, not /v2-internal. */
function pathIsUnderPrefix(candidatePath: string, prefixPath: string): boolean {
  if (prefixPath === "/" || prefixPath === "") return true;
  if (candidatePath === prefixPath) return true;
  const prefixDir = prefixPath.endsWith("/") ? prefixPath : `${prefixPath}/`;
  return candidatePath.startsWith(prefixDir);
}

export function isHttpEndpointUrlAllowed(candidate: string): boolean {
  const url = parseHttpUrl(candidate);
  if (!url) return false;
  return getAllowedHttpEndpointPrefixes().some((raw) => {
    const prefix = parseHttpUrl(raw);
    if (!prefix) return false;
    if (prefix.protocol !== url.protocol) return false;
    if (prefix.host !== url.host) return false;
    return pathIsUnderPrefix(url.pathname, prefix.pathname);
  });
}

/**
 * Callable directly (not just via zod), same reasoning as
 * checkMcpServersAllowed/checkFileAccessRootAllowed: graphMutations and
 * the cross-graph management tools build plain objects rather than always
 * parsing an HTTP body, so the check has to be invokable from both places
 * without duplicating it.
 */
export function checkHttpEndpointsAllowed(endpoints: HttpEndpoint[] | null | undefined): string | null {
  if (!endpoints || endpoints.length === 0) return null;
  const slugs = new Set<string>();
  for (const endpoint of endpoints) {
    if (slugs.has(endpoint.slug)) return `httpEndpoints has a duplicate slug: "${endpoint.slug}"`;
    slugs.add(endpoint.slug);
    if (!parseHttpUrl(endpoint.baseUrl)) {
      return `httpEndpoints.${endpoint.slug} baseUrl must be http(s) with no embedded credentials`;
    }
    if (!isHttpEndpointUrlAllowed(endpoint.baseUrl)) {
      return `httpEndpoints.${endpoint.slug} baseUrl must be within an operator-configured prefix (see ALLOWED_HTTP_ENDPOINTS)`;
    }
  }
  return null;
}
