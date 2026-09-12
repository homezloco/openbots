import type { McpServer } from "@openbots/graph-schema";

/**
 * Operator-level allowlist for MCP server URLs — same empty-deny,
 * save-time-plus-runtime shape as ALLOWED_FILE_ACCESS_ROOTS. Without it,
 * anyone who can edit a graph (open signup) can make the worker fetch
 * http://169.254.169.254/ or an internal Redis. Prefixes are
 * scheme+host[+path]; a candidate must share origin with a prefix and
 * sit on or under that prefix's path.
 *
 * Comma-separated, e.g.
 * "https://api.githubcopilot.com,http://mcp-echo:3930,http://127.0.0.1:3930"
 */
export function getAllowedMcpServerPrefixes(): string[] {
  const raw = process.env.ALLOWED_MCP_SERVERS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

// Exact param-name match (case-insensitive), not substring — so a
// legitimate param merely containing one of these words (e.g. "monkey")
// isn't caught. Same "a credential doesn't belong in a URL" reasoning
// as the userinfo check below it: this is exactly the shape some
// hosted MCP servers' own URLs use (e.g. Smithery's ?api_key=...),
// which would otherwise sit in plaintext in node config, logs, and
// browser history.
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

/** Path-boundary prefix: /mcp matches /mcp and /mcp/v1, not /mcp-evil. */
function pathIsUnderPrefix(candidatePath: string, prefixPath: string): boolean {
  if (prefixPath === "/" || prefixPath === "") return true;
  if (candidatePath === prefixPath) return true;
  const prefixDir = prefixPath.endsWith("/") ? prefixPath : `${prefixPath}/`;
  return candidatePath.startsWith(prefixDir);
}

export function isMcpServerUrlAllowed(candidate: string): boolean {
  const url = parseHttpUrl(candidate);
  if (!url) return false;
  return getAllowedMcpServerPrefixes().some((raw) => {
    const prefix = parseHttpUrl(raw);
    if (!prefix) return false;
    if (prefix.protocol !== url.protocol) return false;
    if (prefix.host !== url.host) return false;
    return pathIsUnderPrefix(url.pathname, prefix.pathname);
  });
}

/**
 * Callable directly (not just via zod), same reasoning as
 * checkFileAccessRootAllowed: graphMutations and the cross-graph tools
 * build plain objects rather than always parsing an HTTP body.
 */
export function checkMcpServersAllowed(servers: McpServer[] | null | undefined): string | null {
  if (!servers || servers.length === 0) return null;
  const slugs = new Set<string>();
  for (const server of servers) {
    if (slugs.has(server.slug)) return `mcpServers has a duplicate slug: "${server.slug}"`;
    slugs.add(server.slug);
    if (!parseHttpUrl(server.url)) {
      return `mcpServers.${server.slug} url must be http(s) with no embedded credentials`;
    }
    if (!isMcpServerUrlAllowed(server.url)) {
      return `mcpServers.${server.slug} url must be within an operator-configured prefix (see ALLOWED_MCP_SERVERS)`;
    }
  }
  return null;
}
