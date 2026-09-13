import { tool, type Tool } from "ai";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { redactSecrets } from "@openbots/providers";
import type { AgentNode, HttpEndpoint } from "@openbots/graph-schema";
import { db } from "../db/client.js";
import { userCredentials } from "../db/schema.js";
import { decryptCredential } from "../auth/crypto.js";
import { checkHttpEndpointsAllowed, isHttpEndpointUrlAllowed } from "../validation/httpEndpoint.js";

/** Same cap/reasoning as codeSandboxTool's MAX_SANDBOX_OUTPUT_BYTES. */
const MAX_HTTP_RESPONSE_BYTES = 16_000;
/** Well under the default 180s hop budget, so this needs no engine timeout plumbing. */
const HTTP_TIMEOUT_MS = 15_000;

export interface HttpRequestResolution {
  tools: Record<string, Tool>;
  granted: string[];
  skipped: string[];
}

const emptyResolution = (): HttpRequestResolution => ({ tools: {}, granted: [], skipped: [] });

interface ResolvedEndpoint {
  endpoint: HttpEndpoint;
  token?: string;
}

function redactAndCap(text: string): string {
  const redacted = redactSecrets(text);
  return redacted.length > MAX_HTTP_RESPONSE_BYTES ? redacted.slice(0, MAX_HTTP_RESPONSE_BYTES) : redacted;
}

/**
 * Hop-time HTTP client for a fixed, pre-authorized set of REST endpoints.
 * Dual-gate: `"http_request"` in tools[] AND a non-empty httpEndpoints
 * list, plus a fresh ALLOWED_HTTP_ENDPOINTS re-check — node config is a
 * save-time convenience, never the security boundary (same sentence as
 * fileAccessRoot / dispatchTargets / mcpServers).
 *
 * The model supplies a SLUG, never a URL: it picks from a z.enum of the
 * node's configured endpoints, so even a fully prompt-injected tool call
 * can at absolute worst hit a host the operator already allowlisted and
 * the node was already configured for. `path` is appended to that
 * endpoint's baseUrl and must be relative, so it cannot redirect to
 * another origin.
 *
 * One tool (`http_request`), not one per endpoint — N endpoints would
 * otherwise burn N tool slots in every hop's schema for no gain.
 */
export async function resolveHttpRequestTools(node: AgentNode, ownerId: string | null): Promise<HttpRequestResolution> {
  if (!node.tools.includes("http_request")) return emptyResolution();
  const endpoints = node.httpEndpoints ?? [];
  if (endpoints.length === 0) return emptyResolution();

  const allowError = checkHttpEndpointsAllowed(endpoints);
  if (allowError) {
    const skipped = [`http_request skipped: ${allowError}`];
    console.warn(`[http_request] ${skipped[0]}`);
    return { ...emptyResolution(), skipped };
  }

  const resolved: ResolvedEndpoint[] = [];
  const skipped: string[] = [];

  for (const endpoint of endpoints) {
    // Re-checked per endpoint even though checkHttpEndpointsAllowed just
    // ran: that call validates the set, this is the per-URL boundary the
    // request itself will be built from.
    if (!isHttpEndpointUrlAllowed(endpoint.baseUrl)) {
      skipped.push(`http_request ${endpoint.slug}: baseUrl is no longer within ALLOWED_HTTP_ENDPOINTS`);
      continue;
    }
    let token: string | undefined;
    if (endpoint.credentialProvider) {
      if (!ownerId) {
        skipped.push(`http_request ${endpoint.slug}: credential ${endpoint.credentialProvider} not configured`);
        continue;
      }
      const cred = await db.query.userCredentials.findFirst({
        where: and(eq(userCredentials.userId, ownerId), eq(userCredentials.provider, endpoint.credentialProvider)),
      });
      if (!cred) {
        skipped.push(`http_request ${endpoint.slug}: credential ${endpoint.credentialProvider} not configured`);
        continue;
      }
      token = decryptCredential(cred.encryptedKey);
    }
    resolved.push({ endpoint, token });
  }

  if (resolved.length === 0) return { ...emptyResolution(), skipped };

  const bySlug = new Map(resolved.map((r) => [r.endpoint.slug, r]));
  const slugs = resolved.map((r) => r.endpoint.slug);

  const httpRequest = tool({
    description:
      "Call one of your pre-authorized REST endpoints by its slug. You cannot supply a URL — only a configured " +
      "slug plus a relative path. Use for reading or submitting data to the systems listed in your instructions.",
    inputSchema: z.object({
      // Non-empty by construction (early-returned above), so the tuple cast is safe.
      endpoint: z.enum(slugs as [string, ...string[]]).describe("Which configured endpoint to call"),
      method: z.enum(["GET", "POST"]),
      path: z.string().startsWith("/").describe("Path appended to the endpoint's base URL, e.g. /api/items"),
      body: z.unknown().optional().describe("JSON body; POST only, ignored for GET"),
    }),
    execute: async ({
      endpoint: slug,
      method,
      path,
      body,
    }: {
      endpoint: string;
      method: "GET" | "POST";
      path: string;
      body?: unknown;
    }) => {
      const match = bySlug.get(slug);
      // Never throws — an unknown slug is a model mistake it can recover
      // from, not a hop failure.
      if (!match) return { error: `Unknown endpoint "${slug}". Configured: ${slugs.join(", ")}` };

      let url: string;
      try {
        // Resolved against the base so a path can't escape to another
        // origin; the result is re-checked against the allowlist because
        // `new URL("/x", base)` can still change the pathname.
        const resolvedUrl = new URL(path, match.endpoint.baseUrl.endsWith("/") ? match.endpoint.baseUrl : `${match.endpoint.baseUrl}/`);
        if (!isHttpEndpointUrlAllowed(resolvedUrl.toString())) {
          return { error: `Path "${path}" resolves outside the allowed endpoint prefix.` };
        }
        url = resolvedUrl.toString();
      } catch {
        return { error: `Invalid path "${path}".` };
      }

      const headers: Record<string, string> = { accept: "application/json" };
      if (match.token) {
        const headerName = match.endpoint.headerName || "Authorization";
        headers[headerName] = headerName === "Authorization" ? `Bearer ${match.token}` : match.token;
      }
      if (method === "POST" && body !== undefined) headers["content-type"] = "application/json";

      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
          ...(method === "POST" && body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (err) {
        // Redacted: an error message can echo back the request URL, which
        // may carry a token the caller put in a header-bearing endpoint.
        return { error: redactSecrets(err instanceof Error ? err.message : String(err)), kind: "upstream" };
      }

      const text = await res.text().catch(() => "");
      if (!res.ok) {
        return { error: redactAndCap(text) || `HTTP ${res.status}`, status: res.status };
      }
      return { status: res.status, body: redactAndCap(text) };
    },
  });

  return { tools: { http_request: httpRequest }, granted: slugs, skipped };
}
