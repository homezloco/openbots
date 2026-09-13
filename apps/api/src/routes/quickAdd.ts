import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { AgentRole, ProviderId } from "@openbots/graph-schema";
import { defaultModelFor } from "../orchestrator/credentials.js";
import { generateStructuredWithFallback } from "../orchestrator/generateStructured.js";
import { requireAuth } from "../auth/middleware.js";
import { requireGraphOwner } from "./graphs.js";
import { db } from "../db/client.js";
import { agentGraphs } from "../db/schema.js";
import { insertAgentNode } from "../orchestrator/graphMutations.js";
import { checkWriteRootAllowed, fileAccessRootSchema } from "../validation/fileAccessRoot.js";
import { checkDispatchTargetsOwned } from "../validation/dispatchTargets.js";

const quickAddBody = z.object({
  description: z.string().min(1),
  provider: ProviderId.optional(),
  model: z.string().optional(),
  /**
   * File access is never inferred from prose, even if the description
   * mentions a repo/path — granting real filesystem access has to be an
   * explicit, separate opt-in, not a side effect of the LLM guessing what
   * you meant. See @openbots/graph-schema's AgentNode.fileAccessRoot.
   * Same reasoning applies to dispatchTargets below — the ability to fire
   * runs into other graphs is never inferred from prose either.
   */
  fileAccessRoot: fileAccessRootSchema.optional(),
  tools: z.array(z.string()).optional(),
  dispatchTargets: z.array(z.string().uuid()).optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
});

const extractionSchema = z.object({
  name: z.string().describe("A short, human-readable name for this agent, e.g. 'Repo Reviewer'"),
  role: AgentRole.describe(
    "supervisor if it should decide/delegate to others, router if it classifies and hands off, reviewer if it checks another agent's work, worker otherwise",
  ),
  systemPrompt: z
    .string()
    .describe("The instruction this agent is given before every input it handles — specific to its one job"),
  description: z
    .string()
    .describe("One sentence describing this agent's job — also used to match it for auto-routing"),
});

/**
 * The "master agent" flow: describe a new agent in plain English, an LLM
 * turns that into a structured node config, and it's created through the
 * exact same insertAgentNode() path as the manual "+ Add agent" form —
 * this is a UX layer on top of the existing API, not a separate creation
 * mechanism. See PLAN.md.
 *
 * The extraction LLM tries whichever provider has an env key first
 * (Anthropic, then OpenAI / xAI / OpenRouter / openai-compatible), then
 * the target graph's own configured fallbackChain, then every other
 * env-configured provider — see generateStructured.ts. Hardcoding a
 * single Anthropic-only pick made "+ New bot" a red error string on an
 * OpenAI- or Ollama-only box, and gave a present-but-exhausted key no
 * recovery path at all.
 */
export async function quickAddRoutes(app: FastifyInstance) {
  app.post("/graphs/:id/agents/quick-add", { preHandler: requireAuth }, async (req, reply) => {
    const { id: graphId } = req.params as { id: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;
    const body = quickAddBody.parse(req.body);
    const writeError = checkWriteRootAllowed(body.tools, body.fileAccessRoot);
    if (writeError) return reply.code(400).send({ error: writeError });
    const dispatchError = await checkDispatchTargetsOwned(body.tools, body.dispatchTargets, req.userId);
    if (dispatchError) return reply.code(400).send({ error: dispatchError });

    const graphRow = await db.query.agentGraphs.findFirst({
      where: eq(agentGraphs.id, graphId),
      columns: { fallbackChain: true },
    });
    const graphFallbackChain = (graphRow?.fallbackChain ?? []) as { provider: ProviderId; model: string }[];

    let extracted: z.infer<typeof extractionSchema>;
    let usedProvider: ProviderId;
    let usedModel: string;
    try {
      const result = await generateStructuredWithFallback(
        extractionSchema,
        "You turn a plain-English request for a new AI agent into a structured configuration for that agent. Be specific and concrete in the system prompt — describe exactly what this one agent should do, not generic filler like 'you are a helpful assistant'.",
        body.description,
        graphFallbackChain,
      );
      extracted = result.object;
      usedProvider = result.provider;
      usedModel = result.model;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Quick-add failed";
      return reply.code(400).send({ error: message });
    }

    const nodeProvider = body.provider ?? usedProvider;
    const node = await insertAgentNode(graphId, {
      name: extracted.name,
      role: extracted.role,
      provider: nodeProvider,
      model: body.model ?? (body.provider ? defaultModelFor(body.provider) : usedModel),
      systemPrompt: extracted.systemPrompt,
      description: extracted.description,
      tools: body.tools,
      fileAccessRoot: body.fileAccessRoot,
      dispatchTargets: body.dispatchTargets,
      position: body.position ?? { x: 100 + Math.random() * 400, y: 100 + Math.random() * 300 },
    });

    return reply.code(201).send(node);
  });
}
