import { execFile } from "node:child_process";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import { sshCommandFor, withEphemeralSshKey } from "./sshExec.js";

const execFileAsync = promisify(execFile);

export interface Worktree {
  path: string;
  branch: string;
}

export interface PushCredentials {
  /** GitHub personal access token, used for an https:// origin. */
  token?: string;
  /** PEM-encoded SSH private key, used for a git@/ssh:// origin. */
  sshKey?: string;
}

/**
 * GitHub's own published SSH host public keys (https://api.github.com/meta,
 * "ssh_keys" — fetched and verified against that endpoint directly, not
 * transcribed from memory). Pinned here rather than trusting whatever
 * `ssh-keyscan` returns at push time, which would be vulnerable to a
 * MITM on the very first connection — exactly what host-key pinning
 * exists to prevent. Stable but not guaranteed forever: GitHub has
 * rotated these before (e.g. after their 2023 RSA key exposure). If SSH
 * pushes start failing with a host-key-verification error, re-fetch from
 * the URL above.
 */
const GITHUB_KNOWN_HOSTS =
  [
    "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
    "github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
    "github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=",
  ].join("\n") + "\n";

/**
 * Extracts {owner, repo} from any of GitHub's three remote URL shapes
 * (https://, git@host:, ssh://git@host/) — used by /pr, which needs
 * owner/repo for the GitHub REST API regardless of which transport the
 * matching /push used. Returns null for anything not on github.com.
 */
