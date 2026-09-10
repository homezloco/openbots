import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { userCredentials } from "../db/schema.js";
import { encryptCredential } from "../auth/crypto.js";
import { requireAuth } from "../auth/middleware.js";
import { METRICS_SLUG_PATTERN, METRICS_STYLES } from "../orchestrator/businessMetricsTool.js";

const METRICS_PROVIDER_PREFIX = "metrics_";

function isValidMetricsLogin(value: string): boolean {
  try {
    const parsed = JSON.parse(value);
    return (
      typeof parsed?.username === "string" &&
      parsed.username.length > 0 &&
      typeof parsed?.password === "string" &&
      parsed.password.length > 0 &&
      typeof parsed?.baseUrl === "string" &&
      /^https?:\/\//.test(parsed.baseUrl) &&
      (METRICS_STYLES as readonly string[]).includes(parsed?.style)
    );
  } catch {
    return false;
  }
}

const PEM_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

const createCredentialBody = z
  .object({
    provider: z.string().min(1),
    apiKey: z.string().min(1),
    label: z.string().optional(),
  })
  .refine(
    (body) => body.provider !== "github_ssh_key" || PEM_KEY_PATTERN.test(body.apiKey),
    { message: "Expected a PEM-encoded private key (starting with -----BEGIN ... PRIVATE KEY-----)", path: ["apiKey"] },
  )
  .refine(
    // sshCredentialProvider() (orchestrator/remoteCommandTool.ts) names
    // these "ssh_target_<host-slug>" — one provider per host, same PEM
    // shape github_ssh_key already validates.
    (body) => !body.provider.startsWith("ssh_target_") || PEM_KEY_PATTERN.test(body.apiKey),
    { message: "Expected a PEM-encoded private key (starting with -----BEGIN ... PRIVATE KEY-----)", path: ["apiKey"] },
  )
  .refine(
    // metricsSourceProvider() (orchestrator/businessMetricsTool.ts) names
    // these "metrics_<slug>" — a user-chosen slug per source, not a
    // fixed list, so the slug itself needs validating here too.
    (body) => !body.provider.startsWith(METRICS_PROVIDER_PREFIX) || METRICS_SLUG_PATTERN.test(body.provider.slice(METRICS_PROVIDER_PREFIX.length)),
    { message: "Expected a source name of 1-32 lowercase letters, digits, or hyphens", path: ["provider"] },
  )
  .refine((body) => !body.provider.startsWith(METRICS_PROVIDER_PREFIX) || isValidMetricsLogin(body.apiKey), {
    message: 'Expected a JSON-encoded {"username", "password", "baseUrl", "style"} object',
    path: ["apiKey"],
  });

function toSummary(row: typeof userCredentials.$inferSelect) {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Account-scoped credentials, separate from the graph/node-scoped AI
 * provider keys. v1 supports a single GitHub token per user for the
 * /push command. The plaintext key is only ever seen on create.
 */
export async function userCredentialRoutes(app: FastifyInstance) {
  app.post("/me/credentials", { preHandler: requireAuth }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "Unauthorized" });
    const body = createCredentialBody.parse(req.body);
    const [row] = await db
      .insert(userCredentials)
      .values({
        userId: req.userId as string,
        provider: body.provider,
        label: body.label ?? "",
        encryptedKey: encryptCredential(body.apiKey),
      })
      .onConflictDoUpdate({
        target: [userCredentials.userId, userCredentials.provider],
        set: {
          encryptedKey: encryptCredential(body.apiKey),
          label: body.label ?? "",
        },
      })
      .returning();
    return reply.code(201).send(toSummary(row));
  });

  app.get("/me/credentials", { preHandler: requireAuth }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "Unauthorized" });
    const rows = await db
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.userId, req.userId as string));
    return rows.map(toSummary);
  });

  app.delete("/me/credentials/:id", { preHandler: requireAuth }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "Unauthorized" });
    const { id } = req.params as { id: string };
    const deleted = await db
      .delete(userCredentials)
      .where(and(eq(userCredentials.id, id), eq(userCredentials.userId, req.userId as string)))
      .returning({ id: userCredentials.id });
    if (deleted.length === 0) return reply.code(404).send({ error: "Credential not found" });
    return reply.code(204).send();
  });
}
