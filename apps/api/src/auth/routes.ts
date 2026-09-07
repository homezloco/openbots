import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { hashPassword, verifyPassword } from "./password.js";
import { createSessionToken } from "./session.js";
import { clearSessionCookie, requireAuth, setSessionCookie } from "./middleware.js";

const credentialsBody = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

function toPublicUser(user: { id: string; email: string; createdAt: Date }) {
  return { id: user.id, email: user.email, createdAt: user.createdAt.toISOString() };
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/signup", async (req, reply) => {
    const body = credentialsBody.parse(req.body);

    const existing = await db.query.users.findFirst({ where: eq(users.email, body.email) });
    if (existing) return reply.code(409).send({ error: "Email already registered" });

    const passwordHash = await hashPassword(body.password);
    const [user] = await db.insert(users).values({ email: body.email, passwordHash }).returning();

    setSessionCookie(reply, createSessionToken(user.id));
    return reply.code(201).send(toPublicUser(user));
  });

  app.post("/auth/login", async (req, reply) => {
    const body = credentialsBody.parse(req.body);

    const user = await db.query.users.findFirst({ where: eq(users.email, body.email) });
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      return reply.code(401).send({ error: "Invalid email or password" });
    }

    setSessionCookie(reply, createSessionToken(user.id));
    return toPublicUser(user);
  });

  app.post("/auth/logout", async (_req, reply) => {
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.get("/auth/me", { preHandler: requireAuth }, async (req, reply) => {
    const user = await db.query.users.findFirst({ where: eq(users.id, req.userId!) });
    if (!user) return reply.code(401).send({ error: "Authentication required" });
    return toPublicUser(user);
  });
}
