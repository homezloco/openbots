"use client";

import { useEffect, useState } from "react";
import type { AgentGraph, AgentNode, ProviderId } from "@openbots/graph-schema";
import {
  deleteNode,
  discoverMcp,
  getMcpRegistryServerUrl,
  listGraphs,
  listUserCredentials,
  searchMcpRegistry,
  updateNode,
  type DiscoveredMcpTool,
  type GraphSummary,
  type McpRegistryServer,
  type UserCredentialSummary,
} from "../lib/api";
import { PROVIDERS, ROLES } from "./HierarchyCanvas";

const TIERS: AgentNode["tier"][] = [undefined, "economy", "standard", "flagship"];
const FILE_TOOLS = ["read_file", "list_directory", "search_knowledge"];
const WRITE_TOOLS = ["write_file", "edit_file"];
const DISPATCH_TOOL = "dispatch_to_graph";
const MANAGE_TOOL = "manage_target_graphs";
const REMOTE_TOOL = "run_remote_command";
const RUN_CODE_TOOL = "run_code";
const MCP_TOOL = "mcp";

interface McpServerDraft {
  slug: string;
  url: string;
  allowedTools: string[];
  credentialProvider: string;
  // "" = unset (Authorization: Bearer <token>, the default). Set = the
  // raw token is sent under this header name instead, no Bearer prefix.
  headerName: string;
  discovered: DiscoveredMcpTool[];
  discovering: boolean;
  discoverError: string | null;
}

function toDraft(server: {
  slug: string;
  url: string;
  allowedTools?: string[];
  credentialProvider?: string;
  headerName?: string | null;
}): McpServerDraft {
  return {
    slug: server.slug,
    url: server.url,
    allowedTools: server.allowedTools ?? [],
    credentialProvider: server.credentialProvider ?? "",
    headerName: server.headerName ?? "",
    discovered: (server.allowedTools ?? []).map((name) => ({ name, description: "" })),
    discovering: false,
    discoverError: null,
  };
}

/**
 * Editing an existing agent's config — reuses the same field set as the
 * manual Add-agent form (HierarchyCanvas.tsx), just backed by PATCH
 * instead of POST. fileAccessRoot still drives the read_file/list_directory
 * tool pair, but non-file tools (e.g. pc_telemetry, calculator) already on
 * the node are preserved rather than being silently overwritten.
 */
