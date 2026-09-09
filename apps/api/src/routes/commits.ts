import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { getCommitDiff, getRemoteUrl, parseGithubRepo } from "@openbots/providers";
import { db } from "../db/client.js";
import { agentCommits, agentNodes, userCredentials } from "../db/schema.js";
import { requireAuth } from "../auth/middleware.js";
import { requireGraphOwner } from "./graphs.js";
import { decryptCredential } from "../auth/crypto.js";
import { githubApiRequest } from "../github.js";
import { createPrForCommit } from "./runs.js";

const MAX_DIFF_CHARS = 200_000;

/**
 * Surfaces agentCommits (populated by engine.ts::callAgent alongside the
 * commit-note it already appends to a hop's output) so the UI can show
 * "there are N unpushed commits" instead of the user having to remember
 * to type /push. agentCommits.nodeId has no FK (same reasoning as
 * run_events.nodeId — a node can move between graphs or be deleted, but
 * its commit history should stay visible), so the node name is a
 * best-effort left join, not a guaranteed one.
 */
export async function commitRoutes(app: FastifyInstance) {
  app.get("/graphs/:graphId/commits", { preHandler: requireAuth }, async (req, reply) => {
    const { graphId } = req.params as { graphId: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;

    const rows = await db
      .select({
        id: agentCommits.id,
        runId: agentCommits.runId,
        nodeId: agentCommits.nodeId,
        nodeName: agentNodes.name,
        branch: agentCommits.branch,
        commitSha: agentCommits.commitSha,
        pushedAt: agentCommits.pushedAt,
        createdAt: agentCommits.createdAt,
      })
      .from(agentCommits)
      .leftJoin(agentNodes, eq(agentCommits.nodeId, agentNodes.id))
      .where(eq(agentCommits.graphId, graphId))
      .orderBy(desc(agentCommits.createdAt));

    return rows.map((r) => ({
      ...r,
      nodeName: r.nodeName ?? "Unknown agent",
      pushedAt: r.pushedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  });

  /**
   * Full `git show` for one commit, for the GitHub tab's "view diff"
   * expander. Worktrees are never cleaned up (see CLAUDE.md), so this
   * normally works long after the run that made the commit finished; if the
   * worktree was moved/deleted outside OpenBots, getCommitDiff throws and
   * that's surfaced as a clear message rather than a raw stack trace.
   */
  app.get("/graphs/:graphId/commits/:commitId/diff", { preHandler: requireAuth }, async (req, reply) => {
    const { graphId, commitId } = req.params as { graphId: string; commitId: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;

    // graphId scoped in the lookup, not just the ownership check above —
    // same IDOR class fixed elsewhere for nodes/edges/credentials.
    const commit = await db.query.agentCommits.findFirst({
      where: and(eq(agentCommits.id, commitId), eq(agentCommits.graphId, graphId)),
    });
    if (!commit) return reply.code(404).send({ error: "Commit not found" });

    try {
      const diff = await getCommitDiff(commit.worktreePath, commit.commitSha);
      const truncated = diff.length > MAX_DIFF_CHARS;
      return { diff: truncated ? diff.slice(0, MAX_DIFF_CHARS) : diff, truncated };
    } catch (err) {
      return reply.code(404).send({
        error: `Could not read this commit's worktree — it may have been moved or deleted on disk. (${
          err instanceof Error ? err.message : "unknown error"
        })`,
      });
    }
  });

  /**
   * PR status for every pushed branch on this graph, fetched live from
   * GitHub (never stored locally — same "checked live each time" philosophy
   * the /pr command already follows, see PLAN.md). Batches by distinct
   * {owner, repo} so N branches on the same repo cost one GitHub API call,
   * not N — matching PRs locally by branch name against one
   * `pulls?state=all` listing per repo.
   */
  app.get("/graphs/:graphId/pr-status", { preHandler: requireAuth }, async (req, reply) => {
    const { graphId } = req.params as { graphId: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;

    const pushed = await db
      .select()
      .from(agentCommits)
      .where(and(eq(agentCommits.graphId, graphId), isNotNull(agentCommits.pushedAt)))
      .orderBy(desc(agentCommits.createdAt));

    // One representative (most recent) commit per branch — a branch can
    // have several per-hop commits, but they all share one worktree/remote.
    const latestByBranch = new Map<string, (typeof pushed)[number]>();
    for (const c of pushed) {
      if (!latestByBranch.has(c.branch)) latestByBranch.set(c.branch, c);
    }
    const branches = [...latestByBranch.values()];
    if (branches.length === 0) return [];

    const [cred] = await db
      .select()
      .from(userCredentials)
      .where(and(eq(userCredentials.userId, req.userId as string), eq(userCredentials.provider, "github")))
      .limit(1);

    if (!cred) {
      return branches.map((c) => ({ commitId: c.id, branch: c.branch, repo: null, pr: null, tokenConfigured: false }));
    }
    const token = decryptCredential(cred.encryptedKey);

    const resolved = await Promise.all(
      branches.map(async (c) => ({ commit: c, parsed: parseGithubRepo(await getRemoteUrl(c.worktreePath).catch(() => "")) })),
    );

    const repoKey = (o: string, r: string) => `${o}/${r}`;
    const distinctRepos = new Map<string, { owner: string; repo: string }>();
    for (const { parsed } of resolved) {
      if (parsed) distinctRepos.set(repoKey(parsed.owner, parsed.repo), parsed);
    }

    const prListByRepo = new Map<string, any[]>();
    await Promise.all(
      [...distinctRepos.values()].map(async ({ owner, repo }) => {
        try {
          prListByRepo.set(repoKey(owner, repo), await githubApiRequest(`/repos/${owner}/${repo}/pulls?state=all&per_page=100`, token));
        } catch {
          prListByRepo.set(repoKey(owner, repo), []);
        }
      }),
    );

    return resolved.map(({ commit, parsed }) => {
      if (!parsed) return { commitId: commit.id, branch: commit.branch, repo: null, pr: null, tokenConfigured: true };
      const key = repoKey(parsed.owner, parsed.repo);
      const match = (prListByRepo.get(key) ?? []).find((p: any) => p.head?.ref === commit.branch);
      return {
        commitId: commit.id,
        branch: commit.branch,
        repo: key,
        pr: match ? { number: match.number, url: match.html_url, state: match.merged_at ? "merged" : match.state, title: match.title } : null,
        tokenConfigured: true,
      };
    });
  });

  /**
   * Opens a PR for a caller-specified commit's branch — the GitHub tab's
   * "Open PR" button. Shares createPrForCommit with the /pr chat command
   * (routes/runs.ts), which instead resolves "most recently pushed" itself;
   * this route lets the UI target any already-pushed branch, not just the
   * latest one.
   */
  app.post("/graphs/:graphId/commits/:commitId/pr", { preHandler: requireAuth }, async (req, reply) => {
    const { graphId, commitId } = req.params as { graphId: string; commitId: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;
    const body = z.object({ title: z.string().optional() }).parse(req.body ?? {});

    const commit = await db.query.agentCommits.findFirst({
      where: and(eq(agentCommits.id, commitId), eq(agentCommits.graphId, graphId)),
    });
    if (!commit) return reply.code(404).send({ error: "Commit not found" });
    if (!commit.pushedAt) return reply.code(400).send({ error: "This branch hasn't been pushed yet — push it first." });

    const [cred] = await db
      .select()
      .from(userCredentials)
      .where(and(eq(userCredentials.userId, req.userId as string), eq(userCredentials.provider, "github")))
      .limit(1);
    if (!cred) {
      return reply.code(400).send({
        error:
          "Opening a PR requires a GitHub token — save one at /settings. This is needed even if you pushed over SSH: PR creation always goes through GitHub's REST API, not git's own transport.",
      });
    }
    const token = decryptCredential(cred.encryptedKey);

    const result = await createPrForCommit(commit, token, body.title ?? null);
    if ("error" in result) return reply.code(400).send({ error: result.error });
    return { message: result.output };
  });
}
