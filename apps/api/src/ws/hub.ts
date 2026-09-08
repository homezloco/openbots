import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { requireAuth } from "../auth/middleware.js";
import { requireGraphOwner } from "../routes/graphs.js";
import { RUN_EVENTS_CHANNEL, type RunEventMessage } from "./publish.js";

/**
 * One shared subscriber connection fans out to every connected canvas
 * client, filtered per-socket to the one graph it's scoped to. This is what
 * lights up nodes/edges live during a run and is the transport for
 * "applies on next hop" feedback after a drag-and-drop edit.
 *
 * SECURITY: this route used to be `/ws/runs` with no auth and no scoping at
 * all — every connected client received every user's run activity,
 * including output/error text. The ownership check MUST live in
 * `preHandler`, not in the socket callback below: `@fastify/websocket`
 * completes the HTTP upgrade (sends the 101 response) before invoking the
 * `(socket, req)` callback, so by the time that callback runs it's too late
 * to reject with a normal HTTP status — only an post-hoc `socket.close()`
 * is possible, which still leaks the fact the handshake succeeded. Doing
 * the check in `preHandler` (which runs during Fastify's normal routing,
 * before the upgrade) lets an unauthorized request get a clean 401/403/404
 * and the socket never opens. `requireAuth` must run before
 * `requireGraphOwner`: that helper's `ownerId !== req.userId` check alone
 * passes when both are null (unauthenticated request against a graph whose
 * owner account was deleted).
 */
export async function wsRoutes(app: FastifyInstance) {
  const subscriber = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  await subscriber.subscribe(RUN_EVENTS_CHANNEL);

  app.get(
    "/ws/graphs/:graphId/runs",
    {
      websocket: true,
      preHandler: [
        requireAuth,
        async (req, reply) => {
          const { graphId } = req.params as { graphId: string };
          await requireGraphOwner(req, reply, graphId);
        },
      ],
    },
    (socket, req) => {
      const { graphId } = req.params as { graphId: string };
      const onMessage = (channel: string, message: string) => {
        if (channel !== RUN_EVENTS_CHANNEL) return;
        const parsed = JSON.parse(message) as RunEventMessage;
        if (parsed.graphId !== graphId) return;
        socket.send(message);
      };
      subscriber.on("message", onMessage);
      socket.on("close", () => subscriber.off("message", onMessage));
    },
  );

  app.addHook("onClose", async () => {
    await subscriber.quit();
  });
}
