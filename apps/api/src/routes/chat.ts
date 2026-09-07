import type { FastifyInstance } from "fastify";
import { generateText } from "ai";
import { z } from "zod";
import { getModel } from "@openbots/providers";
import { ProviderId } from "@openbots/graph-schema";
import { getCredentialsFromEnv } from "../orchestrator/credentials.js";
import { withRetry } from "../orchestrator/retry.js";
import { requireAuth } from "../auth/middleware.js";

const chatBody = z.object({
  provider: ProviderId,
  model: z.string().min(1),
  systemPrompt: z.string().optional(),
  message: z.string().min(1),
});

/**
 * The Phase 2 single-agent playground: a direct model call with no graph,
 * no routing, no persistence — for quickly trying a provider/model/prompt
 * combination before wiring it into a hierarchy. See PLAN.md.
 */
export async function chatRoutes(app: FastifyInstance) {
  app.post("/chat", { preHandler: requireAuth }, async (req, reply) => {
    const body = chatBody.parse(req.body);
    const credentials = getCredentialsFromEnv(body.provider);
    const model = getModel(body.provider, body.model, credentials);

    try {
      const result = await withRetry(() =>
        generateText({ model, system: body.systemPrompt, prompt: body.message }),
      );
      return { text: result.text };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error });
    }
  });
}
