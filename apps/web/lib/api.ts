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

/** The README GIF as a real graph (Router → Support, Billing as the drop target). */
export const createLiveRerouteExample = () =>
  request<AgentGraph>("/graphs/examples/live-reroute", { method: "POST" });

/** Nested org: Acme Portfolio + Payments + Platform. Returns the portfolio graph. */
export const createAgencyExample = () => request<AgentGraph>("/graphs/examples/agency", { method: "POST" });

export const deleteGraph = (graphId: string) => request<void>(`/graphs/${graphId}`, { method: "DELETE" });

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
  /** Most recent run's createdAt across this graph, or null if it's never been run. Distinct from updatedAt (last structural edit). */
  lastRunAt: string | null;
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
  consensusGroup?: AgentNode["consensusGroup"] | null;
  dispatchTargets?: string[];
  sshTarget?: AgentNode["sshTarget"];
  mcpServers?: AgentNode["mcpServers"] | null;
  position: { x: number; y: number };
}

export const createNode = (graphId: string, body: CreateNodeInput) =>
  request<AgentNode>(`/graphs/${graphId}/nodes`, { method: "POST", body: JSON.stringify(body) });

export const updateNode = (graphId: string, nodeId: string, body: Partial<CreateNodeInput>) =>
  request<AgentNode>(`/graphs/${graphId}/nodes/${nodeId}`, { method: "PATCH", body: JSON.stringify(body) });

export const deleteNode = (graphId: string, nodeId: string) =>
  request<void>(`/graphs/${graphId}/nodes/${nodeId}`, { method: "DELETE" });

export const listAllAgents = () => request<(AgentNode & { graphName: string })[]>("/agents");

export const createNodeFromExisting = (
  graphId: string,
  body: { sourceNodeId: string; position: { x: number; y: number } },
) => request<AgentNode>(`/graphs/${graphId}/nodes/from-existing`, { method: "POST", body: JSON.stringify(body) });

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

// --- User credentials (account-scoped, e.g. the GitHub token /push uses) ---

export interface UserCredentialSummary {
  id: string;
  provider: string;
  label: string;
  createdAt: string;
}

export const listUserCredentials = () => request<UserCredentialSummary[]>("/me/credentials");

export const createUserCredential = (body: { provider: string; apiKey: string; label?: string }) =>
  request<UserCredentialSummary>("/me/credentials", { method: "POST", body: JSON.stringify(body) });

export const deleteUserCredential = (id: string) => request<void>(`/me/credentials/${id}`, { method: "DELETE" });

export interface DiscoveredMcpTool {
  name: string;
  description: string;
}

export const discoverMcp = (body: { url: string; credentialProvider?: string }) =>
  request<{ name: string; tools: DiscoveredMcpTool[] }>("/mcp/discover", {
    method: "POST",
    body: JSON.stringify(body),
  });

// --- Scheduled triggers (run a graph on a recurring cron schedule) ---

export interface ScheduledTrigger {
  id: string;
  graphId: string;
  name: string;
  input: unknown;
  cronExpression: string;
  mode: "pinned" | "live";
  enabled: boolean;
  lastRunId: string | null;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const listSchedules = (graphId: string) => request<ScheduledTrigger[]>(`/graphs/${graphId}/schedules`);

export interface ScheduleRunSummary {
  id: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
}

export const listScheduleRuns = (graphId: string, scheduleId: string) =>
  request<ScheduleRunSummary[]>(`/graphs/${graphId}/schedules/${scheduleId}/runs`);

export const createSchedule = (
  graphId: string,
  body: { name: string; input: unknown; cronExpression: string; mode?: "pinned" | "live"; enabled?: boolean },
) => request<ScheduledTrigger>(`/graphs/${graphId}/schedules`, { method: "POST", body: JSON.stringify(body) });

export const updateSchedule = (graphId: string, id: string, body: Partial<Pick<ScheduledTrigger, "name" | "input" | "cronExpression" | "mode" | "enabled">>) =>
  request<ScheduledTrigger>(`/graphs/${graphId}/schedules/${id}`, { method: "PATCH", body: JSON.stringify(body) });

export const deleteSchedule = (graphId: string, id: string) =>
  request<void>(`/graphs/${graphId}/schedules/${id}`, { method: "DELETE" });

// --- Agent commits (writes made via write_file/edit_file, pushed with /push) ---

export interface AgentCommitSummary {
  id: string;
  runId: string;
  nodeId: string;
  nodeName: string;
  branch: string;
  commitSha: string;
  pushedAt: string | null;
  createdAt: string;
}

export const listCommits = (graphId: string) => request<AgentCommitSummary[]>(`/graphs/${graphId}/commits`);

export const getCommitDiff = (graphId: string, commitId: string) =>
  request<{ diff: string; truncated: boolean }>(`/graphs/${graphId}/commits/${commitId}/diff`);

export interface PrStatus {
  commitId: string;
  branch: string;
  repo: string | null;
  pr: { number: number; url: string; state: string; title: string } | null;
  tokenConfigured: boolean;
}

export const getPrStatus = (graphId: string) => request<PrStatus[]>(`/graphs/${graphId}/pr-status`);

export const openPrForCommit = (graphId: string, commitId: string, title?: string) =>
  request<{ message: string }>(`/graphs/${graphId}/commits/${commitId}/pr`, {
    method: "POST",
    body: JSON.stringify({ title }),
  });

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
  forkedFromRunId?: string | null;
  forkedFromSequence?: number | null;
  /**
   * Only present on listRuns() results. `input` is a scratch field the
   * engine overwrites on every hop transition, so for a multi-hop run it
   * no longer holds what the user actually asked by the time the run
   * completes — this is the true original input (from run_events
   * sequence 0), which is what conversation-memory chaining and the chat
   * transcript should read instead.
   */
  originalInput?: unknown;
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

export const forkRun = (graphId: string, runId: string, fromSequence: number, mode?: "pinned" | "live") =>
  request<Run>(`/graphs/${graphId}/runs/${runId}/fork`, {
    method: "POST",
    body: JSON.stringify({ fromSequence, ...(mode ? { mode } : {}) }),
  });

export interface AgentConversation {
  runId: string;
  status: string;
  startedAt: string;
  isDirect: boolean;
  events: RunEventRow[];
}

export const fetchAgentConversations = (graphId: string, nodeId: string) =>
  request<{ nodes: { id: string; name: string }[]; runs: AgentConversation[] }>(
    `/graphs/${graphId}/nodes/${nodeId}/conversations`,
    { cache: "no-store" },
  );

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

export interface RunEventMessage {
  runId: string;
  graphId: string;
  type: "hop_dispatched" | "hop_succeeded" | "hop_failed" | "run_completed";
  nodeId?: string;
  resolvedEdgeId?: string | null;
  payload?: unknown;
}

export function runEventsSocketUrl(graphId: string): string {
  return `${API_URL.replace(/^http/, "ws")}/ws/graphs/${graphId}/runs`;
}
