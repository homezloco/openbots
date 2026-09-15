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

/**
 * Sliding-window per-IP limiter — same in-memory pattern as
 * webhookTriggers.ts's fireLog: a single api container (docker-compose.yml
 * has no replicas) makes a process-local counter fully effective, not a
 * partial mitigation. trustProxy isn't enabled on this Fastify instance,
 * so req.ip is the direct peer — correct enough for throttling, since a
 * shared-proxy deployment collapsing all clients into one IP errs toward
 * MORE limiting, never less.
 */
function makeRateLimiter(maxPerWindow: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (ip: string): boolean => {
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(ip, recent);
    // Bounded memory: without this, every distinct source IP would leave
    // an entry behind forever. Only sweep when the map gets large — the
    // O(n) pass then runs at most once per window anyway.
    if (hits.size > 10_000) {
      for (const [key, times] of hits) {
        if (times[times.length - 1] < now - windowMs) hits.delete(key);
      }
    }
    return recent.length > maxPerWindow;
  };
}

// Limits are env-overridable because a legitimate single source can blow
// through the defaults: the e2e suite signs up a fresh throwaway user per
// IDOR/security case, all from one IP inside a few seconds — which was a
// real CI failure (a 429'd signup → no session cookie → a 60-test cascade
// of 401s). Production posture stays strict; only the limit moves.
const signupLimited = makeRateLimiter(Number(process.env.SIGNUP_RATE_LIMIT_PER_MINUTE ?? 5), 60_000);
// Looser than signup since a legit user typos a few passwords; still
// bounds online guessing to ~10/min per IP on top of scrypt's own cost.
const loginLimited = makeRateLimiter(Number(process.env.LOGIN_RATE_LIMIT_PER_MINUTE ?? 10), 60_000);

function toPublicUser(user: { id: string; email: string; createdAt: Date }) {
  return { id: user.id, email: user.email, createdAt: user.createdAt.toISOString() };
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/signup", async (req, reply) => {
    // Signup is open by default because the first-run self-hosted flow
    // needs it (there's no admin-seeded account). DISABLE_SIGNUP=true is
    // the intended posture for anything internet-exposed: an open signup
    // on an instance with env-configured provider keys lets a stranger
    // run graphs that bill to the operator. Read per-request so a test
    // or a long-lived process can toggle it without a restart.
    if (process.env.DISABLE_SIGNUP === "true") {
      return reply.code(403).send({ error: "Signup is disabled on this instance" });
    }
    if (signupLimited(req.ip)) {
      return reply.code(429).send({ error: "Too many attempts — try again in a minute" });
    }

    const body = credentialsBody.parse(req.body);

    const existing = await db.query.users.findFirst({ where: eq(users.email, body.email) });
    if (existing) return reply.code(409).send({ error: "Email already registered" });

    const passwordHash = await hashPassword(body.password);
    const [user] = await db.insert(users).values({ email: body.email, passwordHash }).returning();

    setSessionCookie(reply, createSessionToken(user.id));
    return reply.code(201).send(toPublicUser(user));
  });

  app.post("/auth/login", async (req, reply) => {
    if (loginLimited(req.ip)) {
      return reply.code(429).send({ error: "Too many attempts — try again in a minute" });
    }
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
