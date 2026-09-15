import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { verifySessionToken } from "./session.js";

const COOKIE_NAME = "openbots_session";

declare module "fastify" {
  interface FastifyRequest {
    userId: string | null;
  }
}

/**
 * Wrapped with fastify-plugin: without it, `register()` creates a new
 * encapsulated child context, and this plugin's decorateRequest/addHook
 * calls would only apply there — never reaching the sibling route
 * registrations (graphRoutes, runRoutes, etc.) in index.ts. req.userId
 * would silently be undefined everywhere else, and every route would look
 * unauthenticated regardless of a valid session cookie.
 */
export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest("userId", null);

  app.addHook("preHandler", async (req) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return;
    const payload = verifySessionToken(token);
    req.userId = payload?.userId ?? null;
  });
});

/**
 * Deliberately NOT tied to NODE_ENV: a self-hosted deployment's production
 * build very often still serves plain HTTP (no TLS in the app itself,
 * behind a private network or a proxy the operator controls). Tying
 * `secure` to NODE_ENV would silently break every login the moment
 * someone runs the production image without a TLS terminator in front of
 * it. COOKIE_SECURE is opt-in and explicit instead.
 */
export function setSessionCookie(reply: FastifyReply, token: string) {
  // COOKIE_SAMESITE exists for deployments where web and api live on
  // different eTLD+1s — e.g. Railway's *.up.railway.app, which is on the
  // Public Suffix List, making two of its subdomains cross-site and
  // SameSite=Lax undeliverable. "none" is only meaningful over HTTPS
  // (browsers reject SameSite=None without Secure), so it forces secure
  // on regardless of COOKIE_SECURE. Same-site setups (a custom domain's
  // subdomains, or localhost) should leave this unset.
  const sameSite = (process.env.COOKIE_SAMESITE ?? "lax") as "lax" | "strict" | "none";
  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite,
    secure: sameSite === "none" || process.env.COOKIE_SECURE === "true",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(COOKIE_NAME, { path: "/" });
}

/** Use as a route's preHandler to reject unauthenticated requests. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  if (!req.userId) {
    reply.code(401).send({ error: "Authentication required" });
  }
}
