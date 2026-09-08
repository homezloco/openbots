// Builds the real git repository the write-tool e2e tests run against.
// Not committed to this repo itself (see .gitignore) — regenerated fresh
// before every e2e run via the "pretest:e2e" npm lifecycle hook, so it
// works identically for local `docker compose up` and CI, with no
// separate manual setup step. Deliberately plain Node (no TS syntax)
// so it can run directly without tsx.
import { existsSync, mkdirSync, rmSync, symlinkSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const seedDir = join(here, "fixtures", "writable-testrepo-seed");
const scratchDir = join(here, "fixtures", "writable-testrepo");
const outsideDir = join(here, "fixtures", "writable-testrepo-outside");

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

if (existsSync(scratchDir)) rmSync(scratchDir, { recursive: true, force: true });
if (existsSync(outsideDir)) rmSync(outsideDir, { recursive: true, force: true });

cpSync(seedDir, scratchDir, { recursive: true });
mkdirSync(outsideDir, { recursive: true });

// A symlink inside the repo pointing outside it — the fixture the
// symlink-escape e2e test writes through. A benign, freshly-generated
// scratch directory (not a real system path); the property under test is
// "does the path-boundary check follow the symlink," not that the target
// itself is sensitive.
symlinkSync(outsideDir, join(scratchDir, "escape-link"));

git(["init", "-q", "-b", "main"], scratchDir);
git(["config", "user.email", "e2e@openbots.dev"], scratchDir);
git(["config", "user.name", "E2E Fixture"], scratchDir);
git(["add", "-A"], scratchDir);
git(["commit", "-q", "-m", "seed"], scratchDir);

console.log(`Initialized writable e2e fixture at ${scratchDir}`);
