import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { redisConnection } from "./queue/connection.js";
import { RUN_DISPATCH_QUEUE, type HopJobData } from "./queue/runQueue.js";
import { SCHEDULED_TRIGGER_QUEUE, type ScheduledTriggerJobData, registerSchedule } from "./queue/scheduleQueue.js";
import { dispatchHop } from "./orchestrator/engine.js";
import { runScheduledTrigger } from "./orchestrator/scheduledTrigger.js";
import { pruneWorktrees } from "@openbots/providers";
import { db } from "./db/client.js";
import { scheduledTriggers } from "./db/schema.js";
import { getAllowedWriteRoots } from "./validation/fileAccessRoot.js";
import { initOtel } from "./observability/otel.js";

initOtel("openbots-worker");

/**
 * Separate process from the Fastify API by design: the API only enqueues
 * hops, this worker executes them. Scale worker concurrency independently
 * of HTTP traffic, and a crashed/stuck worker never takes the API down.
 */
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 10);

const hopWorker = new Worker<HopJobData>(
  RUN_DISPATCH_QUEUE,
  async (job) => {
    await dispatchHop(job.data.runId);
  },
  { connection: redisConnection, concurrency },
);

hopWorker.on("failed", (job, err) => {
  console.error(`Hop job ${job?.id} for run ${job?.data.runId} failed:`, err);
});

const scheduleWorker = new Worker<ScheduledTriggerJobData>(
  SCHEDULED_TRIGGER_QUEUE,
  async (job) => {
    await runScheduledTrigger(job.data.triggerId);
  },
  { connection: redisConnection, concurrency: 1 },
);

scheduleWorker.on("failed", (job, err) => {
  console.error(`Scheduled trigger job for trigger ${job?.data.triggerId} failed:`, err);
});

/**
 * BullMQ job schedulers persist in Redis independently of this process,
 * so they normally survive an API/worker restart with no extra work. But
 * Postgres is the actual source of truth (a schedule's enabled/cron state
 * can outlive Redis — e.g. a `docker compose down -v` wipes Redis but not
 * a separately-persisted Postgres volume) — re-registering every enabled
 * trigger on boot is idempotent (same trigger id = same jobSchedulerId)
 * and makes sure the two never drift apart for long.
 */
async function reconcileSchedules(): Promise<void> {
  const active = await db.select().from(scheduledTriggers).where(eq(scheduledTriggers.enabled, true));
  for (const trigger of active) {
    try {
      await registerSchedule(trigger.id, trigger.cronExpression);
    } catch (err) {
      console.error(`Failed to re-register schedule ${trigger.id} on startup:`, err);
    }
  }
  console.log(`Reconciled ${active.length} active schedule(s) with BullMQ`);
}

/**
 * Agent write worktrees are one full checkout per (node, run) and nothing
 * previously removed them — a single actively-dogfooded repo accumulated
 * 18 in a day. Removing the DIRECTORY loses nothing: the `openbots/*`
 * branch and every commit stay in the repo's object store, so unpushed
 * work is still recoverable and `/push` still works (see pruneWorktrees).
 *
 * Runs on boot rather than on a timer: worktrees are only created by hops,
 * boots are frequent enough in practice, and a boot-time sweep can't
 * contend with a hop that's mid-write in the same process. Scoped to the
 * operator's own ALLOWED_FILE_WRITE_ROOTS — the only paths a worktree can
 * exist under — so it never touches a directory the operator didn't
 * already grant write access to. Awaited but fully non-fatal: housekeeping
 * must never stop the worker from starting.
 */
const WORKTREE_RETENTION_HOURS = Number(process.env.WORKTREE_RETENTION_HOURS ?? 168);

async function pruneOldWorktrees(): Promise<void> {
  if (!Number.isFinite(WORKTREE_RETENTION_HOURS) || WORKTREE_RETENTION_HOURS <= 0) {
    console.log("Worktree pruning disabled (WORKTREE_RETENTION_HOURS <= 0)");
    return;
  }
  const maxAgeMs = WORKTREE_RETENTION_HOURS * 60 * 60 * 1000;
  let removed = 0;
  let keptDirty = 0;
  for (const root of getAllowedWriteRoots()) {
    try {
      const result = await pruneWorktrees(root, maxAgeMs);
      removed += result.removed.length;
      keptDirty += result.keptDirty.length;
    } catch (err) {
      console.warn(`Worktree prune failed for ${root}:`, err);
    }
  }
  if (removed || keptDirty) {
    console.log(
      `Pruned ${removed} worktree(s) older than ${WORKTREE_RETENTION_HOURS}h` +
        (keptDirty ? `; kept ${keptDirty} with uncommitted changes` : ""),
    );
  }
}

await reconcileSchedules();
await pruneOldWorktrees();

console.log(`OpenBots worker started (concurrency=${concurrency})`);
