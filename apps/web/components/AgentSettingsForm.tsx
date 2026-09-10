"use client";

import { useEffect, useState } from "react";
import type { AgentNode, ProviderId } from "@openbots/graph-schema";
import { listGraphs, updateNode, type GraphSummary } from "../lib/api";
import { PROVIDERS, ROLES } from "./HierarchyCanvas";

const TIERS: AgentNode["tier"][] = [undefined, "economy", "standard", "flagship"];
const FILE_TOOLS = ["read_file", "list_directory"];
const WRITE_TOOLS = ["write_file", "edit_file"];
const DISPATCH_TOOL = "dispatch_to_graph";
const MANAGE_TOOL = "manage_target_graphs";
const REMOTE_TOOL = "run_remote_command";

/**
 * Editing an existing agent's config — reuses the same field set as the
 * manual Add-agent form (HierarchyCanvas.tsx), just backed by PATCH
 * instead of POST. fileAccessRoot still drives the read_file/list_directory
 * tool pair, but non-file tools (e.g. pc_telemetry, calculator) already on
 * the node are preserved rather than being silently overwritten.
 */
export function AgentSettingsForm({
  graphId,
  node,
  onSaved,
  onCancel,
}: {
  graphId: string;
  node: AgentNode;
  onSaved: (updated: AgentNode) => void;
  onCancel: () => void;
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
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listGraphs()
      .then((graphs) => setAvailableGraphs(graphs.filter((g) => g.id !== graphId)))
      .catch(() => setAvailableGraphs([]));
  }, [graphId]);

  function toggleDispatchTarget(id: string) {
    setDispatchTargets((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));
  }

  function addCommandRow() {
    setAllowedCommands((prev) => [...prev, { label: "", command: "" }]);
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
    setSaving(true);
    setError(null);
    try {
      const nonFileTools = node.tools.filter(
        (t) => !FILE_TOOLS.includes(t) && !WRITE_TOOLS.includes(t) && t !== DISPATCH_TOOL && t !== MANAGE_TOOL && t !== REMOTE_TOOL,
      );
      const tools = [
        ...nonFileTools,
        ...(form.fileAccessRoot ? [...FILE_TOOLS, ...(form.allowWrites ? WRITE_TOOLS : [])] : []),
        ...(dispatchEnabled ? [DISPATCH_TOOL] : []),
        ...(manageEnabled ? [MANAGE_TOOL] : []),
        ...(remoteCommandEnabled ? [REMOTE_TOOL] : []),
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
            configure; host must be in the operator's ALLOWED_SSH_HOSTS allowlist)
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
            Optional SSH key credential comes from /me/credentials, provider "ssh_target_&lt;host&gt;" — leave unset if
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

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </div>
  );
}
