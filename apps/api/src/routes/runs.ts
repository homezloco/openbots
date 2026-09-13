import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { RunMode } from "@openbots/graph-schema";
import { getRemoteUrl, parseGithubRepo, pushBranch, type Worktree } from "@openbots/providers";
import { db } from "../db/client.js";
import { agentCommits, agentGraphs, agentNodes, runEvents, runs, usageEvents, userCredentials } from "../db/schema.js";
import { decryptCredential } from "../auth/crypto.js";
import { createRun, forkRun } from "../orchestrator/createRun.js";
import { isTerminalStatus, loadGraphForRun, nextSequence } from "../orchestrator/engine.js";
import { enqueueHop } from "../queue/runQueue.js";
import { publishRunEvent } from "../ws/publish.js";
import { requireAuth } from "../auth/middleware.js";
import { requireGraphOwner } from "./graphs.js";
import { githubApiRequest } from "../github.js";

type AgentCommitRow = typeof agentCommits.$inferSelect;

const createRunBody = z.object({
  graphId: z.string().uuid(),
  input: z.unknown(),
  mode: RunMode.default("pinned"),
});

/**
 * Grok Build's state-sorted triage list (running/blocked first, then
 * everything else by recency) is the pattern this mirrors — see PLAN.md.
 * awaiting_approval sorts first: it is the one status that never resolves
 * on its own, so it is exactly "what needs attention" this list exists to
 * surface.
 */
