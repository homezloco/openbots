import type { AgentGraph, RoutingEdge } from "@openbots/graph-schema";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export async function fetchGraph(graphId: string): Promise<AgentGraph> {
  const res = await fetch(`${API_URL}/graphs/${graphId}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch graph ${graphId}`);
  return res.json();
}

/** Called when a drag-and-drop reconnects an edge to a new target node. */
export async function rerouteEdge(
  graphId: string,
  edgeId: string,
  targetNodeId: string,
): Promise<RoutingEdge> {
  const res = await fetch(`${API_URL}/graphs/${graphId}/edges/${edgeId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetNodeId }),
  });
  if (!res.ok) throw new Error(`Failed to reroute edge ${edgeId}`);
  return res.json();
}

export function runEventsSocketUrl(): string {
  return `${API_URL.replace(/^http/, "ws")}/ws/runs`;
}
