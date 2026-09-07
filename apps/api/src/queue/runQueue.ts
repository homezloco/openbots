import { Queue } from "bullmq";
import { redisConnection } from "./connection.js";

export interface HopJobData {
  runId: string;
}

export const RUN_DISPATCH_QUEUE = "run-dispatch";

export const runQueue = new Queue<HopJobData>(RUN_DISPATCH_QUEUE, {
  connection: redisConnection,
});

/** Enqueue the next hop for a run. One job per hop, not one job per run. */
export function enqueueHop(runId: string) {
  return runQueue.add("dispatch-hop", { runId });
}