export function AgentSettingsForm({
  graphId,
  graph,
  node,
  onSaved,
  onCancel,
  onDeleted,
}: {
  graphId: string;
  graph: AgentGraph;
  node: AgentNode;
  onSaved: (updated: AgentNode) => void;
  onCancel: () => void;
  onDeleted?: () => void;
}) {
  const [form, setForm] = useState({
    name: node.name,
    role: node.role,
    provider: node.provider,
    model: node.model,
    tier: node.tier,
    description: node.description,
    systemPrompt: node.systemPrompt,
    fileAccessRoot: node.fileAccessRoot ?? "",
    // Existing nodes keep whatever they have; a node with no file root yet defaults to writes-on once a root is set.
    allowWrites: node.fileAccessRoot ? node.tools.some((t) => WRITE_TOOLS.includes(t)) : true,
  });
  const [fallbackChain, setFallbackChain] = useState(node.fallbackChain);
  const [dispatchEnabled, setDispatchEnabled] = useState(node.tools.includes(DISPATCH_TOOL));
  const [manageEnabled, setManageEnabled] = useState(node.tools.includes(MANAGE_TOOL));
  const [dispatchTargets, setDispatchTargets] = useState<string[]>(node.dispatchTargets ?? []);
  const [availableGraphs, setAvailableGraphs] = useState<GraphSummary[] | null>(null);
  const [remoteCommandEnabled, setRemoteCommandEnabled] = useState(node.tools.includes(REMOTE_TOOL));
  const [sshHost, setSshHost] = useState(node.sshTarget?.host ?? "");
  const [sshUsername, setSshUsername] = useState(node.sshTarget?.username ?? "");
  const [allowedCommands, setAllowedCommands] = useState(node.sshTarget?.allowedCommands ?? []);
  const [runCodeEnabled, setRunCodeEnabled] = useState(node.tools.includes(RUN_CODE_TOOL));
  const [mcpEnabled, setMcpEnabled] = useState(node.tools.includes(MCP_TOOL));
  const [mcpServers, setMcpServers] = useState<McpServerDraft[]>(
    (node.mcpServers ?? []).length > 0 ? (node.mcpServers ?? []).map(toDraft) : [toDraft({ slug: "", url: "", allowedTools: [] })],
  );
  const [userCreds, setUserCreds] = useState<UserCredentialSummary[] | null>(null);
  // "Browse MCP servers" picker — deliberately kept separate from
  // McpServerDraft/mcpServers: this is transient UI state that has no
  // business flowing through toDraft()/save()'s PATCH payload.
  const [pickerOpenIndex, setPickerOpenIndex] = useState<number | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerResults, setPickerResults] = useState<McpRegistryServer[]>([]);
  const [pickerConfigured, setPickerConfigured] = useState(true);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [pickerPicking, setPickerPicking] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvalEnabled, setApprovalEnabled] = useState(Boolean(node.approvalConfig));
  const [approvalInstructions, setApprovalInstructions] = useState(node.approvalConfig?.instructions ?? "");
  const [approvalWebhookUrl, setApprovalWebhookUrl] = useState(node.approvalConfig?.notifyWebhookUrl ?? "");
  const outgoing = graph.edges.filter((e) => e.sourceNodeId === node.id);
  const [fanoutEnabled, setFanoutEnabled] = useState(Boolean(node.consensusGroup));
  const [aggregatorId, setAggregatorId] = useState(node.consensusGroup?.aggregatorNodeId ?? "");
  const [fanoutEdgeIds, setFanoutEdgeIds] = useState<string[]>(
    node.consensusGroup?.edgeIds ?? outgoing.filter((e) => e.kind === "auto").map((e) => e.id),
  );

  useEffect(() => {
    listGraphs()
      .then((graphs) => setAvailableGraphs(graphs.filter((g) => g.id !== graphId)))
      .catch(() => setAvailableGraphs([]));
  }, [graphId]);

  useEffect(() => {
    listUserCredentials()
      .then(setUserCreds)
      .catch(() => setUserCreds([]));
  }, []);

  function toggleDispatchTarget(id: string) {
    setDispatchTargets((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));
  }

  function addCommandRow() {
    setAllowedCommands((prev) => [...prev, { label: "", command: "" }]);
  }

  function patchMcpServer(index: number, patch: Partial<McpServerDraft>) {
    setMcpServers((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  async function discoverRow(index: number) {
    const row = mcpServers[index];
    if (!row?.url.trim()) {
      patchMcpServer(index, { discoverError: "Enter a URL first." });
      return;
    }
    patchMcpServer(index, { discovering: true, discoverError: null });
    try {
      const result = await discoverMcp({
        url: row.url.trim(),
        ...(row.credentialProvider.trim() ? { credentialProvider: row.credentialProvider.trim() } : {}),
        ...(row.headerName.trim() ? { headerName: row.headerName.trim() } : {}),
      });
      const known = new Set(result.tools.map((t) => t.name));
      patchMcpServer(index, {
        discovering: false,
        discovered: result.tools,
        allowedTools: row.allowedTools.filter((n) => known.has(n)),
        discoverError: null,
      });
    } catch (err) {
      patchMcpServer(index, {
        discovering: false,
        discoverError: err instanceof Error ? err.message : "Discover failed",
      });
    }
  }

  useEffect(() => {
    if (pickerOpenIndex === null || pickerQuery.trim().length < 2) {
      setPickerResults([]);
      setPickerLoading(false);
      return;
    }
    const controller = new AbortController();
    setPickerLoading(true);
    setPickerError(null);
    const timer = setTimeout(() => {
      searchMcpRegistry(pickerQuery.trim(), 1, 10, false, controller.signal)
        .then((result) => {
          setPickerConfigured(result.configured);
          setPickerResults(result.servers);
          setPickerLoading(false);
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setPickerError(err instanceof Error ? err.message : "Search failed");
          setPickerLoading(false);
        });
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [pickerQuery, pickerOpenIndex]);

  /** Everything after the last "/" in qualifiedName, sanitized to this schema's slug shape, de-duped against sibling rows. */
  function deriveSlug(qualifiedName: string, index: number): string {
    const base =
      qualifiedName
        .split("/")
        .pop()
        ?.toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32) || "mcp";
    const taken = new Set(mcpServers.filter((_, i) => i !== index).map((s) => s.slug));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base.slice(0, 32 - String(n).length - 1)}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  async function pickServer(index: number, server: McpRegistryServer) {
    setPickerPicking(server.qualifiedName);
    setPickerError(null);
    try {
      const { url } = await getMcpRegistryServerUrl(server.qualifiedName);
      const slug = deriveSlug(server.qualifiedName, index);
      // Discover using the just-fetched `url` directly, not by calling
      // discoverRow(index) — that function reads mcpServers[index] from
      // its own closure, which would still see the pre-patch (stale)
      // row here since the patchMcpServer state update hasn't been
      // applied/re-rendered yet by the time this line runs.
      const credentialProvider = mcpServers[index]?.credentialProvider.trim() || undefined;
      const headerName = mcpServers[index]?.headerName.trim() || undefined;
      patchMcpServer(index, { slug, url, discovering: true, discoverError: null });
      setPickerOpenIndex(null);
      setPickerQuery("");
      try {
        const result = await discoverMcp({ url, ...(credentialProvider ? { credentialProvider } : {}), ...(headerName ? { headerName } : {}) });
        patchMcpServer(index, { discovering: false, discovered: result.tools, allowedTools: [], discoverError: null });
      } catch (discoverErr) {
        patchMcpServer(index, {
          discovering: false,
          discoverError: discoverErr instanceof Error ? discoverErr.message : "Discover failed",
        });
      }
    } catch (err) {
      setPickerError(err instanceof Error ? err.message : "Could not resolve a connection URL for this server");
    } finally {
      setPickerPicking(null);
    }
  }

  async function save() {
    if ((dispatchEnabled || manageEnabled) && dispatchTargets.length === 0) {
      setError("Pick at least one target graph, or turn off dispatch/graph-editing.");
      return;
    }
    if (remoteCommandEnabled && (!sshHost.trim() || !sshUsername.trim() || allowedCommands.length === 0)) {
      setError("Fill in a host, username, and at least one command, or turn off remote commands.");
      return;
    }
    if (fanoutEnabled && (!aggregatorId || fanoutEdgeIds.length === 0)) {
      setError("ALL fan-out needs an aggregator node and at least one outgoing edge.");
      return;
    }
    if (mcpEnabled) {
      const filled = mcpServers.filter((s) => s.slug.trim() && s.url.trim());
      if (filled.length === 0) {
        setError("Add at least one MCP server (slug + URL), or turn off MCP servers.");
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      const nonFileTools = node.tools.filter(
        (t) =>
          !FILE_TOOLS.includes(t) &&
          !WRITE_TOOLS.includes(t) &&
          t !== DISPATCH_TOOL &&
          t !== MANAGE_TOOL &&
          t !== REMOTE_TOOL &&
          t !== RUN_CODE_TOOL &&
          t !== MCP_TOOL,
      );
      const tools = [
        ...nonFileTools,
        ...(form.fileAccessRoot ? [...FILE_TOOLS, ...(form.allowWrites ? WRITE_TOOLS : [])] : []),
        ...(dispatchEnabled ? [DISPATCH_TOOL] : []),
        ...(manageEnabled ? [MANAGE_TOOL] : []),
        ...(remoteCommandEnabled ? [REMOTE_TOOL] : []),
        ...(runCodeEnabled ? [RUN_CODE_TOOL] : []),
        ...(mcpEnabled ? [MCP_TOOL] : []),
      ];
      const updated = await updateNode(graphId, node.id, {
        name: form.name,
        role: form.role,
        provider: form.provider,
        model: form.model,
        tier: form.tier,
        description: form.description,
        systemPrompt: form.systemPrompt,
        fileAccessRoot: form.fileAccessRoot || undefined,
        tools,
        fallbackChain,
        // Sent as [] (not omitted) when disabled, since omitting a field
        // leaves the PATCH route's previous value untouched — see the PATCH
        // handler's `effectiveDispatchTargets` merge in routes/graphs.ts.
        dispatchTargets: dispatchEnabled || manageEnabled ? dispatchTargets : [],
        // Sent as null (not omitted) when disabled, same reasoning.
        sshTarget: remoteCommandEnabled
          ? { host: sshHost.trim(), username: sshUsername.trim(), allowedCommands }
          : null,
        mcpServers: mcpEnabled
          ? mcpServers
              .filter((s) => s.slug.trim() && s.url.trim())
              .map((s) => ({
                slug: s.slug.trim(),
                url: s.url.trim(),
                allowedTools: s.allowedTools,
                ...(s.credentialProvider.trim() ? { credentialProvider: s.credentialProvider.trim() } : {}),
                ...(s.headerName.trim() ? { headerName: s.headerName.trim() } : {}),
              }))
          : [],
        consensusGroup: fanoutEnabled ? { aggregatorNodeId: aggregatorId, edgeIds: fanoutEdgeIds } : null,
        approvalConfig: approvalEnabled
          ? {
              instructions: approvalInstructions.trim() || undefined,
              notifyWebhookUrl: approvalWebhookUrl.trim() || undefined,
            }
          : null,
      });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12 }}>
      {error && <p style={{ color: "var(--danger)", margin: 0 }}>{error}</p>}

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        Name
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </label>

      <div style={{ display: "flex", gap: 8 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
          Role
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as AgentNode["role"] })}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
          Tier
          <select
            value={form.tier ?? ""}
            onChange={(e) => setForm({ ...form, tier: (e.target.value || undefined) as AgentNode["tier"] })}
          >
            {TIERS.map((t) => (
              <option key={t ?? "none"} value={t ?? ""}>
                {t ?? "(none)"}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
          Provider
          <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value as ProviderId })}>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
          Model
          <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
        </label>
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        Description <span style={{ color: "var(--text-faint)", fontSize: 12 }}>(used for auto-routing — keep in sync with what this agent actually does)</span>
        <textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        System prompt
        <textarea rows={6} value={form.systemPrompt} onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })} />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        File access root <span style={{ color: "var(--text-faint)", fontSize: 12 }}>(absolute path, subject to the operator allowlist)</span>
        <input value={form.fileAccessRoot} onChange={(e) => setForm({ ...form, fileAccessRoot: e.target.value })} />
      </label>

      <label style={{ display: "flex", gap: 8, alignItems: "center", opacity: form.fileAccessRoot ? 1 : 0.5 }}>
        <input
          type="checkbox"
          checked={form.allowWrites}
          disabled={!form.fileAccessRoot}
          onChange={(e) => setForm({ ...form, allowWrites: e.target.checked })}
        />
        <span>
          Allow file writes{" "}
          <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
            (write_file/edit_file — root must be a git repo in ALLOWED_FILE_WRITE_ROOTS; changes land on an isolated openbots/* branch, push with /push)
          </span>
        </span>
      </label>

      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={approvalEnabled} onChange={(e) => setApprovalEnabled(e.target.checked)} />
        <span>
          🔒 Require human approval before this node runs{" "}
          <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
            (pauses the run here until someone approves — optionally editing the input first — or cancels it; use
            this on a node whose only job is to send something real, like an email or an outbound API call)
          </span>
        </span>
      </label>

      {approvalEnabled && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginLeft: 24 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            Reviewer instructions <span style={{ color: "var(--text-faint)", fontSize: 12 }}>(shown to whoever approves — explain what to check)</span>
            <textarea
              rows={2}
              placeholder="e.g. Check the recipient and tone before this goes out."
              value={approvalInstructions}
              onChange={(e) => setApprovalInstructions(e.target.value)}
            />
          </label>
          <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
            Can&apos;t be combined with being a map or consensus branch target — those fan out inline with no point
            to pause at. Gating the aggregator itself is fine.
          </span>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            Notify a webhook when this gate trips{" "}
            <span style={{ color: "var(--text-faint)", fontSize: 12 }}>(optional — otherwise this is only visible on the canvas or the runs list)</span>
            <input
              placeholder="https://hooks.slack.com/services/…"
              value={approvalWebhookUrl}
              onChange={(e) => setApprovalWebhookUrl(e.target.value)}
            />
            <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
              URL must be within an operator-configured prefix (ALLOWED_NOTIFICATION_WEBHOOKS) — delivery is
              best-effort and never affects the run either way.
            </span>
          </label>
        </div>
      )}

      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={dispatchEnabled} onChange={(e) => setDispatchEnabled(e.target.checked)} />
        <span>
          Allow dispatch to other graphs{" "}
          <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
            (dispatch_to_graph — starts a run in a graph below and waits for its real result, bounded by a timeout; check_dispatch_status covers the rare case it times out)
          </span>
        </span>
      </label>

      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={manageEnabled} onChange={(e) => setManageEnabled(e.target.checked)} />
        <span>
          Allow full editing of dispatch-target graphs{" "}
          <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
            (create/update/delete agents and routing edges in a graph below — held to the same file-access/dispatch
            rules a human editing it directly would be; never grants dispatchTargets or consensusGroup itself)
          </span>
        </span>
      </label>

      {(dispatchEnabled || manageEnabled) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginLeft: 24 }}>
          {availableGraphs === null && <span style={{ color: "var(--text-faint)", fontSize: 13 }}>Loading your graphs…</span>}
          {availableGraphs?.length === 0 && (
            <span style={{ color: "var(--text-faint)", fontSize: 13 }}>You have no other graphs to dispatch into yet.</span>
          )}
          {availableGraphs && availableGraphs.length > 0 && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                maxHeight: 160,
                overflowY: "auto",
                border: "1px solid var(--border)",
                borderRadius: 4,
                padding: 8,
              }}
            >
              {availableGraphs.map((g) => (
                <label key={g.id} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={dispatchTargets.includes(g.id)}
                    onChange={() => toggleDispatchTarget(g.id)}
                  />
                  <span>{g.name}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="checkbox"
          checked={remoteCommandEnabled}
          onChange={(e) => setRemoteCommandEnabled(e.target.checked)}
        />
        <span>
          Allow remote commands{" "}
          <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
            (run_remote_command — can only run one of the exact commands you list below, over SSH, on the host you
            configure; host must be in the operator&apos;s ALLOWED_SSH_HOSTS allowlist)
          </span>
        </span>
      </label>

      {remoteCommandEnabled && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginLeft: 24 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
              Host
              <input placeholder="100.66.221.81" value={sshHost} onChange={(e) => setSshHost(e.target.value)} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
              Username
              <input placeholder="ubuntu" value={sshUsername} onChange={(e) => setSshUsername(e.target.value)} />
            </label>
          </div>
          <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
            Optional SSH key credential comes from /me/credentials, provider &quot;ssh_target_&lt;host&gt;&quot; — leave unset if
            this host authenticates without one (e.g. Tailscale SSH).
          </span>
          {allowedCommands.map((c, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                placeholder="label (e.g. trading_report)"
                value={c.label}
                onChange={(e) => {
                  const next = [...allowedCommands];
                  next[i] = { ...next[i], label: e.target.value };
                  setAllowedCommands(next);
                }}
                style={{ flex: 1 }}
              />
              <input
                placeholder="exact command"
                value={c.command}
                onChange={(e) => {
                  const next = [...allowedCommands];
                  next[i] = { ...next[i], command: e.target.value };
                  setAllowedCommands(next);
                }}
                style={{ flex: 2 }}
              />
              <button type="button" onClick={() => setAllowedCommands(allowedCommands.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
          <button type="button" onClick={addCommandRow} style={{ alignSelf: "flex-start" }}>
            + Add command
          </button>
        </div>
      )}

      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={runCodeEnabled} onChange={(e) => setRunCodeEnabled(e.target.checked)} />
        <span>
          Allow code execution{" "}
          <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
            (run_code — runs short Python/JavaScript in an isolated sandbox with no network access; requires the operator to
            have enabled a sandbox backend and, unless self-hosted, your own API key at /settings)
          </span>
        </span>
      </label>

      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={mcpEnabled} onChange={(e) => setMcpEnabled(e.target.checked)} />
        <span>
          MCP servers{" "}
          <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
            (call tools on remote Streamable HTTP MCP servers — URL must be in ALLOWED_MCP_SERVERS; empty allowed-tools
            means zero tools, not all of them)
          </span>
        </span>
      </label>

      {mcpEnabled && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginLeft: 24 }}>
          {mcpServers.map((server, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                border: "1px solid var(--border)",
                borderRadius: 4,
                padding: 8,
              }}
            >
              <div style={{ display: "flex", gap: 8 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
                  Slug
                  <input
                    placeholder="github"
                    value={server.slug}
                    onChange={(e) => patchMcpServer(i, { slug: e.target.value })}
                  />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 2 }}>
                  URL
                  <input
                    placeholder="https://mcp.example/mcp"
                    value={server.url}
                    onChange={(e) => patchMcpServer(i, { url: e.target.value })}
                  />
                </label>
              </div>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                Credential (optional bearer from /settings)
                <select
                  value={server.credentialProvider}
                  onChange={(e) => patchMcpServer(i, { credentialProvider: e.target.value })}
                >
                  <option value="">(none)</option>
                  {(userCreds ?? []).map((c) => (
                    <option key={c.id} value={c.provider}>
                      {c.provider}
                      {c.label ? ` — ${c.label}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                Header name (optional)
                <input
                  placeholder="Authorization (default)"
                  value={server.headerName}
                  onChange={(e) => patchMcpServer(i, { headerName: e.target.value })}
                />
                <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
                  Leave blank to send <code>Authorization: Bearer &lt;token&gt;</code>. Set this for servers that
                  expect a custom header instead (e.g. <code>X-API-Key</code>) — the raw token is sent under this
                  name with no &quot;Bearer &quot; prefix.
                </span>
              </label>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button type="button" onClick={() => void discoverRow(i)} disabled={server.discovering}>
                  {server.discovering ? "Discovering…" : "Discover tools"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPickerOpenIndex(pickerOpenIndex === i ? null : i);
                    setPickerQuery("");
                    setPickerResults([]);
                    setPickerError(null);
                  }}
                >
                  {pickerOpenIndex === i ? "Close browser" : "Browse MCP servers (Smithery)"}
                </button>
                <button
                  type="button"
                  onClick={() => setMcpServers((prev) => prev.filter((_, j) => j !== i))}
                  disabled={mcpServers.length === 1}
                >
                  Remove server
                </button>
              </div>
              {pickerOpenIndex === i && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, border: "1px solid var(--border)", borderRadius: 4, padding: 8 }}>
                  <p style={{ margin: 0, fontSize: 12, color: "var(--text-faint)" }}>
                    Listings come from Smithery, a third-party directory. &quot;Verified&quot; confirms who published a
                    server, not that its code is safe — review a server before allowlisting it. Picking one here
                    never grants access by itself; it still has to be added to ALLOWED_MCP_SERVERS.
                  </p>
                  {!pickerConfigured ? (
                    <p style={{ margin: 0, fontSize: 13, color: "var(--text-faint)" }}>
                      Server browsing isn&apos;t configured — ask your operator to set SMITHERY_API_KEY.
                    </p>
                  ) : (
                    <>
                      <input
                        placeholder="Search MCP servers…"
                        value={pickerQuery}
                        onChange={(e) => setPickerQuery(e.target.value)}
                        autoFocus
                      />
                      {pickerLoading && <span style={{ fontSize: 12, color: "var(--text-faint)" }}>Searching…</span>}
                      {pickerError && <p style={{ color: "var(--danger)", margin: 0, fontSize: 13 }}>{pickerError}</p>}
                      {pickerResults.length > 0 && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 240, overflowY: "auto" }}>
                          {pickerResults.map((result) => (
                            <button
                              key={result.qualifiedName}
                              type="button"
                              onClick={() => void pickServer(i, result)}
                              disabled={pickerPicking === result.qualifiedName}
                              style={{ textAlign: "left", display: "flex", flexDirection: "column", gap: 2, padding: 8 }}
                            >
                              <span>
                                <strong>{result.displayName}</strong>{" "}
                                {result.verified && <span style={{ fontSize: 11, color: "var(--text-faint)" }}>· verified publisher</span>}
                                {pickerPicking === result.qualifiedName && <span style={{ fontSize: 11 }}> · resolving…</span>}
                              </span>
                              <span style={{ fontSize: 12, color: "var(--text-faint)" }}>{result.description}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
              {server.discoverError && <p style={{ color: "var(--danger)", margin: 0, fontSize: 13 }}>{server.discoverError}</p>}
              {server.discovered.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ color: "var(--text-faint)", fontSize: 12 }}>Grant only the tools this node may call:</span>
                  {server.discovered.map((tool) => (
                    <label key={tool.name} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={server.allowedTools.includes(tool.name)}
                        onChange={() => {
                          const on = server.allowedTools.includes(tool.name);
                          patchMcpServer(i, {
                            allowedTools: on
                              ? server.allowedTools.filter((n) => n !== tool.name)
                              : [...server.allowedTools, tool.name],
                          });
                        }}
                      />
                      <span>
                        <code>{tool.name}</code>
                        {tool.description ? (
                          <span style={{ color: "var(--text-faint)" }}> — {tool.description}</span>
                        ) : null}
                      </span>
                    </label>
                  ))}
                </div>
              )}
              {server.discovered.length === 0 && server.allowedTools.length > 0 && (
                <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
                  Granted: {server.allowedTools.join(", ")} — Discover to refresh the checklist.
                </span>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              setMcpServers((prev) => [...prev, toDraft({ slug: "", url: "", allowedTools: [] })])
            }
            style={{ alignSelf: "flex-start" }}
          >
            + Add MCP server
          </button>
        </div>
      )}

      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="checkbox"
          checked={fanoutEnabled}
          onChange={(e) => {
            const on = e.target.checked;
            setFanoutEnabled(on);
            if (on && fanoutEdgeIds.length === 0) {
              setFanoutEdgeIds(outgoing.filter((edge) => edge.kind === "auto").map((edge) => edge.id));
            }
          }}
        />
        <span>
          Fan out with ALL{" "}
          <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
            (hybrid: normal auto routing unless the model starts its reply with ALL, then every selected edge runs and
            the aggregator joins)
          </span>
        </span>
      </label>

      {fanoutEnabled && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginLeft: 24 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            Aggregator
            <select value={aggregatorId} onChange={(e) => setAggregatorId(e.target.value)}>
              <option value="">Select…</option>
              {graph.nodes
                .filter((n) => n.id !== node.id)
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                  </option>
                ))}
            </select>
          </label>
          {outgoing.length === 0 ? (
            <span style={{ color: "var(--text-faint)", fontSize: 13 }}>
              Draw outgoing edges from this node first (use New edges: auto for specialists).
            </span>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Edges included in ALL</span>
              {outgoing.map((edge) => {
                const target = graph.nodes.find((n) => n.id === edge.targetNodeId);
                return (
                  <label key={edge.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={fanoutEdgeIds.includes(edge.id)}
                      onChange={() =>
                        setFanoutEdgeIds((ids) =>
                          ids.includes(edge.id) ? ids.filter((id) => id !== edge.id) : [...ids, edge.id],
                        )
                      }
                    />
                    <span>
                      {target?.name ?? edge.targetNodeId}{" "}
                      <span style={{ color: "var(--text-faint)" }}>({edge.kind})</span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}

      <button type="button" onClick={() => setShowAdvanced((s) => !s)} style={{ alignSelf: "flex-start" }}>
        {showAdvanced ? "Hide" : "Show"} advanced (fallback chain)
      </button>

      {showAdvanced && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {fallbackChain.map((f, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <select
                value={f.provider}
                onChange={(e) => {
                  const next = [...fallbackChain];
                  next[i] = { ...next[i], provider: e.target.value as ProviderId };
                  setFallbackChain(next);
                }}
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <input
                placeholder="model"
                value={f.model}
                onChange={(e) => {
                  const next = [...fallbackChain];
                  next[i] = { ...next[i], model: e.target.value };
                  setFallbackChain(next);
                }}
                style={{ flex: 1 }}
              />
              <button type="button" onClick={() => setFallbackChain(fallbackChain.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setFallbackChain([...fallbackChain, { provider: "anthropic", model: "" }])}
            style={{ alignSelf: "flex-start" }}
          >
            + Add fallback
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
        <button onClick={save} disabled={saving || deleting}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} disabled={saving || deleting}>
          Cancel
        </button>
        {onDeleted && (
          <button
            type="button"
            disabled={saving || deleting}
            onClick={async () => {
              if (!window.confirm(`Delete ${node.name}? Connected edges will be removed.`)) return;
              setDeleting(true);
              setError(null);
              try {
                await deleteNode(graphId, node.id);
                onDeleted();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Failed to delete");
                setDeleting(false);
              }
            }}
            style={{ marginLeft: "auto", color: "var(--danger)", background: "transparent", border: "1px solid var(--border)" }}
          >
            {deleting ? "Deleting…" : "Delete agent"}
          </button>
        )}
      </div>
    </div>
  );
}
