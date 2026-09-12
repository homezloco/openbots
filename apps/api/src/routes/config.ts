import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/middleware.js";

const KNOWN_PROVIDERS = new Set(["e2b", "daytona", "local"]);

/**
 * Lets the settings UI know which single run_code backend the operator
 * picked (if any) so it can render exactly the right credential section
 * — "e2b"/"daytona" need a BYOK key, "local" needs none, null means the
 * operator hasn't enabled run_code at all. This isn't sensitive
 * information (which backend, not a credential), but requireAuth stays
 * on for consistency with the rest of this codebase's default-to-auth
 * posture (see mcp.ts's registry routes).
 */
export async function configRoutes(app: FastifyInstance) {
  app.get("/config/sandbox-provider", { preHandler: requireAuth }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "Unauthorized" });
    const raw = process.env.SANDBOX_PROVIDER;
    const provider = raw && KNOWN_PROVIDERS.has(raw) ? raw : null;
    return { provider };
  });
}
