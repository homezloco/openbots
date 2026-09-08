import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { RunMode } from "@openbots/graph-schema";
import { pushBranch, type Worktree } from "@openbots/providers";
import { db } from "../db/client.js";
import { agentCommits, agentGraphs, agentNodes, runEvents, runs, usageEvents, userCredentials } from "../db/schema.js";
import { decryptCredential } from "../auth/crypto.js";
import { createRun } from "../orchestrator/createRun.js";
import { requireAuth } from "../auth/middleware.js";
import { requireGraphOwner } from "./graphs.js";

const createRunBody = z.object({
  graphId: z.string().uuid(),
  input: z.unknown(),
  mode: RunMode.default("pinned"),
});

/**
 * Grok Build's state-sorted triage list (running/blocked first, then
 * everything else by recency) is the pattern this mirrors — see PLAN.md.
 */
const STATUS_PRIORITY: Record<string, number> = {
  running: 0,
  pending: 1,
  error: 2,
  completed: 3,
  cancelled: 4,
};

async function handlePushCommand(
  req: FastifyRequest,
  reply: FastifyReply,
  graphId: string,
  branchName: string | null,
): Promise<void> {
  if (!req.userId) return reply.code(401).send({ error: "Unauthorized" });
  const graph = await db.query.agentGraphs.findFirst({ where: eq(agentGraphs.id, graphId) });
  if (!graph || graph.ownerId !== req.userId) {
    return reply.code(404).send({ error: "Graph not found" });
  }

  const conditions = [eq(agentCommits.graphId, graphId), isNull(agentCommits.pushedAt)];
  if (branchName) conditions.push(eq(agentCommits.branch, branchName));

  const [commit] = await db
    .select()
    .from(agentCommits)
    .where(and(...conditions))
    .orderBy(desc(agentCommits.createdAt))
    .limit(1);

  if (!commit) {
    const [run] = await db
      .insert(runs)
      .values({
        graphId,
        mode: "pinned",
        status: "completed",
        input: branchName ? `/push ${branchName}` : "/push",
        output: branchName ? `No unpushed commit for branch ${branchName}.` : "No unpushed commits to push.",
      })
      .returning();
    return reply.code(201).send(run);
  }

  const creds = await db
    .select()
    .from(userCredentials)
    .where(
      and(
        eq(userCredentials.userId, req.userId as string),
        inArray(userCredentials.provider, ["github", "github_ssh_key"]),
      ),
    );

  const token = creds.find((c) => c.provider === "github");
  const sshKey = creds.find((c) => c.provider === "github_ssh_key");
  const worktree: Worktree = { path: commit.worktreePath, branch: commit.branch };

  let result: { remote: string; message: string };
  try {
    result = await pushBranch(worktree, {
      token: token ? decryptCredential(token.encryptedKey) : undefined,
      sshKey: sshKey ? decryptCredential(sshKey.encryptedKey) : undefined,
    });
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : "Push failed" });
  }

  await db.update(agentCommits).set({ pushedAt: new Date() }).where(eq(agentCommits.id, commit.id));

  const [run] = await db
    .insert(runs)
    .values({
      graphId,
      mode: "pinned",
      status: "completed",
      input: branchName ? `/push ${branchName}` : "/push",
      output: `✅ ${result.message}`,
    })
    .returning();

  return reply.code(201).send(run);
}

