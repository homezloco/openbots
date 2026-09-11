/**
 * Thin, read-only wrapper around Smithery's MCP server registry API —
 * powers AgentSettingsForm's "Browse MCP servers" picker so an operator
 * can find a real, working MCP server URL instead of hand-typing one.
 * Modeled on github.ts's githubApiRequest (a plain third-party REST
 * client with one bearer key), not orchestrator/mcpTool.ts — this isn't
 * an LLM-facing tool, so it doesn't belong under orchestrator/.
 *
 * "Verified" in Smithery's response is an identity/ownership signal,
 * not a security audit — surfaced as-is to the caller, but never
 * described as a safety claim anywhere this data is used.
 *
 * Purely discovery: nothing here ever grants MCP access by itself. The
 * operator-level ALLOWED_MCP_SERVERS allowlist (validation/mcpServer.ts)
 * is untouched by this module and remains the actual security boundary.
 */

const SMITHERY_BASE_URL = "https://api.smithery.ai";
const CACHE_TTL_MS = 45_000;

export function smitheryConfigured(): boolean {
  return Boolean(process.env.SMITHERY_API_KEY);
}

interface CacheEntry {
  expiresAt: number;
  data: unknown;
}

// Single api container (see docker-compose.yml, no replicas), so an
// in-memory cache is fully effective, not a partial per-replica mitigation.
const cache = new Map<string, CacheEntry>();

async function smitheryRequest(path: string, cacheKey?: string): Promise<any> {
  if (cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return hit.data;
  }

  const key = process.env.SMITHERY_API_KEY;
  const res = await fetch(`${SMITHERY_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  const body: any = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.message ?? `Smithery API request failed with status ${res.status}`);
  }

  if (cacheKey) cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, data: body });
  return body;
}

export interface SmitheryServerSummary {
  qualifiedName: string;
  displayName: string;
  description: string;
  iconUrl: string | null;
  verified: boolean;
  useCount: number;
  homepage: string | null;
  owner: string;
}

export interface SmitheryServerSearchResult {
  servers: SmitheryServerSummary[];
  totalCount: number;
  totalPages: number;
}

/**
 * remote is always forced true — a stdio-only result can never be used
 * (connectMcp only ever tries Streamable HTTP / SSE; stdio MCP is
 * deliberately forbidden throughout this codebase).
 */
export async function searchSmitheryServers(
  q: string,
  page: number,
  pageSize: number,
  verifiedOnly: boolean,
): Promise<SmitheryServerSearchResult> {
  const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize), remote: "true" });
  if (verifiedOnly) params.set("verified", "true");
  const cacheKey = params.toString();
  const data = await smitheryRequest(`/servers?${params.toString()}`, cacheKey);

  const servers: SmitheryServerSummary[] = (Array.isArray(data?.servers) ? data.servers : []).map((s: any) => ({
    qualifiedName: String(s.qualifiedName ?? ""),
    displayName: String(s.displayName ?? s.qualifiedName ?? ""),
    description: String(s.description ?? ""),
    iconUrl: typeof s.iconUrl === "string" ? s.iconUrl : null,
    verified: Boolean(s.verified),
    useCount: typeof s.useCount === "number" ? s.useCount : 0,
    homepage: typeof s.homepage === "string" ? s.homepage : null,
    owner: String(s.owner ?? ""),
  }));

  return {
    servers,
    totalCount: typeof data?.pagination?.totalCount === "number" ? data.pagination.totalCount : servers.length,
    totalPages: typeof data?.pagination?.totalPages === "number" ? data.pagination.totalPages : 1,
  };
}

/**
 * Detail call, fired only on selection (never per keystroke). Returns
 * null if the server has no usable HTTP connection — e.g. stdio-only —
 * so the caller can surface a clear "not usable here" message instead
 * of a confusing generic failure.
 */
export async function getSmitheryServerUrl(qualifiedName: string): Promise<string | null> {
  // qualifiedName legitimately contains "/" (namespace/slug) — interpolated
  // raw, not encodeURIComponent'd, since Smithery's own routing expects
  // the literal path segments.
  const data = await smitheryRequest(`/servers/${qualifiedName}`);
  if (typeof data?.deploymentUrl === "string" && data.deploymentUrl) return data.deploymentUrl;
  const httpConnection = (Array.isArray(data?.connections) ? data.connections : []).find(
    (c: any) => c?.type === "http" && typeof c?.deploymentUrl === "string",
  );
  return httpConnection?.deploymentUrl ?? null;
}
