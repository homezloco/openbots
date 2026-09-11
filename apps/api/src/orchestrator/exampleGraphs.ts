import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentGraphs } from "../db/schema.js";
import { defaultModelFor, pickEnvProvider } from "./credentials.js";
import { insertAgentNode, insertRoutingEdge } from "./graphMutations.js";
import { loadLiveGraph } from "./engine.js";
import type { AgentGraph } from "@openbots/graph-schema";

/**
 * The graph in the README GIF: Router with one explicit edge to Support,
 * Billing sitting next to it as the drop target. A live run's next hop
 * follows whatever that edge currently points at — drag Support → Billing
 * while Router is still generating and Billing is the one that fires.
 *
 * Nodes use whichever provider has an env key (same pick as quick-add) so
 * the demo actually runs on an OpenAI/Ollama-only box, not just Anthropic.
 * Falls back to anthropic/claude-sonnet-5 so the canvas still appears
 * when no key is set yet; the run will then fail with a missing-key error.
 */
export async function createLiveRerouteExample(ownerId: string): Promise<AgentGraph> {
  const picked = pickEnvProvider() ?? { provider: "anthropic" as const, model: defaultModelFor("anthropic") };
  const { provider, model } = picked;

  const [graph] = await db
    .insert(agentGraphs)
    .values({
      name: "Live reroute demo",
      description:
        "Start a live run, then drag the Router's outgoing edge from Support onto Billing while Router is still generating.",
      ownerId,
    })
    .returning();

  const router = await insertAgentNode(graph.id, {
    name: "Router",
    role: "router",
    provider,
    model,
    systemPrompt:
      "You are the intake router. Read the user's request and write one short sentence saying whether it sounds like a support issue or a billing issue. Do not solve it yourself — a specialist handles it next.",
    description: "Classifies the request, then the outgoing edge decides who runs next",
    position: { x: 280, y: 40 },
  });

  const support = await insertAgentNode(graph.id, {
    name: "Support Specialist",
    role: "worker",
    provider,
    model,
    systemPrompt: "You are the Support specialist. Answer the user's request as a support agent. Be concise.",
    description: "Handles support and technical requests",
    position: { x: 80, y: 280 },
  });

  await insertAgentNode(graph.id, {
    name: "Billing Specialist",
    role: "worker",
    provider,
    model,
    systemPrompt: "You are the Billing specialist. Answer the user's request as a billing agent. Be concise.",
    description: "Handles invoices, charges, and refunds",
    position: { x: 480, y: 280 },
  });

  await insertRoutingEdge(graph.id, {
    sourceNodeId: router.id,
    targetNodeId: support.id,
    kind: "explicit",
  });

  await db.update(agentGraphs).set({ entryNodeId: router.id, updatedAt: new Date() }).where(eq(agentGraphs.id, graph.id));

  return loadLiveGraph(graph.id);
}
