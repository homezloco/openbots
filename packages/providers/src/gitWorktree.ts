import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface Worktree {
  path: string;
  branch: string;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

async function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env });
  return stdout;
}

/**
 * The container runs as root (see apps/api/Dockerfile — no USER
 * directive), while host-mounted project directories are owned by the
 * host user. Git's dubious-ownership check ("detected dubious ownership")
 * would otherwise refuse every git operation against them. Idempotent —
 * checked before adding, so repeated calls across many hops/runs don't
 * accumulate duplicate entries in the global gitconfig.
 */
async function ensureSafeDirectory(root: string): Promise<void> {
  try {
    const existing = await git(["config", "--global", "--get-all", "safe.directory"], root);
    if (existing.split("\n").includes(root)) return;
  } catch {
    // no safe.directory entries configured yet — fall through to add
  }
  await execFileAsync("git", ["config", "--global", "--add", "safe.directory", root]);
}

/** Local, untracked exclude — never touches the user's own committed .gitignore. Best-effort only. */
async function seedExclude(root: string): Promise<void> {
  try {
    const excludePath = join(root, ".git", "info", "exclude");
    const current = await readFile(excludePath, "utf8").catch(() => "");
    if (current.includes(".openbots/")) return;
    await appendFile(excludePath, "\n# Added by OpenBots — isolated agent-write worktrees, not part of your project\n.openbots/\n");
  } catch {
    // non-critical: worst case .openbots/ shows up as untracked in git status
  }
}

/**
 * Creates (or reuses) an isolated git worktree for this node+run,
 * checked out on a fresh branch off the repo's current HEAD, so agent
 * writes can never touch whatever the user currently has checked out or
 * staged. Lives inside the node's own already-allowlisted fileAccessRoot
 * (under .openbots/worktrees/), so it needs no special-casing in the
 * path-boundary check every file tool already applies.
 *
 * Deliberately NOT check-then-act: with WORKER_CONCURRENCY defaulting to
 * 10 and consensus fan-out running branches concurrently, two hops can
 * legitimately race to create the same (runId, nodeId) worktree. git
 * worktree add is called unconditionally; on failure we check whether
 * the path now exists regardless of the specific error text (covers
 * "already exists" and "branch already exists" uniformly) rather than
 * pattern-matching git's error message.
 */
export async function ensureWorktree(root: string, nodeId: string, nodeName: string, runId: string): Promise<Worktree> {
  await ensureSafeDirectory(root);

  const isRepo = await git(["rev-parse", "--is-inside-work-tree"], root)
    .then(() => true)
    .catch(() => false);
  if (!isRepo) {
    throw new Error(
      `"${root}" is not a git repository — write tools require fileAccessRoot to be a git repo so changes can be isolated on a branch.`,
    );
  }

  const slug = slugify(nodeName || nodeId);
  const shortRunId = runId.replace(/-/g, "").slice(0, 8);
  const name = `${slug}-${shortRunId}`;
  const branch = `openbots/${name}`;
  const worktreesDir = join(root, ".openbots", "worktrees");
  const worktreePath = join(worktreesDir, name);

  await mkdir(worktreesDir, { recursive: true });
  await seedExclude(root);

  try {
    await git(["worktree", "add", "-b", branch, worktreePath, "HEAD"], root);
  } catch (err) {
    const stillMissing = await stat(worktreePath)
      .then(() => false)
      .catch(() => true);
    if (stillMissing) throw err;
    // A concurrent (or retried) call already created this exact
    // worktree/branch — git's own ref/lock semantics are the real
    // source of atomicity here, not this function.
  }

  return { path: worktreePath, branch };
}

/**
 * Commits everything currently touched in the worktree as one commit —
 * per hop, not per tool call (a single model step can make several tool
 * calls; per-tool-call commits would race on which "pending commit"
 * state belongs to which concurrently-running execute()) and not per
 * run (would make it much harder to correlate a change back to the hop
 * that produced it). Returns the new commit sha, or null if nothing
 * actually changed (including the case where every touched file ended
 * up identical to what was already committed).
 */
export async function commitWorktreeChanges(worktree: Worktree, nodeName: string, touchedFiles: Set<string>): Promise<string | null> {
  if (touchedFiles.size === 0) return null;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: `OpenBots (${nodeName})`,
    GIT_AUTHOR_EMAIL: "openbots@localhost",
    GIT_COMMITTER_NAME: `OpenBots (${nodeName})`,
    GIT_COMMITTER_EMAIL: "openbots@localhost",
  };

  await git(["add", "-A"], worktree.path, env);

  const message = `${nodeName}: ${touchedFiles.size} file${touchedFiles.size === 1 ? "" : "s"} changed`;
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await git(["commit", "-m", message], worktree.path, env);
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/nothing to commit/i.test(msg)) return null;
      if (/index\.lock/i.test(msg) && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 200 * attempt));
        continue;
      }
      throw err;
    }
  }

  const sha = await git(["rev-parse", "HEAD"], worktree.path);
  return sha.trim();
}

export async function pushBranch(worktree: Worktree, githubToken?: string): Promise<{ remote: string; message: string }> {
  const remote = (await git(["remote", "get-url", "origin"], worktree.path)).trim();
  if (!remote) throw new Error("No origin remote configured");

  if (remote.startsWith("https://")) {
    if (!githubToken) {
      throw new Error("HTTPS origin requires a GitHub token — save one via POST /me/credentials");
    }
    const auth = Buffer.from(`x-access-token:${githubToken}`).toString("base64");
    const header = `AUTHORIZATION: basic ${auth}`;
    await git(["-c", `http.extraheader=${header}`, "push", "origin", worktree.branch], worktree.path);
  } else if (remote.startsWith("ssh://") || remote.startsWith("git@")) {
    throw new Error("SSH origin is not supported in v1; use an HTTPS origin");
  } else {
    // Plain (file:// or local path) — used by e2e against a local bare repo.
    await git(["push", "origin", worktree.branch], worktree.path);
  }

  return { remote, message: `Pushed ${worktree.branch} to ${remote}` };
}