const STATUS_PRIORITY: Record<string, number> = {
  awaiting_approval: 0,
  running: 1,
  pending: 2,
  error: 3,
  completed: 4,
  cancelled: 5,
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

/**
 * Core PR-creation logic for one specific, already-pushed commit — shared
 * by the /pr chat command below (which resolves "most recently pushed" and
 * calls this) and the GitHub tab's POST .../commits/:commitId/pr route
 * (routes/commits.ts), which calls it for a caller-specified commit. One
 * code path for "how a PR actually gets opened," not two that could drift.
 * Always needs a GitHub token (provider "github") regardless of whether the
 * matching /push used HTTPS or SSH — PR creation is a GitHub REST API call,
 * not a git-transport operation, so an SSH key alone can never satisfy it.
 */
export async function createPrForCommit(
  commit: AgentCommitRow,
  token: string,
  title: string | null,
): Promise<{ output: string } | { error: string }> {
  const remote = await getRemoteUrl(commit.worktreePath);
  const parsed = parseGithubRepo(remote);
  if (!parsed) return { output: "PR creation is only supported for a github.com origin." };

  try {
    const existing = await githubApiRequest(
      `/repos/${parsed.owner}/${parsed.repo}/pulls?head=${parsed.owner}:${commit.branch}&state=open`,
      token,
    );
    if (existing.length > 0) {
      return { output: `A PR already exists for this branch: #${existing[0].number} — ${existing[0].html_url}` };
    }

    const repoInfo = await githubApiRequest(`/repos/${parsed.owner}/${parsed.repo}`, token);

    const pr = await githubApiRequest(`/repos/${parsed.owner}/${parsed.repo}/pulls`, token, {
      method: "POST",
      body: JSON.stringify({
        title: title || `OpenBots: ${commit.branch}`,
        head: commit.branch,
        base: repoInfo.default_branch,
        body: "Opened by OpenBots.",
      }),
    });

    return { output: `✅ Opened PR #${pr.number}: ${pr.html_url}` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "GitHub API request failed" };
  }
}

/**
 * Opens a PR for the most recently *pushed* branch on this graph — a PR
 * can only target a branch GitHub already has, so this deliberately reads
 * agentCommits.pushedAt, not just the latest commit. Same
 * deterministic-command-interception safety property as /push (see
 * POST /runs below): triggered only by the user's own literal "/pr" text,
 * checked before any orchestration/model involvement.
 */
async function handlePrCommand(req: FastifyRequest, reply: FastifyReply, graphId: string, title: string | null): Promise<void> {
  if (!req.userId) return reply.code(401).send({ error: "Unauthorized" });
  const graph = await db.query.agentGraphs.findFirst({ where: eq(agentGraphs.id, graphId) });
  if (!graph || graph.ownerId !== req.userId) {
    return reply.code(404).send({ error: "Graph not found" });
  }

  async function respond(output: string) {
    const [run] = await db
      .insert(runs)
      .values({ graphId, mode: "pinned", status: "completed", input: title ? `/pr ${title}` : "/pr", output })
      .returning();
    return reply.code(201).send(run);
  }

  const [commit] = await db
    .select()
    .from(agentCommits)
    .where(and(eq(agentCommits.graphId, graphId), isNotNull(agentCommits.pushedAt)))
    .orderBy(desc(agentCommits.pushedAt))
    .limit(1);
  if (!commit) return respond("No pushed branch to open a PR for — push one first with /push.");

  const [cred] = await db
    .select()
    .from(userCredentials)
    .where(and(eq(userCredentials.userId, req.userId as string), eq(userCredentials.provider, "github")))
    .limit(1);
  if (!cred) {
    return respond(
      "Opening a PR requires a GitHub token — save one at /settings. This is needed even if you pushed over SSH: PR creation always goes through GitHub's REST API, not git's own transport.",
    );
  }
  const token = decryptCredential(cred.encryptedKey);

  const result = await createPrForCommit(commit, token, title);
  if ("error" in result) return reply.code(400).send({ error: result.error });
  return respond(result.output);
}

export async function runRoutes(app: FastifyInstance) {
  app.post("/runs", { preHandler: requireAuth }, async (req, reply) => {
    const body = createRunBody.parse(req.body);
    const inputString = typeof body.input === "string" ? body.input : null;
    const pushMatch = inputString?.match(/^\/(?:push)(?:\s+(.+))?$/);
    if (pushMatch) {
      return handlePushCommand(req, reply, body.graphId, pushMatch[1]?.trim() ?? null);
    }
    const prMatch = inputString?.match(/^\/pr(?:\s+(.+))?$/);
    if (prMatch) {
      return handlePrCommand(req, reply, body.graphId, prMatch[1]?.trim() ?? null);
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
   * Resumes a run paused at an approval gate (AgentNode.approvalConfig).
   * Optional `input` overwrites runs.input before enqueueing — this is
   * approve-with-edit, not just a veto: a human reading the agent's
   * proposed outbound message and hand-editing it before it sends is the
   * actual leads-workflow use case, not merely blocking a bad one.
   *
   * The status transition is a single conditional UPDATE (only succeeds
   * if the row is STILL "awaiting_approval"), not a read-then-write — a
   * double-click or a race between two reviewers must not enqueue the
   * gated hop twice. The loser gets a clear 409, not a silent no-op.
   *
   * Re-validates the paused node against whichever graph this run
   * actually uses (pinned snapshot or live) before touching anything: a
   * live-mode run can sit paused for days, long enough for someone to
   * delete or un-gate that exact node in the meantime (see CLAUDE.md's
   * "graph drift while paused"). Failing here with a clear message beats
   * letting dispatchHop's bare "Node not found in graph" surface as an
   * opaque job failure later — and the run stays paused, not silently
   * dropped, since nothing about the drift is this call's fault.
   */
  app.post("/runs/:id/approve", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ input: z.unknown().optional() }).parse(req.body ?? {});

    const run = await db.query.runs.findFirst({ where: eq(runs.id, id) });
    if (!run) return reply.code(404).send({ error: "Run not found" });
    if (!(await requireGraphOwner(req, reply, run.graphId))) return;

    if (run.status !== "awaiting_approval") {
      return reply.code(409).send({ error: `Run is not awaiting approval (current status: ${run.status})` });
    }
    if (!run.currentNodeId) {
      return reply.code(422).send({ error: "Run has no current node to approve" });
    }

    const graph = await loadGraphForRun(run.graphId, run.mode, run.graphSnapshot);
    const node = graph.nodes.find((n) => n.id === run.currentNodeId);
    if (!node) {
      return reply.code(422).send({
        error: `Cannot approve: node ${run.currentNodeId} no longer exists in this graph. The run is still paused — fix the graph or cancel the run.`,
      });
    }
    if (!node.approvalConfig) {
      return reply.code(422).send({
        error: `Cannot approve: node "${node.name}" no longer has an approval gate configured. The run is still paused — cancel it if it should not proceed as-is.`,
      });
    }

    const originalInput = run.input;
    const hasEdit = body.input !== undefined;
    const finalInput = hasEdit ? body.input : originalInput;

    const [updated] = await db
      .update(runs)
      .set({ status: "pending", input: finalInput, updatedAt: new Date() })
      .where(and(eq(runs.id, id), eq(runs.status, "awaiting_approval")))
      .returning();
    if (!updated) {
      return reply.code(409).send({ error: "Run is no longer awaiting approval (approved or cancelled concurrently)" });
    }

    await db.insert(runEvents).values({
      runId: id,
      nodeId: node.id,
      sequence: await nextSequence(id),
      status: "approved",
      input: originalInput,
      output: { decision: "approved", decidedBy: req.userId, ...(hasEdit ? { editedInput: finalInput } : {}) },
      startedAt: new Date(),
      finishedAt: new Date(),
    });

    await enqueueHop(id);
    return reply.code(200).send(updated);
  });

  /**
   * Terminates a run. Valid from "awaiting_approval" (this is reject — a
   * gated hop's input is vetoed rather than edited) and from
   * "pending"/"running" (this is a plain stop). Rejection is deliberately
   * not a separate status: it is cancelling with a reason recorded at a
   * gate, which is the same conditional transition and the same terminal
   * write as any other cancel.
   *
   * Honest limit: this stops a run BETWEEN hops. An in-flight hop is
   * inside generateText in the worker process; aborting it from this API
   * route would need cross-process signalling this change doesn't add.
   * dispatchHop's terminal-status guard means a cancelled run's next
   * dequeued job no-ops on its own — cheap, but only once that hop ends.
   */
  app.post("/runs/:id/cancel", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ reason: z.string().optional() }).parse(req.body ?? {});

    const run = await db.query.runs.findFirst({ where: eq(runs.id, id) });
    if (!run) return reply.code(404).send({ error: "Run not found" });
    if (!(await requireGraphOwner(req, reply, run.graphId))) return;

    if (isTerminalStatus(run.status)) {
      return reply.code(409).send({ error: `Run is already ${run.status}` });
    }

    const [updated] = await db
      .update(runs)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(runs.id, id), inArray(runs.status, ["awaiting_approval", "pending", "running"])))
      .returning();
    if (!updated) {
      return reply.code(409).send({ error: "Run could not be cancelled (it just finished)" });
    }

    await db.insert(runEvents).values({
      runId: id,
      nodeId: run.currentNodeId!,
      sequence: await nextSequence(id),
      status: "cancelled",
      input: run.input,
      output: { decision: "cancelled", decidedBy: req.userId, reason: body.reason ?? null },
      startedAt: new Date(),
      finishedAt: new Date(),
    });

    publishRunEvent({ runId: id, graphId: run.graphId, type: "run_cancelled", payload: { reason: body.reason ?? null } });
    return reply.code(200).send(updated);
  });

  /**
   * Rewind-and-fork: re-execute one hop of an existing run as a new run.
   * Prefix hops are copied as history; the source run is not mutated.
   */
  app.post("/graphs/:graphId/runs/:runId/fork", { preHandler: requireAuth }, async (req, reply) => {
    const { graphId, runId } = req.params as { graphId: string; runId: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;
    const body = z
      .object({
        fromSequence: z.number().int().nonnegative(),
        mode: RunMode.optional(),
      })
      .parse(req.body);
    const source = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (!source || source.graphId !== graphId) {
      return reply.code(404).send({ error: "Run not found" });
    }
    try {
      const fork = await forkRun(source, body.fromSequence, body.mode ?? (source.mode as "pinned" | "live"));
      return reply.code(201).send(fork);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 400;
      return reply.code(status).send({ error: err instanceof Error ? err.message : "Fork failed" });
    }
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
        cacheReadTokens: acc.cacheReadTokens + u.cacheReadTokens,
        cacheWriteTokens: acc.cacheWriteTokens + u.cacheWriteTokens,
        estimatedCostUsd: acc.estimatedCostUsd + u.estimatedCostUsd,
      }),
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0 },
    );

    // A write-capable node's hop can time out or exhaust its step budget
    // AFTER already committing real work to its isolated worktree branch
    // (see CLAUDE.md's "Write tools are isolated to a git worktree") —
    // the run then reports error with nothing telling the caller a
    // reviewable branch exists. agent_commits already records this per
    // hop; surface it here so it's never silently lost. There is no
    // filesChanged column on agent_commits — only what's actually
    // persisted (see db/schema.ts) is returned.
    const commitRows = await db
      .select({
        id: agentCommits.id,
        nodeId: agentCommits.nodeId,
        branch: agentCommits.branch,
        commitSha: agentCommits.commitSha,
        pushedAt: agentCommits.pushedAt,
        createdAt: agentCommits.createdAt,
      })
      .from(agentCommits)
      .where(eq(agentCommits.runId, id))
      .orderBy(asc(agentCommits.createdAt));
    const commits = commitRows.map((c) => ({
      ...c,
      pushedAt: c.pushedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
    }));

    return { ...run, events, usage, usageTotal, commits };
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
