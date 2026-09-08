// Builds the real git repository (plus a local bare "remote") the
// write-tool and /push e2e tests run against. Not committed to this repo
// itself (see .gitignore) — regenerated fresh before every e2e run
// (folded directly into the "test:e2e" script, not a pnpm pre-hook —
// pnpm doesn't run those by default), so it works identically for local
// `docker compose up` and CI with no separate manual setup step.
// Deliberately plain Node (no TS syntax) so it can run directly without tsx.
import { existsSync, mkdirSync, rmSync, symlinkSync, cpSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const seedDir = join(here, "fixtures", "writable-testrepo-seed");
const scratchDir = join(here, "fixtures", "writable-testrepo");
const outsideDir = join(here, "fixtures", "writable-testrepo-outside");
const bareRemoteDir = join(here, "fixtures", "writable-testrepo-remote.git");

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

// The api/worker containers run as root (see CLAUDE.md), so anything
// they create inside these bind-mounted directories — worktree
// administrative files under .git/worktrees/, objects pushed to the bare
// remote — ends up root-owned on the host. The host user can't then
// delete or traverse those entries to reset the fixture for the next
// run. Reclaim ownership from inside the container (where root access is
// free) before touching anything from the host. If the containers aren't
// up yet (e.g. a completely fresh checkout), there's nothing root-owned
// to reclaim yet, so a failure here is harmless and ignored.
try {
  execFileSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "worker",
      "chown",
      "-R",
      `${process.getuid()}:${process.getgid()}`,
      "/tmp/writable-testrepo",
      "/tmp/writable-testrepo-outside",
      "/tmp/writable-testrepo-remote.git",
    ],
    { cwd: repoRoot, stdio: "pipe" },
  );
} catch {
  // Containers not running, or first-ever run with nothing to reclaim — fine.
}

// Clears a directory's contents in place instead of rmSync-ing the
// directory itself and recreating it. scratchDir/outsideDir/bareRemoteDir
// are live Docker bind mounts once `docker compose up api worker` has
// started — deleting and recreating the directory detaches the
// container's view from it (the container keeps seeing the old, now-
// orphaned inode), so every write/push e2e test would fail with "not a
// git repository" even though the host filesystem looks correct.
function resetDirInPlace(dir) {
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(dir)) {
    rmSync(join(dir, entry), { recursive: true, force: true });
  }
}

resetDirInPlace(scratchDir);
resetDirInPlace(outsideDir);
resetDirInPlace(bareRemoteDir);

cpSync(seedDir, scratchDir, { recursive: true });

// A symlink inside the repo pointing outside it — the fixture the
// symlink-escape e2e test writes through. Targets the CONTAINER-side
// mount path (see docker-compose.yml's writable-testrepo-outside mount),
// not this script's own host path — the orchestrator that resolves this
// symlink always runs inside the worker container, never on the host, so
// a host-absolute target would just dangle there.
symlinkSync("/tmp/writable-testrepo-outside", join(scratchDir, "escape-link"));

git(["init", "-q", "-b", "main"], scratchDir);
git(["config", "user.email", "e2e@openbots.dev"], scratchDir);
git(["config", "user.name", "E2E Fixture"], scratchDir);
git(["add", "-A"], scratchDir);
git(["commit", "-q", "-m", "seed"], scratchDir);

// A local bare repo standing in for GitHub — pushBranch() takes the same
// code path for a plain (non-https) remote, so this exercises the real
// push mechanics without needing a real GitHub account/network in CI.
// The actual `git push` always runs inside the worker container (where
// pushBranch() executes), so `origin` must be the CONTAINER-side mount
// path (see docker-compose.yml's writable-testrepo-remote.git mount),
// not this script's own host path — a host-absolute remote URL would
// only ever resolve when this setup script itself runs, never for the
// real push. No initial seed push is needed: an empty bare repo is a
// perfectly valid starting remote for these tests.
git(["init", "-q", "--bare", "-b", "main"], bareRemoteDir);
git(["remote", "add", "origin", "/tmp/writable-testrepo-remote.git"], scratchDir);

console.log(`Initialized writable e2e fixture at ${scratchDir} (remote: ${bareRemoteDir})`);
