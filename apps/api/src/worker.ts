import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { redisConnection } from "./queue/connection.js";
import { RUN_DISPATCH_QUEUE, type HopJobData } from "./queue/runQueue.js";
import { SCHEDULED_TRIGGER_QUEUE, type ScheduledTriggerJobData, registerSchedule } from "./queue/scheduleQueue.js";
import { dispatchHop } from "./orchestrator/engine.js";
import { runScheduledTrigger } from "./orchestrator/scheduledTrigger.js";
import { db } from "./db/client.js";
import { scheduledTriggers } from "./db/schema.js";
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

await reconcileSchedules();

console.log(`OpenBots worker started (concurrency=${concurrency})`);
