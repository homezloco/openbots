import { redisConnection } from "../queue/connection.js";

export const RUN_EVENTS_CHANNEL = "run-events";

export interface RunEventMessage {
  runId: string;
  graphId: string;
  type: "hop_dispatched" | "hop_succeeded" | "hop_failed" | "run_completed";
  nodeId?: string;
  resolvedEdgeId?: string | null;
  payload?: unknown;
}

/**
 * The API/worker publish here; src/ws/hub.ts subscribes on a separate
 * connection and fans out to connected canvas clients over WebSocket.
 * Redis pub/sub (not an in-process EventEmitter) so the API and worker can
 * scale as separate processes and still share one live feed.
 */
export function publishRunEvent(message: RunEventMessage) {
  return redisConnection.publish(RUN_EVENTS_CHANNEL, JSON.stringify(message));
}
