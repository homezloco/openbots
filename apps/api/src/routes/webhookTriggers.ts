import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { RunMode } from "@openbots/graph-schema";
import { db } from "../db/client.js";
import { agentGraphs, runs, webhookTriggers } from "../db/schema.js";
import { requireAuth } from "../auth/middleware.js";
import { requireGraphOwner } from "./graphs.js";
import { createRun } from "../orchestrator/createRun.js";

const createWebhookBody = z.object({
  name: z.string().min(1),
  mode: RunMode.default("pinned"),
});

const updateWebhookBody = z.object({
  name: z.string().min(1).optional(),
  mode: RunMode.optional(),
  enabled: z.boolean().optional(),
});

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

function toSummary(row: typeof webhookTriggers.$inferSelect) {
  return {
    id: row.id,
    graphId: row.graphId,
    name: row.name,
    mode: row.mode,
    enabled: row.enabled,
    lastRunId: row.lastRunId,
    lastTriggeredAt: row.lastTriggeredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const RATE_LIMIT_MAX_PER_MINUTE = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
// Single api container (docker-compose.yml, no replicas), so an in-memory
// per-trigger counter is fully effective, not a partial mitigation — same
// justification apps/api/src/smithery.ts's cache already relies on.
const fireLog = new Map<string, number[]>();

function isRateLimited(triggerId: string): boolean {
  const now = Date.now();
  const recent = (fireLog.get(triggerId) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  fireLog.set(triggerId, recent);
  // Bounded memory: deleted triggers' entries would otherwise persist
  // forever. Same sweep as auth/routes.ts's rate limiter — only worth
  // running once the map is actually large.
  if (fireLog.size > 10_000) {
    for (const [key, times] of fireLog) {
      if (times[times.length - 1] < now - RATE_LIMIT_WINDOW_MS) fireLog.delete(key);
    }
  }
  return recent.length > RATE_LIMIT_MAX_PER_MINUTE;
}

/**
 * Webhook triggers: run a graph in response to an inbound HTTP event
 * instead of a manual call or a cron schedule. Two route groups with
 * completely different trust models, kept in one file so that
 * distinction stays visible rather than getting lost across files:
 *
 * - CRUD (below): requireAuth + requireGraphOwner, direct mirror of
 *   scheduledTriggers.ts.
 * - Firing (POST /webhooks/:token): no session at all — this is the
 *   first route in this codebase reachable by an anonymous caller. The
 *   token itself is the entire authorization; see the schema.ts comment
 *   on webhookTriggers for why it's stored only as a hash and shown to
 *   the operator exactly once.
 *
 * Deliberately no per-provider signature verification (Stripe/GitHub/
 * Slack schemes) — see PLAN.md's webhook-triggers entry for why a
 * single generic high-entropy secret is the v1 design.
 */
export async function webhookTriggerRoutes(app: FastifyInstance) {
  app.post("/graphs/:graphId/webhooks", { preHandler: requireAuth }, async (req, reply) => {
    const { graphId } = req.params as { graphId: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;
    const body = createWebhookBody.parse(req.body);

    const token = generateToken();
    const [row] = await db
      .insert(webhookTriggers)
      .values({
        graphId,
        createdBy: req.userId,
        name: body.name,
        mode: body.mode,
        tokenHash: hashToken(token),
      })
      .returning();

    // The only time this plaintext token is ever available again.
    return reply.code(201).send({ ...toSummary(row), token });
  });

  app.get("/graphs/:graphId/webhooks", { preHandler: requireAuth }, async (req, reply) => {
    const { graphId } = req.params as { graphId: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;
    const rows = await db
      .select()
      .from(webhookTriggers)
      .where(eq(webhookTriggers.graphId, graphId))
      .orderBy(desc(webhookTriggers.createdAt));
    return rows.map(toSummary);
  });

  app.patch("/graphs/:graphId/webhooks/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { graphId, id } = req.params as { graphId: string; id: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;

    const existing = await db.query.webhookTriggers.findFirst({
      where: and(eq(webhookTriggers.id, id), eq(webhookTriggers.graphId, graphId)),
    });
    if (!existing) return reply.code(404).send({ error: "Webhook not found" });

    const body = updateWebhookBody.parse(req.body);
    const [row] = await db
      .update(webhookTriggers)
      .set({
        name: body.name !== undefined ? body.name : existing.name,
        mode: body.mode !== undefined ? body.mode : existing.mode,
        enabled: body.enabled !== undefined ? body.enabled : existing.enabled,
        updatedAt: new Date(),
      })
      .where(and(eq(webhookTriggers.id, id), eq(webhookTriggers.graphId, graphId)))
      .returning();

    return toSummary(row);
  });

  /** Generates a new secret and invalidates the old one immediately — only the current hash is ever stored. */
  app.post("/graphs/:graphId/webhooks/:id/rotate", { preHandler: requireAuth }, async (req, reply) => {
    const { graphId, id } = req.params as { graphId: string; id: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;

    const token = generateToken();
    const [row] = await db
      .update(webhookTriggers)
      .set({ tokenHash: hashToken(token), updatedAt: new Date() })
      .where(and(eq(webhookTriggers.id, id), eq(webhookTriggers.graphId, graphId)))
      .returning();
    if (!row) return reply.code(404).send({ error: "Webhook not found" });

    return { ...toSummary(row), token };
  });

  app.delete("/graphs/:graphId/webhooks/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { graphId, id } = req.params as { graphId: string; id: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;

    const deleted = await db
      .delete(webhookTriggers)
      .where(and(eq(webhookTriggers.id, id), eq(webhookTriggers.graphId, graphId)))
      .returning({ id: webhookTriggers.id });
    if (deleted.length === 0) return reply.code(404).send({ error: "Webhook not found" });
    // No BullMQ job scheduler exists for a webhook trigger (purely
    // reactive — a DB row + an endpoint lookup) — unlike scheduled
    // triggers, there's no external Redis state to unregister here.
    return reply.code(204).send();
  });

  app.get("/graphs/:graphId/webhooks/:id/runs", { preHandler: requireAuth }, async (req, reply) => {
    const { graphId, id } = req.params as { graphId: string; id: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;

    const existing = await db.query.webhookTriggers.findFirst({
      where: and(eq(webhookTriggers.id, id), eq(webhookTriggers.graphId, graphId)),
    });
    if (!existing) return reply.code(404).send({ error: "Webhook not found" });

    const rows = await db
      .select({ id: runs.id, status: runs.status, createdAt: runs.createdAt, completedAt: runs.completedAt })
      .from(runs)
      .where(and(eq(runs.webhookTriggerId, id), eq(runs.graphId, graphId)))
      .orderBy(desc(runs.createdAt));

    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
    }));
  });

  // --- Firing: no session, no ownership check — the token is the boundary ---
  app.post("/webhooks/:token", async (req, reply) => {
    const { token } = req.params as { token: string };

    const trigger = await db.query.webhookTriggers.findFirst({
      where: eq(webhookTriggers.tokenHash, hashToken(token)),
    });
    // Same 404 for "no such token" and "disabled" — don't let response
    // shape leak whether a token almost-matched or the trigger exists
    // but is off, to an unauthenticated caller.
    if (!trigger || !trigger.enabled) return reply.code(404).send({ error: "Not found" });

    if (isRateLimited(trigger.id)) {
      return reply.code(429).send({ error: "Too many requests" });
    }

    if (req.body !== undefined && (typeof req.body !== "object" || req.body === null)) {
      return reply.code(400).send({ error: "Expected a JSON object body" });
    }

    // Re-read fresh from Postgres, same "never trust anything captured
    // earlier" principle orchestrator/scheduledTrigger.ts already follows.
    const graphRow = await db.query.agentGraphs.findFirst({ where: eq(agentGraphs.id, trigger.graphId) });
    if (!graphRow) return reply.code(404).send({ error: "Not found" });
    if (!graphRow.entryNodeId) {
      return reply.code(400).send({ error: "This graph has no entry node configured yet" });
    }

    const run = await createRun(graphRow, req.body ?? {}, trigger.mode as "pinned" | "live", undefined, 0, undefined, trigger.id);

    await db
      .update(webhookTriggers)
      .set({ lastRunId: run.id, lastTriggeredAt: new Date() })
      .where(eq(webhookTriggers.id, trigger.id));

    return reply.code(202).send({ runId: run.id });
  });
}
