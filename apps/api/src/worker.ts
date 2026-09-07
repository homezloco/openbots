import { Worker } from "bullmq";
import { redisConnection } from "./queue/connection.js";
import { RUN_DISPATCH_QUEUE, type HopJobData } from "./queue/runQueue.js";
import { dispatchHop } from "./orchestrator/engine.js";

/**
 * Separate process from the Fastify API by design: the API only enqueues
 * hops, this worker executes them. Scale worker concurrency independently
 * of HTTP traffic, and a crashed/stuck worker never takes the API down.
 */
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 10);

const worker = new Worker<HopJobData>(
  RUN_DISPATCH_QUEUE,
  async (job) => {
    await dispatchHop(job.data.runId);
  },
  { connection: redisConnection, concurrency },
);

worker.on("failed", (job, err) => {
  console.error(`Hop job ${job?.id} for run ${job?.data.runId} failed:`, err);
});

console.log(`OpenBots worker started (concurrency=${concurrency})`);
