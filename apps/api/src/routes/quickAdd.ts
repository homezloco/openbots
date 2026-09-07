import type { FastifyInstance } from "fastify";
import { generateObject } from "ai";
import { z } from "zod";
import { AgentRole, ProviderId } from "@openbots/graph-schema";
import { getModel } from "@openbots/providers";
import { getCredentialsFromEnv } from "../orchestrator/credentials.js";
import { requireAuth } from "../auth/middleware.js";
import { insertAgentNode } from "./graphs.js";
import { requireGraphOwner } from "./graphs.js";
import { fileAccessRootSchema } from "../validation/fileAccessRoot.js";

const quickAddBody = z.object({
  description: z.string().min(1),
  provider: ProviderId.optional(),
  model: z.string().optional(),
  /**
   * File access is never inferred from prose, even if the description
   * mentions a repo/path — granting real filesystem access has to be an
   * explicit, separate opt-in, not a side effect of the LLM guessing what
   * you meant. See @openbots/graph-schema's AgentNode.fileAccessRoot.
   */
  fileAccessRoot: fileAccessRootSchema.optional(),
  tools: z.array(z.string()).optional(),
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

const META_PROVIDER: ProviderId = "anthropic";
const META_MODEL = "claude-sonnet-5";

/**
 * The "master agent" flow: describe a new agent in plain English, an LLM
 * turns that into a structured node config, and it's created through the
 * exact same insertAgentNode() path as the manual "+ Add agent" form —
 * this is a UX layer on top of the existing API, not a separate creation
 * mechanism. See PLAN.md.
 */
export async function quickAddRoutes(app: FastifyInstance) {
  app.post("/graphs/:id/agents/quick-add", { preHandler: requireAuth }, async (req, reply) => {
    const { id: graphId } = req.params as { id: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;
    const body = quickAddBody.parse(req.body);

    const credentials = getCredentialsFromEnv(META_PROVIDER);
    const model = getModel(META_PROVIDER, META_MODEL, credentials);

    const { object: extracted } = await generateObject({
      model,
      schema: extractionSchema,
      system:
        "You turn a plain-English request for a new AI agent into a structured configuration for that agent. Be specific and concrete in the system prompt — describe exactly what this one agent should do, not generic filler like 'you are a helpful assistant'.",
      prompt: body.description,
    });

    const node = await insertAgentNode(graphId, {
      name: extracted.name,
      role: extracted.role,
      provider: body.provider ?? META_PROVIDER,
      model: body.model ?? META_MODEL,
      systemPrompt: extracted.systemPrompt,
      description: extracted.description,
      tools: body.tools,
      fileAccessRoot: body.fileAccessRoot,
      position: body.position ?? { x: 100 + Math.random() * 400, y: 100 + Math.random() * 300 },
    });

    return reply.code(201).send(node);
  });
}
