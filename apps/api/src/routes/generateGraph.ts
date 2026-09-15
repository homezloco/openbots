import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { AgentRole, ModelTier, type ProviderId } from "@openbots/graph-schema";
import { generateStructuredWithFallback } from "../orchestrator/generateStructured.js";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { agentGraphs } from "../db/schema.js";
import { insertAgentNode, insertRoutingEdge } from "../orchestrator/graphMutations.js";
import { loadLiveGraph } from "../orchestrator/engine.js";

const generateGraphBody = z.object({
  description: z.string().min(1).max(2000),
});

const generatedNodeSchema = z.object({
  name: z.string().min(1).max(60).describe("Short, unique name for this agent"),
  role: AgentRole.describe(
    "supervisor/router coordinates others; worker does the task; reviewer checks another node's output",
  ),
  // Required, not .optional(): strict json_schema endpoints (Groq)
  // reject the whole call when `required` omits any key in properties —
  // an optional field makes the request itself invalid, not just its
  // output. Same reason edges[] below lost its .default([]).
  tier: ModelTier.describe(
    "Always provide one: flagship for judgment-heavy roles like reviewer, economy for simple mechanical steps, standard otherwise",
  ),
  description: z
    .string()
    .describe("One sentence: what this agent does. Also used to match 'auto' routing."),
  systemPrompt: z.string().describe("The agent's actual instructions — specific, not generic filler"),
  tools: z
    .array(z.string())
    .describe(
      "Tool names this node might need, e.g. calculator, current_time. Naming a tool here does not grant it capability by itself — a human configures the matching access grant afterward.",
    ),
});

const generatedEdgeSchema = z.object({
  sourceName: z.string().describe("Must exactly match a name from nodes[]"),
  targetName: z.string().describe("Must exactly match a name from nodes[]"),
  kind: z
    .enum(["explicit", "auto"])
    .describe("explicit always routes here; auto is chosen by matching the source's output against target descriptions"),
});

const generatedGraphSchema = z.object({
  graphName: z.string().min(1).max(80),
  graphDescription: z.string(),
  nodes: z.array(generatedNodeSchema).min(1).max(8),
  edges: z.array(generatedEdgeSchema).describe("Always provide — use [] only for a single-node graph"),
  entryNodeName: z.string().describe("Must exactly match one name from nodes[] — where a new run starts"),
});

const normalize = (s: string) => s.trim().toLowerCase();

/**
 * "Promptable workflow generation": describe a whole multi-agent team in
 * plain English, get a real graph back. The multi-node sibling of
 * quickAdd.ts's single-node "master agent" flow — same mechanism
 * (one bounded generateObject call, applied directly, no preview step),
 * scaled up to a whole graph instead of one node. See PLAN.md and
 * CLAUDE.md's "What this is" mantra.
 *
 * Deliberately narrower than the full AgentNode surface — the generation
 * schema structurally cannot express fileAccessRoot/dispatchTargets/
 * sshTarget/mcpServers/httpEndpoints/consensusGroup/mapConfig/
 * approvalConfig. Those stay human/PATCH-only forever, configured after
 * the fact via the normal node-settings UI, the same "config is a
 * save-time convenience, not the security boundary" pattern every other
 * dual-gated field in this codebase already follows — there is simply
 * nothing dangerous for this route to gate, by construction.
 */