export function parseGithubRepo(remoteUrl: string): { owner: string; repo: string } | null {
  let path: string;
  if (remoteUrl.startsWith("git@github.com:")) {
    path = remoteUrl.slice("git@github.com:".length);
  } else {
    try {
      const url = new URL(remoteUrl);
      if (url.hostname !== "github.com") return null;
      path = url.pathname.replace(/^\//, "");
    } catch {
      return null;
    }
  }
  const [owner, repo] = path.replace(/\.git$/, "").split("/");
  if (!owner || !repo) return null;
  return { owner, repo };
}

export async function getRemoteUrl(worktreePath: string): Promise<string> {
  const cwd = await repoCwdFor(worktreePath);
  return (await git(["remote", "get-url", "origin"], cwd)).trim();
}

/**
 * The repo root a worktree lives under. Worktree paths are always
 * `<root>/.openbots/worktrees/<name>` (see ensureWorktree), so the root is
 * recoverable from the path alone — no extra plumbing through callers.
 */
function rootFromWorktreePath(worktreePath: string): string | null {
  const marker = `${sep}.openbots${sep}worktrees${sep}`;
  const idx = worktreePath.indexOf(marker);
  return idx === -1 ? null : worktreePath.slice(0, idx);
}

/**
 * Resolves the directory any git command against a stored worktree path
 * should actually run in. Falls back to the repo ROOT when the worktree
 * directory itself is gone — now a normal, expected state rather than
 * corruption, since `pruneWorktrees` reclaims old worktree directories on
 * a schedule while every commit made in them stays on its `openbots/*`
 * branch. Verified directly that `git worktree remove` deletes the
 * working directory and its admin files but leaves the branch and every
 * object intact, so `git show`/`git push`/`git remote` all behave
 * identically run from the root instead. Shared by getCommitDiff,
 * getRemoteUrl, and pushBranch — every caller that previously assumed the
 * worktree directory still exists.
 */
async function repoCwdFor(worktreePath: string): Promise<string> {
  const worktreeExists = await stat(worktreePath)
    .then(() => true)
    .catch(() => false);
  if (worktreeExists) return worktreePath;
  const root = rootFromWorktreePath(worktreePath);
  if (!root) {
    throw new Error(`Worktree ${worktreePath} is gone and its repo root could not be derived from the path.`);
  }
  return root;
}

/** Full diff for one commit, for the GitHub tab's "view diff" expander. See repoCwdFor for the pruned-worktree fallback. */
export async function getCommitDiff(worktreePath: string, sha: string): Promise<string> {
  const cwd = await repoCwdFor(worktreePath);
  await ensureSafeDirectory(cwd);
  return git(["show", "--no-color", sha], cwd);
}

/**
 * Reclaims old agent worktree DIRECTORIES. Nothing is lost: `git worktree
 * remove` leaves the `openbots/*` branch and all of its commits in the
 * repo's object store, so unpushed work stays recoverable (`git log
 * openbots/<name>`), `/push` still works, and getCommitDiff above falls
 * back to the root. Only the checked-out copy of the files goes away.
 *
 * Without this they accumulate forever — one directory per (node, run),
 * each a full checkout of the project. An actively dogfooded repo had 18
 * after a single day.
 *
 * Deliberately conservative:
 * - **Skips dirty worktrees entirely.** Uncommitted changes mean a hop
 *   died mid-write; unlike a commit, that IS unrecoverable if deleted, so
 *   it's left alone regardless of age and reported back to the caller.
 * - **Age is measured by mtime**, so a worktree something is still
 *   touching is never a candidate.
 * - Failures are per-worktree and non-fatal: this is housekeeping and must
 *   never take down the worker that calls it.
 */
export async function pruneWorktrees(
  root: string,
  maxAgeMs: number,
): Promise<{ removed: string[]; keptDirty: string[] }> {
  const removed: string[] = [];
  const keptDirty: string[] = [];
  const worktreesDir = join(root, ".openbots", "worktrees");

  const entries = await readdir(worktreesDir, { withFileTypes: true }).catch(() => []);
  if (entries.length === 0) return { removed, keptDirty };

  await ensureSafeDirectory(root);
  const cutoff = Date.now() - maxAgeMs;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const worktreePath = join(worktreesDir, entry.name);
    try {
      const info = await stat(worktreePath);
      if (info.mtimeMs > cutoff) continue;

      await ensureSafeDirectory(worktreePath);
      const dirty = (await git(["status", "--porcelain"], worktreePath)).trim();
      if (dirty) {
        keptDirty.push(worktreePath);
        continue;
      }

      await git(["worktree", "remove", "--force", worktreePath], root);
      removed.push(worktreePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Almost always a worktree written by an older root-running
      // container (before the compose `user:` fix), which the worker's
      // now-unprivileged uid cannot delete. Say so, rather than making
      // the operator decode a bare "Permission denied" from git.
      const hint = /permission denied/i.test(message)
        ? " — likely created by an older root-running container; remove it manually (sudo rm -rf) once."
        : "";
      console.warn(`[worktree-prune] skipped ${worktreePath}: ${message}${hint}`);
    }
  }

  // Clears admin entries for worktrees whose directory vanished by other
  // means (a human `rm -rf`), which git otherwise keeps listing forever.
  await git(["worktree", "prune"], root).catch(() => "");

  return { removed, keptDirty };
}

function isGithubSshRemote(remote: string): boolean {
  if (remote.startsWith("git@")) return remote.startsWith("git@github.com:");
  if (remote.startsWith("ssh://")) {
    try {
      return new URL(remote).hostname === "github.com";
    } catch {
      return false;
    }
  }
  return false;
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

/**
 * Pushes a worktree's branch. Resolves its cwd through repoCwdFor rather
 * than assuming `worktree.path` still exists — `worktree.branch` is a
 * real branch in the repo's object store regardless of whether its
 * worktree directory was ever created this process or was already
 * reclaimed by `pruneWorktrees`, so a push (unlike a write, which needs
 * the checked-out files) works identically from the repo root.
 */
export async function pushBranch(worktree: Worktree, credentials?: PushCredentials): Promise<{ remote: string; message: string }> {
  const cwd = await repoCwdFor(worktree.path);
  const remote = (await git(["remote", "get-url", "origin"], cwd)).trim();
  if (!remote) throw new Error("No origin remote configured");

  if (remote.startsWith("https://")) {
    if (!credentials?.token) {
      throw new Error("HTTPS origin requires a GitHub token — save one via POST /me/credentials");
    }
    const auth = Buffer.from(`x-access-token:${credentials.token}`).toString("base64");
    const header = `AUTHORIZATION: basic ${auth}`;
    await git(["-c", `http.extraheader=${header}`, "push", "origin", worktree.branch], cwd);
  } else if (remote.startsWith("ssh://") || remote.startsWith("git@")) {
    if (!isGithubSshRemote(remote)) {
      throw new Error(
        "SSH push is only supported for github.com origins (the pinned host key is GitHub's) — use an HTTPS origin for other hosts.",
      );
    }
    if (!credentials?.sshKey) {
      throw new Error("SSH origin requires a GitHub SSH private key — save one via POST /me/credentials (provider: github_ssh_key)");
    }
    await withEphemeralSshKey(credentials.sshKey, GITHUB_KNOWN_HOSTS, ({ keyPath, knownHostsPath }) =>
      git(["push", "origin", worktree.branch], cwd, {
        ...process.env,
        GIT_SSH_COMMAND: sshCommandFor(keyPath, knownHostsPath),
      }),
    );
  } else {
    // Plain (file:// or local path) — used by e2e against a local bare repo,
    // and by any self-hosted deployment pointing origin at a local/NFS path.
    // A local push invokes git receive-pack directly against that directory,
    // so it hits the same dubious-ownership check as the worktree root does
    // (see ensureSafeDirectory above) if it's owned by a different UID than
    // the container runs as (root) — most commonly the host UID, via a bind
    // mount.
    await ensureSafeDirectory(remote);
    await git(["push", "origin", worktree.branch], cwd);
  }

  return { remote, message: `Pushed ${worktree.branch} to ${remote}` };
}
