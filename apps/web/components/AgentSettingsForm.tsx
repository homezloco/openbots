"use client";

import { useEffect, useState } from "react";
import type { AgentGraph, AgentNode, ProviderId } from "@openbots/graph-schema";
import {
  deleteNode,
  discoverMcp,
  listGraphs,
  listUserCredentials,
  updateNode,
  type DiscoveredMcpTool,
  type GraphSummary,
  type UserCredentialSummary,
} from "../lib/api";
import { PROVIDERS, ROLES } from "./HierarchyCanvas";

const TIERS: AgentNode["tier"][] = [undefined, "economy", "standard", "flagship"];
const FILE_TOOLS = ["read_file", "list_directory", "search_knowledge"];
const WRITE_TOOLS = ["write_file", "edit_file"];
const DISPATCH_TOOL = "dispatch_to_graph";
const MANAGE_TOOL = "manage_target_graphs";
const REMOTE_TOOL = "run_remote_command";
const MCP_TOOL = "mcp";

interface McpServerDraft {
  slug: string;
  url: string;
  allowedTools: string[];
  credentialProvider: string;
  discovered: DiscoveredMcpTool[];
  discovering: boolean;
  discoverError: string | null;
}

function toDraft(server: { slug: string; url: string; allowedTools?: string[]; credentialProvider?: string }): McpServerDraft {
  return {
    slug: server.slug,
    url: server.url,
    allowedTools: server.allowedTools ?? [],
    credentialProvider: server.credentialProvider ?? "",
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
  const [mcpEnabled, setMcpEnabled] = useState(node.tools.includes(MCP_TOOL));
  const [mcpServers, setMcpServers] = useState<McpServerDraft[]>(
    (node.mcpServers ?? []).length > 0 ? (node.mcpServers ?? []).map(toDraft) : [toDraft({ slug: "", url: "", allowedTools: [] })],
  );
  const [userCreds, setUserCreds] = useState<UserCredentialSummary[] | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
          t !== MCP_TOOL,
      );
      const tools = [
        ...nonFileTools,
        ...(form.fileAccessRoot ? [...FILE_TOOLS, ...(form.allowWrites ? WRITE_TOOLS : [])] : []),
        ...(dispatchEnabled ? [DISPATCH_TOOL] : []),
        ...(manageEnabled ? [MANAGE_TOOL] : []),
        ...(remoteCommandEnabled ? [REMOTE_TOOL] : []),
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
              }))
          : [],
        consensusGroup: fanoutEnabled ? { aggregatorNodeId: aggregatorId, edgeIds: fanoutEdgeIds } : null,
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
        <input type="checkbox" checked={dispatchEnabled} onChange={(e) => setDispatchEnabled(e.target.checked)} />
        <span>
          Allow dispatch to other graphs{" "}
          <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
            (dispatch_to_graph — fire-and-forget starts a run in a graph below; check_dispatch_status lets it check back later)
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
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button type="button" onClick={() => void discoverRow(i)} disabled={server.discovering}>
                  {server.discovering ? "Discovering…" : "Discover tools"}
                </button>
                <button
                  type="button"
                  onClick={() => setMcpServers((prev) => prev.filter((_, j) => j !== i))}
                  disabled={mcpServers.length === 1}
                >
                  Remove server
                </button>
              </div>
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
