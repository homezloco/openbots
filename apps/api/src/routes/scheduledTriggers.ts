import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { RunMode } from "@openbots/graph-schema";
import { db } from "../db/client.js";
import { scheduledTriggers } from "../db/schema.js";
import { requireAuth } from "../auth/middleware.js";
import { requireGraphOwner } from "./graphs.js";
import { registerSchedule, unregisterSchedule } from "../queue/scheduleQueue.js";

// A light structural pre-check (right field count) — the authoritative
// check is cron-parser itself, run inside registerSchedule below, whose
// error becomes the 400 response. 5-field (standard) or 6-field (with a
// leading seconds field, which cron-parser also accepts) both allowed.
const CRON_SHAPE = /^\S+(\s+\S+){4,5}$/;
const cronExpressionSchema = z.string().refine((v) => CRON_SHAPE.test(v.trim()), "Expected a 5- or 6-field cron expression");

const createScheduleBody = z.object({
  name: z.string().min(1),
  input: z.unknown(),
  cronExpression: cronExpressionSchema,
  mode: RunMode.default("pinned"),
  enabled: z.boolean().default(true),
});

const updateScheduleBody = z.object({
  name: z.string().min(1).optional(),
  input: z.unknown().optional(),
  cronExpression: cronExpressionSchema.optional(),
  mode: RunMode.optional(),
  enabled: z.boolean().optional(),
});

function toSummary(row: typeof scheduledTriggers.$inferSelect) {
  return {
    id: row.id,
    graphId: row.graphId,
    name: row.name,
    input: row.input,
    cronExpression: row.cronExpression,
    mode: row.mode,
    enabled: row.enabled,
    lastRunId: row.lastRunId,
    lastTriggeredAt: row.lastTriggeredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Runs a graph on a recurring cron schedule via a BullMQ job scheduler
 * (see queue/scheduleQueue.ts) — the actual firing logic lives in
 * orchestrator/scheduledTrigger.ts, invoked by the worker.
 */
export async function scheduledTriggerRoutes(app: FastifyInstance) {
  app.post("/graphs/:graphId/schedules", { preHandler: requireAuth }, async (req, reply) => {
    const { graphId } = req.params as { graphId: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;
    const body = createScheduleBody.parse(req.body);

    // Generated before insert so it can double as BullMQ's jobSchedulerId —
    // registered first so an invalid cron pattern is rejected before
    // anything is persisted.
    const id = randomUUID();
    if (body.enabled) {
      try {
        await registerSchedule(id, body.cronExpression);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : "Invalid cron expression" });
      }
    }

    const [row] = await db
      .insert(scheduledTriggers)
      .values({
        id,
        graphId,
        createdBy: req.userId,
        name: body.name,
        input: body.input,
        cronExpression: body.cronExpression,
        mode: body.mode,
        enabled: body.enabled,
      })
      .returning();

    return reply.code(201).send(toSummary(row));
  });

  app.get("/graphs/:graphId/schedules", { preHandler: requireAuth }, async (req, reply) => {
    const { graphId } = req.params as { graphId: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;
    const rows = await db
      .select()
      .from(scheduledTriggers)
      .where(eq(scheduledTriggers.graphId, graphId))
      .orderBy(desc(scheduledTriggers.createdAt));
    return rows.map(toSummary);
  });

  app.patch("/graphs/:graphId/schedules/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { graphId, id } = req.params as { graphId: string; id: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;

    const existing = await db.query.scheduledTriggers.findFirst({
      where: and(eq(scheduledTriggers.id, id), eq(scheduledTriggers.graphId, graphId)),
    });
    if (!existing) return reply.code(404).send({ error: "Schedule not found" });

    const body = updateScheduleBody.parse(req.body);
    const nextCron = body.cronExpression !== undefined ? body.cronExpression : existing.cronExpression;
    const nextEnabled = body.enabled !== undefined ? body.enabled : existing.enabled;

    try {
      if (nextEnabled) {
        await registerSchedule(id, nextCron);
      } else {
        await unregisterSchedule(id);
      }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "Invalid cron expression" });
    }

    const [row] = await db
      .update(scheduledTriggers)
      .set({
        name: body.name !== undefined ? body.name : existing.name,
        input: body.input !== undefined ? body.input : existing.input,
        cronExpression: nextCron,
        mode: body.mode !== undefined ? body.mode : existing.mode,
        enabled: nextEnabled,
        updatedAt: new Date(),
      })
      .where(and(eq(scheduledTriggers.id, id), eq(scheduledTriggers.graphId, graphId)))
      .returning();

    return toSummary(row);
  });

  app.delete("/graphs/:graphId/schedules/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { graphId, id } = req.params as { graphId: string; id: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;

    const deleted = await db
      .delete(scheduledTriggers)
      .where(and(eq(scheduledTriggers.id, id), eq(scheduledTriggers.graphId, graphId)))
      .returning({ id: scheduledTriggers.id });
    if (deleted.length === 0) return reply.code(404).send({ error: "Schedule not found" });

    await unregisterSchedule(id);
    return reply.code(204).send();
  });
}
