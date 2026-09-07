import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { ProviderId } from "@openbots/graph-schema";
import { db } from "../db/client.js";
import { providerCredentials } from "../db/schema.js";
import { encryptCredential } from "../auth/crypto.js";
import { requireAuth } from "../auth/middleware.js";
import { requireGraphOwner } from "./graphs.js";

const createCredentialBody = z.object({
  provider: ProviderId,
  apiKey: z.string().min(1),
  label: z.string().optional(),
  nodeId: z.string().uuid().optional(),
});

function toSummary(row: typeof providerCredentials.$inferSelect) {
  return {
    id: row.id,
    graphId: row.graphId,
    nodeId: row.nodeId,
    provider: row.provider,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Stored keys are always encrypted at rest (auth/crypto.ts, AES-256-GCM) and
 * the plaintext key never appears in any response — only this create call
 * ever sees it. See orchestrator/credentials.ts for how a node resolves
 * which key to use (node-specific -> graph-wide -> env var).
 */
export async function credentialRoutes(app: FastifyInstance) {
  app.post("/graphs/:id/credentials", { preHandler: requireAuth }, async (req, reply) => {
    const { id: graphId } = req.params as { id: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;
    const body = createCredentialBody.parse(req.body);

    const [row] = await db
      .insert(providerCredentials)
      .values({
        graphId,
        nodeId: body.nodeId ?? null,
        provider: body.provider,
        label: body.label ?? "",
        encryptedKey: encryptCredential(body.apiKey),
      })
      .returning();

    return reply.code(201).send(toSummary(row));
  });

  app.get("/graphs/:id/credentials", { preHandler: requireAuth }, async (req, reply) => {
    const { id: graphId } = req.params as { id: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;
    const rows = await db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.graphId, graphId));
    return rows.map(toSummary);
  });

  app.delete("/graphs/:id/credentials/:credentialId", { preHandler: requireAuth }, async (req, reply) => {
    const { id: graphId, credentialId } = req.params as { id: string; credentialId: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;
    await db.delete(providerCredentials).where(eq(providerCredentials.id, credentialId));
    return reply.code(204).send();
  });
}
