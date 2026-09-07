# OpenBots — Plan

Open-source, self-hosted, model-agnostic multi-agent orchestration. The
differentiator: a live, editable canvas of the agent hierarchy and routing —
no product in the "AI bot" space currently ships one (see Competitive
notes below).

## Phase 1 — MVP (current focus)

- Graph data model + Postgres schema: agents, routing edges, runs, run
  events, versioned routing-change audit log (`packages/graph-schema`,
  `apps/api/src/db`).
- Canvas UI: create/connect agent nodes, drag-and-drop rerouting
  (`apps/web/components/HierarchyCanvas.tsx`).
- Orchestration engine: lazy per-hop routing resolution, `pinned` vs
  `live` run modes, per-node timeout/isolation
  (`apps/api/src/orchestrator`; see `docs/orchestration.md`).
- Two providers wired up initially: Anthropic + one OpenAI-compatible
  endpoint (OpenRouter gives broad model coverage for free through the
  same adapter). Full provider gateway is Phase 2.
- `explicit` vs `auto` routing edges: explicit = hard-wired; auto =
  resolved at runtime by matching agent descriptions (Grok Bot-style
  implicit delegation), rendered dashed on the canvas. Same graph, same
  engine, two resolution strategies.

**Non-goals for Phase 1** (anything here belongs to a later phase, not a
Phase 1 PR): chat threads/memory, file uploads, multi-user auth/teams,
usage/cost tracking, template marketplace.

**Demo bar for "Phase 1 done":** a 3-agent triage graph, live per-node
status during a run, and a drag of one edge that visibly changes the next
hop of an in-flight run.

## Phase 2 — Provider gateway + dashboard parity

- Full adapter layer: Anthropic, OpenAI, xAI, OpenRouter, generic
  OpenAI-compatible (Ollama, Groq, Together, etc).
- Cross-provider fallback chains per node (try provider A, fall through to
  B/C on classified auth/model errors) — modeled on the `visionterm`
  project's `ProviderRegistry.generate()` fallback-chain design.
- Per-agent model/key management, usage + cost tracking per node and run.
- Chat-style dashboard/playground view alongside the hierarchy tab.

## Phase 3 — Growth

- Tool/plugin system for agents, distributed as npm packages.
- Agent template marketplace (graphs exported/shared as JSON).
- Run replay/audit UI built on the routing-change history.
- Multi-user/teams, even for self-hosted installs.
- Possible `on_consensus` edge condition (fan out to N nodes, aggregate
  weighted votes) — pattern match from the `Loco-Coder` project's
  multi-agent consensus orchestrator; speculative, not scoped yet.

## Competitive notes (xAI Grok Bot / Grok Build, researched 2026-09)

- Grok Bot: conversational bot creation (name, color/shape, one-line job
  description), routing is **implicit and invisible** — delegation is
  inferred from description text matching, no graph/canvas UI exists.
- Grok Build Agent Dashboard: list-based session view, sorted by state
  (working/idle/blocked), subagents collapse under their parent — good
  triage pattern, still not a hierarchy visualization.
- Confirmed gaps OpenBots exploits: no visible/editable routing anywhere
  in the Grok lineup; single-vendor lock-in (no BYOK); shared-computer
  fragility (one stuck bot can take down a whole roster); paywalled
  behind a $300/mo bundle with reported compute ceilings.
- Worth adopting from their UX: fast conversational node creation, and
  the state-sorted run-triage list (planned as a secondary view
  alongside the canvas, not a replacement for it).

## License

Apache-2.0 — explicit patent grant, standard for OSS infra/agent tooling.
