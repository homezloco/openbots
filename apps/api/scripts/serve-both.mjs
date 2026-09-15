#!/usr/bin/env node
/**
 * Runs the API and BullMQ worker in ONE container — for hosted deployments
 * where a volume must be shared between them (agent write tools create git
 * worktrees the worker writes and the API later reads for /push, /pr, and
 * commit diffs). Locally the two stay separate (see worker.ts's header
 * comment); this exists because platforms like Railway scope volumes
 * per-service, so two services could never share the worktree directory.
 *
 * Ordering matters: the API applies migrations on boot before it listens,
 * so waiting on /health before spawning the worker guarantees the
 * scheduled_triggers table exists before the worker's boot-time
 * reconcileSchedules() queries it.
 *
 * DEMO_REPO_DIR (optional): when set, seeds a demo git repo there on first
 * boot — git init + initial commit + a sibling bare "<dir>-remote.git"
 * wired up as `origin`, so /push has a target. Skipped entirely when
 * unset; idempotent when set (an existing repo is left alone).
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT ?? 4000);
const apiDir = path.resolve(import.meta.dirname, "..");

function seedDemoRepo() {
  const dir = process.env.DEMO_REPO_DIR;
  if (!dir) return;
  const remote = `${dir}-remote.git`;
  const git = (args, cwd) =>
    execFileSync("git", args, { cwd: cwd ?? dir, stdio: "inherit" });

  if (!existsSync(path.join(dir, ".git"))) {
    execFileSync("git", ["init", "-b", "main", dir], { stdio: "inherit" });
    git(["config", "user.email", "demo@openbots.local"]);
    git(["config", "user.name", "OpenBots Demo"]);
    execFileSync(
      "sh",
      ["-c", 'printf "# OpenBots demo repo\\n\\nAgents with write access land commits here on openbots/* branches.\\n" > README.md'],
      { cwd: dir },
    );
    git(["add", "README.md"]);
    git(["commit", "-m", "Initial commit"]);
  }
  if (!existsSync(remote)) {
    execFileSync("git", ["init", "--bare", remote], { stdio: "inherit" });
  }
  try {
    git(["remote", "add", "origin", remote]);
  } catch {
    // origin already configured — fine.
  }
}

function waitForHealth(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      fetch(`http://127.0.0.1:${PORT}/health`)
        .then((r) => (r.ok ? resolve() : retry()))
        .catch(retry);
    };
    const retry = () => {
      if (Date.now() > deadline) reject(new Error("api /health never came up"));
      else setTimeout(poll, 1000);
    };
    poll();
  });
}

function run(name, args) {
  const child = spawn("node", args, { cwd: apiDir, stdio: "inherit" });
  child.on("exit", (code, signal) => {
    console.error(`[serve-both] ${name} exited (code=${code} signal=${signal}) — shutting down`);
    shutdown(code ?? 1);
  });
  return child;
}

const children = [];
let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 5000).unref();
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

seedDemoRepo();
children.push(run("api", ["dist/index.js"]));
try {
  await waitForHealth();
} catch (err) {
  console.error("[serve-both]", err);
  shutdown(1);
}
children.push(run("worker", ["dist/worker.js"]));
console.log("[serve-both] api healthy, worker started");
