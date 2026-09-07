import type { AgentGraph, AgentNode, ProviderId, RoutingEdge } from "@openbots/graph-schema";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only set Content-Type when there's actually a body — Fastify's JSON
  // body parser rejects a request that declares application/json but
  // sends nothing (e.g. a bodyless POST like instantiateTemplate), with
  // FST_ERR_CTP_EMPTY_JSON_BODY. Caught by the e2e suite; see PLAN.md.
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (init?.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request to ${path} failed with ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// --- Auth ---

export interface PublicUser {
  id: string;
  email: string;
  createdAt: string;
}

export const signup = (email: string, password: string) =>
  request<PublicUser>("/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) });

export const login = (email: string, password: string) =>
  request<PublicUser>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });

export const logout = () => request<void>("/auth/logout", { method: "POST" });

export const getMe = () => request<PublicUser>("/auth/me");

// --- Graphs ---

export const createGraph = (name: string, description?: string) =>
  request<AgentGraph>("/graphs", { method: "POST", body: JSON.stringify({ name, description }) });

export const fetchGraph = (graphId: string) =>
  request<AgentGraph>(`/graphs/${graphId}`, { cache: "no-store" });

/**
 * Deliberately NOT `extends AgentGraph`: the roster endpoint returns raw
 * graph rows (no nodes/edges/warnings) plus a node count — listing every
 * graph's full node/edge set would be an N+1 query for no reason a list
 * view needs. Claiming the full AgentGraph shape here was the same "type
 * says more than the response has" bug that crashed the canvas on node
 * creation (see nodeRowToAgentNode server-side).
 */
export interface GraphSummary {
  id: string;
  name: string;
  description: string;
  ownerId: string | null;
  entryNodeId: string | null;
  version: number;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
}

/** The bot roster: every graph you own. */
export const listGraphs = () => request<GraphSummary[]>("/graphs", { cache: "no-store" });

export const quickAddAgent = (
  graphId: string,
  body: {
    description: string;
    provider?: ProviderId;
    model?: string;
    fileAccessRoot?: string;
    tools?: string[];
    position?: { x: number; y: number };
  },
) => request<AgentNode>(`/graphs/${graphId}/agents/quick-add`, { method: "POST", body: JSON.stringify(body) });

export const updateGraph = (graphId: string, body: Partial<Pick<AgentGraph, "name" | "description" | "entryNodeId">>) =>
  request<AgentGraph>(`/graphs/${graphId}`, { method: "PATCH", body: JSON.stringify(body) });

export interface CreateNodeInput {
  name: string;
  role: AgentNode["role"];
  provider: ProviderId;
  model: string;
  tier?: AgentNode["tier"];
  systemPrompt?: string;
  description?: string;
  tools?: string[];
  fileAccessRoot?: string;
  fallbackChain?: AgentNode["fallbackChain"];
  consensusGroup?: AgentNode["consensusGroup"];
  position: { x: number; y: number };
}

export const createNode = (graphId: string, body: CreateNodeInput) =>
  request<AgentNode>(`/graphs/${graphId}/nodes`, { method: "POST", body: JSON.stringify(body) });

export const createEdge = (
  graphId: string,
  body: { sourceNodeId: string; targetNodeId: string; kind?: RoutingEdge["kind"]; priority?: number },
) => request<RoutingEdge>(`/graphs/${graphId}/edges`, { method: "POST", body: JSON.stringify(body) });

/** Called when a drag-and-drop reconnects an edge to a new target node. */
export const rerouteEdge = (graphId: string, edgeId: string, targetNodeId: string) =>
  request<RoutingEdge>(`/graphs/${graphId}/edges/${edgeId}`, {
    method: "PATCH",
    body: JSON.stringify({ targetNodeId }),
  });

export const deleteEdge = (graphId: string, edgeId: string) =>
  request<void>(`/graphs/${graphId}/edges/${edgeId}`, { method: "DELETE" });

export const listRoutingChanges = (graphId: string) =>
  request<Record<string, unknown>[]>(`/graphs/${graphId}/routing-changes`);

// --- Credentials ---

export interface ProviderCredentialSummary {
  id: string;
  graphId: string;
  nodeId: string | null;
  provider: ProviderId;
  label: string;
  createdAt: string;
}

export const listCredentials = (graphId: string) =>
  request<ProviderCredentialSummary[]>(`/graphs/${graphId}/credentials`);

export const createCredential = (
  graphId: string,
  body: { provider: ProviderId; apiKey: string; label?: string; nodeId?: string },
) => request<ProviderCredentialSummary>(`/graphs/${graphId}/credentials`, { method: "POST", body: JSON.stringify(body) });

export const deleteCredential = (graphId: string, credentialId: string) =>
  request<void>(`/graphs/${graphId}/credentials/${credentialId}`, { method: "DELETE" });

// --- Runs ---

export interface Run {
  id: string;
  graphId: string;
  mode: "pinned" | "live";
  status: "pending" | "running" | "completed" | "error" | "cancelled";
  currentNodeId: string | null;
  input: unknown;
  output: unknown;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface RunEventRow {
  id: string;
  runId: string;
  nodeId: string;
  sequence: number;
  status: string;
  resolvedEdgeId: string | null;
  fanoutBatchId: string | null;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface UsageTotal {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export const createRun = (graphId: string, input: unknown, mode: "pinned" | "live" = "pinned") =>
  request<Run>("/runs", { method: "POST", body: JSON.stringify({ graphId, input, mode }) });

export const fetchRun = (runId: string) =>
  request<Run & { events: RunEventRow[]; usageTotal: UsageTotal }>(`/runs/${runId}`, { cache: "no-store" });

export const listRuns = (graphId: string) => request<Run[]>(`/graphs/${graphId}/runs`);

// --- Templates ---

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  authorId: string | null;
  createdAt: string;
  nodeCount: number;
}

export const listTemplates = () => request<TemplateSummary[]>("/templates");

export const createTemplate = (graphId: string, name: string, description?: string) =>
  request<TemplateSummary>("/templates", { method: "POST", body: JSON.stringify({ graphId, name, description }) });

export const instantiateTemplate = (templateId: string) =>
  request<AgentGraph>(`/templates/${templateId}/instantiate`, { method: "POST" });

// --- Chat playground ---

export const sendChatMessage = (provider: ProviderId, model: string, message: string, systemPrompt?: string) =>
  request<{ text: string }>("/chat", { method: "POST", body: JSON.stringify({ provider, model, message, systemPrompt }) });

export function runEventsSocketUrl(): string {
  return `${API_URL.replace(/^http/, "ws")}/ws/runs`;
}
