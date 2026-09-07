import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { RUN_EVENTS_CHANNEL } from "./publish.js";

/**
 * One shared subscriber connection fans out to every connected canvas
 * client. This is what lights up nodes/edges live during a run and is the
 * transport for "applies on next hop" feedback after a drag-and-drop edit.
 */
export async function wsRoutes(app: FastifyInstance) {
  const subscriber = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  await subscriber.subscribe(RUN_EVENTS_CHANNEL);

  app.get("/ws/runs", { websocket: true }, (socket) => {
    const onMessage = (channel: string, message: string) => {
      if (channel === RUN_EVENTS_CHANNEL) socket.send(message);
    };
    subscriber.on("message", onMessage);
    socket.on("close", () => subscriber.off("message", onMessage));
  });

  app.addHook("onClose", async () => {
    await subscriber.quit();
  });
}
