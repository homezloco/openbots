import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { discoverMcpServer } from "../orchestrator/mcpTool.js";
import { isMcpServerUrlAllowed } from "../validation/mcpServer.js";
import { getSmitheryServerUrl, searchSmitheryServers, smitheryConfigured } from "../smithery.js";

const discoverBody = z.object({
  url: z.string().url(),
  credentialProvider: z.string().min(1).optional(),
  headerName: z.string().min(1).optional(),
});

const registrySearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
  verifiedOnly: z.coerce.boolean().default(false),
});

const registryServerUrlQuery = z.object({
  qualifiedName: z.string().trim().min(1).max(200),
});

/**
 * Authenticated probe: list a remote MCP server's tools so a human can
 * tick an allowlist. Never callTool. URL must pass ALLOWED_MCP_SERVERS.
 */
export async function mcpRoutes(app: FastifyInstance) {
  app.post("/mcp/discover", { preHandler: requireAuth }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "Unauthorized" });
    const body = discoverBody.parse(req.body);
    if (!isMcpServerUrlAllowed(body.url)) {
      return reply.code(400).send({ error: "url must be within an operator-configured prefix (see ALLOWED_MCP_SERVERS)" });
    }
    try {
      const discovered = await discoverMcpServer(body.url, req.userId, body.credentialProvider, body.headerName);
      return discovered;
    } catch (err) {
      const message = err instanceof Error ? err.message : "MCP discover failed";
      const status = /not configured/i.test(message) ? 400 : 502;
      return reply.code(status).send({ error: message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]") });
    }
  });

  /**
   * Pure discovery UX for AgentSettingsForm's "Browse MCP servers"
   * picker — requireAuth here isn't about ALLOWED_MCP_SERVERS (neither
   * route touches it, nothing is granted by browsing), it's to stop an
   * unauthenticated caller turning this into a free proxy that burns
   * the operator's own Smithery quota. Graceful-degrades to 200/empty
   * when SMITHERY_API_KEY is unset, same shape embedRerank/business_metrics
   * already use, so the picker can render a quiet "not configured" line
   * instead of an error.
   */
  app.get("/mcp/registry/search", { preHandler: requireAuth }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "Unauthorized" });
    // Validate the request shape before checking configuration — a
    // malformed request is a 400 regardless of whether the operator has
    // set SMITHERY_API_KEY, not something the "not configured" graceful
    // degrade should silently swallow.
    const query = registrySearchQuery.parse(req.query);
    if (!smitheryConfigured()) {
      return { configured: false, servers: [], totalCount: 0, totalPages: 0 };
    }
    try {
      const result = await searchSmitheryServers(query.q, query.page, query.pageSize, query.verifiedOnly);
      return { configured: true, ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : "MCP registry search failed";
      return reply.code(502).send({ error: message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]") });
    }
  });

  /**
   * Resolves a picked server's real connection URL — a separate call
   * from search because Smithery's list endpoint carries no URL at all;
   * only the per-server detail endpoint does. Never bypasses
   * ALLOWED_MCP_SERVERS: this only returns a URL string for the UI to
   * fill in, the exact same save-time allowlist check still applies.
   */
  app.get("/mcp/registry/server-url", { preHandler: requireAuth }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "Unauthorized" });
    const query = registryServerUrlQuery.parse(req.query);
    if (!smitheryConfigured()) {
      return reply.code(400).send({ error: "MCP server browsing is not configured (see SMITHERY_API_KEY)" });
    }
    try {
      const url = await getSmitheryServerUrl(query.qualifiedName);
      if (!url) {
        return reply.code(404).send({ error: "This server has no usable remote (HTTP/SSE) connection — it may be stdio-only." });
      }
      return { url };
    } catch (err) {
      const message = err instanceof Error ? err.message : "MCP registry server lookup failed";
      return reply.code(502).send({ error: message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]") });
    }
  });
}
