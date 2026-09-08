"use client";

import { useState } from "react";
import type { AgentNode, ProviderId } from "@openbots/graph-schema";
import { updateNode } from "../lib/api";
import { PROVIDERS, ROLES } from "./HierarchyCanvas";

const TIERS: AgentNode["tier"][] = [undefined, "economy", "standard", "flagship"];
const FILE_TOOLS = ["read_file", "list_directory"];

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
  });
  const [fallbackChain, setFallbackChain] = useState(node.fallbackChain);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const nonFileTools = node.tools.filter((t) => !FILE_TOOLS.includes(t));
      const tools = form.fileAccessRoot ? [...nonFileTools, ...FILE_TOOLS] : nonFileTools;
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
        File access root <span style={{ color: "var(--text-faint)", fontSize: 12 }}>(absolute path, read-only, subject to the operator allowlist)</span>
        <input value={form.fileAccessRoot} onChange={(e) => setForm({ ...form, fileAccessRoot: e.target.value })} />
      </label>

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
