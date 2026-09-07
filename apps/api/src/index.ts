import Fastify from "fastify";
import websocketPlugin from "@fastify/websocket";
import { graphRoutes } from "./routes/graphs.js";
import { runRoutes } from "./routes/runs.js";
import { wsRoutes } from "./ws/hub.js";

const app = Fastify({ logger: true });

await app.register(websocketPlugin);
await app.register(graphRoutes);
await app.register(runRoutes);
await app.register(wsRoutes);

app.get("/health", async () => ({ status: "ok" }));

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: "0.0.0.0" });