export async function runRoutes(app: FastifyInstance) {
  app.post("/runs", { preHandler: requireAuth }, async (req, reply) => {
    const body = createRunBody.parse(req.body);
    const inputString = typeof body.input === "string" ? body.input : null;
    const pushMatch = inputString?.match(/^\/(?:push)(?:\s+(.+))?$/);
    if (pushMatch) {
      return handlePushCommand(req, reply, body.graphId, pushMatch[1]?.trim() ?? null);
    }

    const graphRow = await db.query.agentGraphs.findFirst({
      where: eq(agentGraphs.id, body.graphId),
    });
    if (!graphRow) return reply.code(404).send({ error: "Graph not found" });
    if (graphRow.ownerId !== req.userId) {
      return reply.code(403).send({ error: "You do not own this graph" });
    }
    if (!graphRow.entryNodeId) {
      return reply.code(422).send({ error: "Graph has no entryNodeId set" });
    }

    const run = await createRun(graphRow, body.input, body.mode);
    return reply.code(201).send(run);
  });

  /**
   * A run's output can contain anything an agent produced — including
   * tool output (e.g. file contents) or the substance of a private
   * conversation. This previously had no auth check at all; found in
   * security review alongside the fileAccessRoot finding it compounds.
   */
  app.get("/runs/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = await db.query.runs.findFirst({ where: eq(runs.id, id) });
    if (!run) return reply.code(404).send({ error: "Run not found" });

    const graph = await db.query.agentGraphs.findFirst({ where: eq(agentGraphs.id, run.graphId) });
    if (!graph || graph.ownerId !== req.userId) {
      return reply.code(404).send({ error: "Run not found" });
    }

    const events = await db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, id))
      .orderBy(runEvents.sequence);

    const usage = await db.select().from(usageEvents).where(eq(usageEvents.runId, id));
    const usageTotal = usage.reduce(
      (acc, u) => ({
        inputTokens: acc.inputTokens + u.inputTokens,
        outputTokens: acc.outputTokens + u.outputTokens,
        estimatedCostUsd: acc.estimatedCostUsd + u.estimatedCostUsd,
      }),
      { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    );

    return { ...run, events, usage, usageTotal };
  });

  /** Companion list view to the hierarchy canvas — see PLAN.md's "Runs list view". */
  app.get("/graphs/:id/runs", { preHandler: requireAuth }, async (req, reply) => {
    const { id: graphId } = req.params as { id: string };
    const graph = await db.query.agentGraphs.findFirst({ where: eq(agentGraphs.id, graphId) });
    if (!graph || graph.ownerId !== req.userId) {
      return reply.code(404).send({ error: "Graph not found" });
    }

    const rows = await db
      .select()
      .from(runs)
      .where(eq(runs.graphId, graphId))
      .orderBy(desc(runs.createdAt));

    // runs.input is a scratch field the engine overwrites on every hop
    // transition (each hop reads "its own input" from this column) — for
    // any multi-hop run, by completion it holds the LAST hop's input (e.g.
    // a consensus run's branch-outputs array), not what the user actually
    // asked. The true original input is only ever written once, at
    // sequence 0, and never touched again — restore it here so
    // conversation-memory chaining (useBotChat) and the transcript display
    // don't silently drop context or render raw JSON for multi-hop runs.
    const runIds = rows.map((r) => r.id);
    const originalInputs =
      runIds.length > 0
        ? await db
            .select({ runId: runEvents.runId, input: runEvents.input })
            .from(runEvents)
            .where(and(inArray(runEvents.runId, runIds), eq(runEvents.sequence, 0)))
        : [];
    const originalInputByRun = new Map(originalInputs.map((e) => [e.runId, e.input]));
    const withOriginalInput = rows.map((r) => ({ ...r, originalInput: originalInputByRun.get(r.id) ?? r.input }));

    return withOriginalInput.sort((a, b) => {
      const priorityDiff = (STATUS_PRIORITY[a.status] ?? 99) - (STATUS_PRIORITY[b.status] ?? 99);
      if (priorityDiff !== 0) return priorityDiff;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });
  });

  /**
   * Backs the Hierarchy canvas's "click an agent to see its conversation
   * history" panel. run_events.nodeId has no FK (deliberately — a node
   * can move graphs or be deleted while its history stays queryable), so
   * this is a straightforward node-centric query, no schema change needed.
   * `isDirect` marks a run where this node was the entry hop (the user
   * talked to it directly) vs. one where another node routed to it.
   */
  app.get("/graphs/:graphId/nodes/:nodeId/conversations", { preHandler: requireAuth }, async (req, reply) => {
    const { graphId, nodeId } = req.params as { graphId: string; nodeId: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;

    const matches = await db
      .select({ runId: runEvents.runId, status: runs.status, startedAt: runs.createdAt })
      .from(runEvents)
      .innerJoin(runs, eq(runEvents.runId, runs.id))
      .where(and(eq(runEvents.nodeId, nodeId), eq(runs.graphId, graphId)))
      .orderBy(desc(runs.createdAt));

    const seen = new Set<string>();
    const runSummaries: { runId: string; status: string; startedAt: Date }[] = [];
    for (const m of matches) {
      if (seen.has(m.runId)) continue;
      seen.add(m.runId);
      runSummaries.push(m);
      if (runSummaries.length >= 20) break;
    }

    const runIds = runSummaries.map((r) => r.runId);
    const allEvents =
      runIds.length > 0
        ? await db.select().from(runEvents).where(inArray(runEvents.runId, runIds)).orderBy(runEvents.sequence)
        : [];

    const eventsByRun = new Map<string, typeof allEvents>();
    for (const e of allEvents) {
      const arr = eventsByRun.get(e.runId) ?? [];
      arr.push(e);
      eventsByRun.set(e.runId, arr);
    }

    const nodes = await db
      .select({ id: agentNodes.id, name: agentNodes.name })
      .from(agentNodes)
      .where(eq(agentNodes.graphId, graphId));

    return {
      nodes,
      runs: runSummaries.map((r) => {
        const events = eventsByRun.get(r.runId) ?? [];
        return {
          runId: r.runId,
          status: r.status,
          startedAt: r.startedAt,
          isDirect: events.length > 0 && events[0].nodeId === nodeId,
          events,
        };
      }),
    };
  });
}