export async function generateGraphRoutes(app: FastifyInstance) {
  app.post("/graphs/generate", { preHandler: requireAuth }, async (req, reply) => {
    const body = generateGraphBody.parse(req.body);

    let plan: z.infer<typeof generatedGraphSchema>;
    let picked: { provider: ProviderId; model: string };
    try {
      const result = await generateStructuredWithFallback(
        generatedGraphSchema,
        "You turn a plain-English description of a team/workflow into a structured multi-agent graph plan. " +
          "Design a real pipeline: a supervisor or router that coordinates, worker nodes that do the actual work, " +
          "and a reviewer node where a quality gate genuinely makes sense — not one node per sentence. " +
          "When the description names multiple distinct functions or departments, EVERY one gets its own " +
          "worker node — never collapse them into a single all-purpose agent. A request naming six " +
          "departments should produce roughly that many specialists plus the coordinator and reviewer. " +
          "Every edge's sourceName/targetName and the top-level entryNodeName must exactly match a name you put in nodes[]. " +
          "Wire every node into the graph with at least one edge — a node with no edges never runs. " +
          "Prefer 'auto' edges when routing depends on the content of the request (e.g. a router choosing a specialist), " +
          "and 'explicit' edges for a fixed, always-the-same-next-step pipeline. " +
          "Only include tool names that are clearly implied by the agent's job — most agents need no tools at all.",
        body.description,
      );
      plan = result.object;
      picked = { provider: result.provider, model: result.model };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Graph generation failed";
      return reply.code(400).send({ error: message });
    }

    // Validate referential integrity of the model's own output BEFORE any
    // DB write — a hallucinated name reference should never leave a
    // half-built graph behind. Normalized (.trim().toLowerCase()) the same
    // way graphManagementTools.ts's findNodeByName already does, since LLM
    // output isn't byte-stable about whitespace/case between where a name
    // is defined and where it's referenced elsewhere in the same output.
    const seenNames = new Set<string>();
    for (const node of plan.nodes) {
      const key = normalize(node.name);
      if (seenNames.has(key)) {
        return reply.code(400).send({ error: `The generated plan used the name "${node.name}" more than once — try rephrasing.` });
      }
      seenNames.add(key);
    }
    for (const edge of plan.edges) {
      if (!seenNames.has(normalize(edge.sourceName))) {
        return reply.code(400).send({ error: `The generated plan referenced an unknown agent "${edge.sourceName}" — try rephrasing.` });
      }
      if (!seenNames.has(normalize(edge.targetName))) {
        return reply.code(400).send({ error: `The generated plan referenced an unknown agent "${edge.targetName}" — try rephrasing.` });
      }
    }
    if (!seenNames.has(normalize(plan.entryNodeName))) {
      return reply.code(400).send({ error: `The generated plan's entry point "${plan.entryNodeName}" doesn't match any agent it created — try rephrasing.` });
    }

    // Sequential, not wrapped in a db.transaction() — matches every other
    // multi-step graph-build path in this codebase (exampleGraphs.ts does
    // the same); db.transaction is used nowhere in this repo, and the
    // failure window here (a handful of awaits against a local Postgres,
    // no external calls) is the same one every other caller already accepts.
    const [graph] = await db
      .insert(agentGraphs)
      .values({ name: plan.graphName, description: plan.graphDescription, ownerId: req.userId! })
      .returning();

    const nameToId = new Map<string, string>();
    for (const [i, node] of plan.nodes.entries()) {
      const inserted = await insertAgentNode(graph.id, {
        name: node.name,
        role: node.role,
        provider: picked.provider,
        model: picked.model,
        tier: node.tier,
        systemPrompt: node.systemPrompt,
        description: node.description,
        tools: node.tools,
        position: { x: 250, y: 100 + i * 150 },
      }, req.userId);
      nameToId.set(normalize(node.name), inserted.id);
    }

    for (const edge of plan.edges) {
      const sourceNodeId = nameToId.get(normalize(edge.sourceName))!;
      const targetNodeId = nameToId.get(normalize(edge.targetName))!;
      const result = await insertRoutingEdge(graph.id, { sourceNodeId, targetNodeId, kind: edge.kind }, req.userId);
      if (!result.ok) {
        // Only reachable if two generated nodes collide in a way the
        // validation above didn't catch (e.g. a future edge-compatibility
        // rule) — surface it rather than silently dropping the edge.
        return reply.code(result.status).send({ error: result.error });
      }
    }

    await db
      .update(agentGraphs)
      .set({ entryNodeId: nameToId.get(normalize(plan.entryNodeName)), updatedAt: new Date() })
      .where(eq(agentGraphs.id, graph.id));

    const hydrated = await loadLiveGraph(graph.id);
    return reply.code(201).send(hydrated);
  });
}
