import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { discoverMcpServer } from "../orchestrator/mcpTool.js";
import { isMcpServerUrlAllowed } from "../validation/mcpServer.js";

const discoverBody = z.object({
  url: z.string().url(),
  credentialProvider: z.string().min(1).optional(),
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
      const discovered = await discoverMcpServer(body.url, req.userId, body.credentialProvider);
      return discovered;
    } catch (err) {
      const message = err instanceof Error ? err.message : "MCP discover failed";
      const status = /not configured/i.test(message) ? 400 : 502;
      return reply.code(status).send({ error: message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]") });
    }
  });
}
