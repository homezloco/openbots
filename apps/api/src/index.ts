import Fastify from "fastify";
import cookiePlugin from "@fastify/cookie";
import corsPlugin from "@fastify/cors";
import websocketPlugin from "@fastify/websocket";
import { ZodError } from "zod";
import { authPlugin } from "./auth/middleware.js";
import { authRoutes } from "./auth/routes.js";
import { agentRoutes } from "./routes/agents.js";
import { graphRoutes } from "./routes/graphs.js";
import { quickAddRoutes } from "./routes/quickAdd.js";
import { runRoutes } from "./routes/runs.js";
import { scheduledTriggerRoutes } from "./routes/scheduledTriggers.js";
import { webhookTriggerRoutes } from "./routes/webhookTriggers.js";
import { commitRoutes } from "./routes/commits.js";
import { credentialRoutes } from "./routes/credentials.js";
import { userCredentialRoutes } from "./routes/userCredentials.js";
import { templateRoutes } from "./routes/templates.js";
import { routingChangeRoutes } from "./routes/routingChanges.js";
import { wsRoutes } from "./ws/hub.js";
import { mcpRoutes } from "./routes/mcp.js";
import { configRoutes } from "./routes/config.js";
import { applyMigrations } from "./db/migrate.js";
import { initOtel } from "./observability/otel.js";

initOtel("openbots-api");

await applyMigrations();

const app = Fastify({ logger: true });

// Every route does `xBody.parse(req.body)` directly rather than via
// Fastify's schema validation, so a ZodError was previously an uncaught
// exception — Fastify's default handler turned it into a bare 500 with
// no statusCode on the error object, for every invalid request body in
// the app. Must be set BEFORE the route plugins are registered below:
// setErrorHandler follows Fastify's encapsulation model like addHook/
// decorateRequest (see authPlugin's fastify-plugin comment) — a plain
// `register()`'d plugin's already-created child context does not pick up
// a handler set on the parent afterward. Found via an e2e test expecting
// a 400 for a rejected fileAccessRoot and getting a 500 instead.
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: "Invalid request body", issues: err.issues });
  }
  app.log.error(err);
  return reply.code(500).send({ error: "Internal server error" });
});

// Cookie-based sessions need credentialed CORS: a wildcard origin is
// rejected by browsers when credentials are involved, so this reads one
// explicit origin from the environment rather than allowing "*".
await app.register(corsPlugin, {
  origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
  credentials: true,
});
await app.register(cookiePlugin);
await app.register(websocketPlugin);
await app.register(authPlugin);
await app.register(authRoutes);
await app.register(graphRoutes);
await app.register(agentRoutes);
await app.register(quickAddRoutes);
await app.register(runRoutes);
await app.register(scheduledTriggerRoutes);
await app.register(webhookTriggerRoutes);
await app.register(commitRoutes);
await app.register(credentialRoutes);
await app.register(userCredentialRoutes);
await app.register(templateRoutes);
await app.register(routingChangeRoutes);
await app.register(wsRoutes);
await app.register(mcpRoutes);
await app.register(configRoutes);

app.get("/health", async () => ({ status: "ok" }));

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: "0.0.0.0" });
