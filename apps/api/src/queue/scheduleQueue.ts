import { Queue } from "bullmq";
import { redisConnection } from "./connection.js";

export interface ScheduledTriggerJobData {
  triggerId: string;
}

export const SCHEDULED_TRIGGER_QUEUE = "scheduled-trigger";

export const scheduleQueue = new Queue<ScheduledTriggerJobData>(SCHEDULED_TRIGGER_QUEUE, {
  connection: redisConnection,
});

/**
 * Registers (or re-registers, if one already exists for this id) a BullMQ
 * job scheduler for a trigger's cron pattern. Using the trigger's own id
 * as the jobSchedulerId means upserting is naturally idempotent — safe to
 * call again on every enable/edit, and on worker startup to reconcile
 * against Postgres (the source of truth) in case Redis data was ever
 * lost independently of it. Throws if the pattern is invalid (a 5- or
 * 6-field cron — cron-parser, which BullMQ uses internally, accepts an
 * optional leading seconds field) — callers should surface that as a 400.
 */
export async function registerSchedule(triggerId: string, cronExpression: string): Promise<void> {
  await scheduleQueue.upsertJobScheduler(
    triggerId,
    { pattern: cronExpression, tz: "UTC" },
    { name: "run-scheduled-trigger", data: { triggerId } },
  );
}

/** No-op if nothing was registered for this id (e.g. it was created disabled). */
export async function unregisterSchedule(triggerId: string): Promise<void> {
  await scheduleQueue.removeJobScheduler(triggerId);
}
