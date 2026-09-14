import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentGraphs } from "../db/schema.js";
import { defaultModelFor, pickEnvProvider } from "./credentials.js";
import { insertAgentNode, insertAgentNodeValidated, insertRoutingEdge } from "./graphMutations.js";
import { loadLiveGraph } from "./engine.js";
import type { AgentGraph, ProviderId } from "@openbots/graph-schema";

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
  }, ownerId);

  const support = await insertAgentNode(graph.id, {
    name: "Support Specialist",
    role: "worker",
    provider,
    model,
    systemPrompt: "You are the Support specialist. Answer the user's request as a support agent. Be concise.",
    description: "Handles support and technical requests",
    position: { x: 80, y: 280 },
  }, ownerId);

  await insertAgentNode(graph.id, {
    name: "Billing Specialist",
    role: "worker",
    provider,
    model,
    systemPrompt: "You are the Billing specialist. Answer the user's request as a billing agent. Be concise.",
    description: "Handles invoices, charges, and refunds",
    position: { x: 480, y: 280 },
  }, ownerId);

  await insertRoutingEdge(graph.id, {
    sourceNodeId: router.id,
    targetNodeId: support.id,
    kind: "explicit",
  }, ownerId);

  await db.update(agentGraphs).set({ entryNodeId: router.id, updatedAt: new Date() }).where(eq(agentGraphs.id, graph.id));

  return loadLiveGraph(graph.id);
}

/**
 * The nested-org demo: one Portfolio graph whose Lead dispatches into two
 * team graphs (Payments, Platform). Each team is Lead + Backend / Frontend /
 * Reviewer on auto edges — three specialists, not six. Gateways on the
 * Portfolio canvas are derived from dispatchTargets (click to open the
 * team's own graph). Fictional Acme names; no real properties.
 */
export async function createAgencyExample(ownerId: string): Promise<AgentGraph> {
  const picked = pickEnvProvider() ?? { provider: "anthropic" as const, model: defaultModelFor("anthropic") };

  const payments = await createTeamGraph(ownerId, picked, {
    name: "Acme Payments",
    domain: "Payments",
    description: "Charges, invoices, refunds, and the billing UI.",
    leadPrompt:
      "You lead the Payments team. Route each request to Backend (APIs, charges, webhooks), Frontend (billing UI, checkout), or Reviewer (risk, correctness). Start with UNKNOWN if you cannot pick one.",
  });
  const platform = await createTeamGraph(ownerId, picked, {
    name: "Acme Platform",
    domain: "Platform",
    description: "APIs, developer experience, and reliability.",
    leadPrompt:
      "You lead the Platform team. Route each request to Backend (services, APIs), Frontend (internal tools, DX), or Reviewer (reliability, correctness). Start with UNKNOWN if you cannot pick one.",
  });

  const [portfolio] = await db
    .insert(agentGraphs)
    .values({
      name: "Acme Portfolio",
      description:
        "Click a dashed gateway to open that team's own canvas. Portfolio Lead dispatches work into Payments or Platform by name.",
      ownerId,
    })
    .returning();

  const lead = await insertAgentNodeValidated(
    portfolio.id,
    {
      name: "Portfolio Lead",
      role: "supervisor",
      provider: picked.provider,
      model: picked.model,
      systemPrompt:
        "You are Portfolio Lead for a fictional company called Acme. You do not do the work yourself. Dispatch to the Payments team or the Platform team by graph name, then tell the user you started that work. If the request is ambiguous, ask which team.",
      description: "Dispatches work into Acme Payments or Acme Platform",
      tools: ["dispatch_to_graph"],
      dispatchTargets: [payments.id, platform.id],
      position: { x: 280, y: 40 },
    },
    ownerId,
  );
  if (!lead.ok) throw new Error(lead.error);

  await db
    .update(agentGraphs)
    .set({ entryNodeId: lead.value.id, updatedAt: new Date() })
    .where(eq(agentGraphs.id, portfolio.id));

  return loadLiveGraph(portfolio.id);
}

async function createTeamGraph(
  ownerId: string,
  picked: { provider: ProviderId; model: string },
  opts: { name: string; domain: string; description: string; leadPrompt: string },
): Promise<AgentGraph> {
  const [graph] = await db
    .insert(agentGraphs)
    .values({ name: opts.name, description: opts.description, ownerId })
    .returning();

  const { provider, model } = picked;
  const lead = await insertAgentNode(graph.id, {
    name: `${opts.domain} Lead`,
    role: "supervisor",
    provider,
    model,
    systemPrompt: opts.leadPrompt,
    description: `Routes ${opts.domain} work to Backend, Frontend, or Reviewer`,
    position: { x: 280, y: 40 },
  }, ownerId);

  const backend = await insertAgentNode(graph.id, {
    name: "Backend Specialist",
    role: "worker",
    provider,
    model,
    systemPrompt: `You are the ${opts.domain} Backend specialist. Answer from that team's server/API side. Be concise.`,
    description: `${opts.domain} APIs, services, and data`,
    position: { x: 40, y: 280 },
  }, ownerId);
  const frontend = await insertAgentNode(graph.id, {
    name: "Frontend Specialist",
    role: "worker",
    provider,
    model,
    systemPrompt: `You are the ${opts.domain} Frontend specialist. Answer from that team's UI/UX side. Be concise.`,
    description: `${opts.domain} UI and client experience`,
    position: { x: 280, y: 280 },
  }, ownerId);
  const reviewer = await insertAgentNode(graph.id, {
    name: "Reviewer",
    role: "reviewer",
    provider,
    model,
    systemPrompt: `You are the ${opts.domain} Reviewer. Check the request for correctness and risk. Be concise.`,
    description: `${opts.domain} correctness and risk review`,
    position: { x: 520, y: 280 },
  }, ownerId);

  await insertRoutingEdge(graph.id, { sourceNodeId: lead.id, targetNodeId: backend.id, kind: "auto" }, ownerId);
  await insertRoutingEdge(graph.id, { sourceNodeId: lead.id, targetNodeId: frontend.id, kind: "auto" }, ownerId);
  await insertRoutingEdge(graph.id, { sourceNodeId: lead.id, targetNodeId: reviewer.id, kind: "auto" }, ownerId);

  await db.update(agentGraphs).set({ entryNodeId: lead.id, updatedAt: new Date() }).where(eq(agentGraphs.id, graph.id));
  return loadLiveGraph(graph.id);
}
