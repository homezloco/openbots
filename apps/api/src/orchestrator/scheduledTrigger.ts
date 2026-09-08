import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentGraphs, scheduledTriggers } from "../db/schema.js";
import { createRun } from "./createRun.js";

/**
 * Processes one firing of a repeatable BullMQ job scheduler for a
 * scheduled trigger. Re-validates against the CURRENT state of the
 * trigger/graph rather than trusting anything captured when the schedule
 * was registered — a trigger can be disabled or deleted, or its graph's
 * entryNodeId cleared, between when BullMQ scheduled this firing and when
 * it actually runs.
 */
export async function runScheduledTrigger(triggerId: string): Promise<void> {
  const trigger = await db.query.scheduledTriggers.findFirst({ where: eq(scheduledTriggers.id, triggerId) });
  if (!trigger || !trigger.enabled) return;

  const graphRow = await db.query.agentGraphs.findFirst({ where: eq(agentGraphs.id, trigger.graphId) });
  if (!graphRow || !graphRow.entryNodeId) {
    console.error(`Scheduled trigger ${triggerId}: graph ${trigger.graphId} is missing or has no entryNodeId — skipping`);
    return;
  }

  const run = await createRun(graphRow, trigger.input, trigger.mode as "pinned" | "live");

  await db.update(scheduledTriggers).set({ lastRunId: run.id, lastTriggeredAt: new Date() }).where(eq(scheduledTriggers.id, triggerId));
}
