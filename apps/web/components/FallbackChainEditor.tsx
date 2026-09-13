"use client";

import type { AgentNode, ProviderId } from "@openbots/graph-schema";
import { PROVIDERS } from "./HierarchyCanvas";

/**
 * The "+ Add fallback" editor, shared by a node's own settings
 * (AgentSettingsForm.tsx) and a graph's default fallback chain
 * (GraphSettingsPanel.tsx) — same FallbackTarget[] shape either way, so
 * one editor rather than two copies to keep in sync. See
 * AgentGraph.fallbackChain and engine.ts::callAgent for the "node
 * overrides graph entirely when non-empty" resolution this feeds.
 */
export function FallbackChainEditor({
  value,
  onChange,
}: {
  value: AgentNode["fallbackChain"];
  onChange: (next: AgentNode["fallbackChain"]) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {value.map((f, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select
            value={f.provider}
            onChange={(e) => {
              const next = [...value];
              next[i] = { ...next[i], provider: e.target.value as ProviderId };
              onChange(next);
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
              const next = [...value];
              next[i] = { ...next[i], model: e.target.value };
              onChange(next);
            }}
            style={{ flex: 1 }}
          />
          <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...value, { provider: "anthropic", model: "" }])}
        style={{ alignSelf: "flex-start" }}
      >
        + Add fallback
      </button>
    </div>
  );
}
