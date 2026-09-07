# OpenBots — Plan

Open-source, self-hosted, model-agnostic multi-agent orchestration. The
differentiator: a live, editable canvas of the agent hierarchy and routing —
no product in the "AI bot" space currently ships one (see Competitive
notes below).

**Status as of 2026-09-07: all three original phases are built, and a
real automated e2e suite (`apps/api/e2e/run.ts`, `pnpm --filter
@openbots/api test:e2e`) now covers every item that was previously
"implemented but never run" — 12/12 passing, including consensus
fan-out, fallback-chain classification, credential storage, and genuine
mid-run rerouting. See "Known gaps" at the bottom for what's still
actually missing (not just untested).**

## Phase 1 — MVP

- Graph data model + Postgres schema (`packages/graph-schema`, `apps/api/src/db`). ✅ Verified.
- Canvas UI: create/connect agent nodes, drag-and-drop rerouting, natural-language quick-add, "connects from" wiring (`apps/web/components/HierarchyCanvas.tsx`). ✅ Verified live in-browser.
- Orchestration engine: lazy per-hop routing resolution, `pinned`/`live` run modes, per-node timeout/isolation, status-aware retry (`apps/api/src/orchestrator`; `docs/orchestration.md`). ✅ Verified across many runs.
- All 5 providers (Anthropic/OpenAI/xAI/OpenRouter/openai-compatible) — exceeded the original "two providers first" scope; built via one adapter layer from the start. ✅ Anthropic path verified live; other 4 providers share the same code path but were never called against real credentials.
- `explicit` / `auto` / `consensus` routing edges. `explicit` and `auto` ✅ verified (a 3-specialist delegation test routed correctly on live content — see Delegation e2e below). `consensus` fan-out/join is fully implemented (schema, DB, engine) but **never actually run** — no test graph has exercised it.

**Not yet demonstrated from the original Phase 1 bar:** true *mid-run* rerouting — dragging an edge while a run is actively in flight and watching the next hop change. The lazy-resolution design supports this by construction (every hop re-reads the graph), but every reroute we've tested happened *between* runs, not during one.

## Phase 2 — Provider gateway + dashboard parity

- Full adapter layer. ✅ Done (see above).
- Cross-provider fallback chains (`AgentNode.fallbackChain`, `classifyProviderError`). ✅ Implemented, ⚠️ never triggered in a test — no run has actually hit a classified auth/model error to prove the fallthrough works.
- Per-agent/per-node encrypted credential storage (`provider_credentials`, AES-256-GCM). ✅ Implemented, ⚠️ never exercised — no test has stored a credential and confirmed a node actually used it over the env-var default.
- Usage + cost tracking per run/node. ✅ Verified — real token counts and cost estimates confirmed in run output.
- Chat-style dashboard. Evolved into more than originally scoped: Dashboard is now a full **bot roster** (Grok Bot pattern) with natural-language bot creation and **multi-turn conversation memory**. ✅ Verified live in-browser, including memory across turns.

## Phase 3 — Growth

- Tool/plugin system. ✅ Verified — built-in registry (calculator, current_time) plus a scoped, read-only file-access tool with path-traversal protection, confirmed blocking an actual `../` escape attempt.
- Agent template marketplace (save/instantiate). ✅ Verified via API (export a graph, list templates, instantiate a deep copy with remapped ids).
- Run replay/audit UI (event trail + routing-change log). ✅ Built, backend verified via API; the frontend page itself hasn't been clicked through live.
- Multi-user auth. ✅ Verified (signup/login/cookie sessions, graph ownership enforced) — deliberately scoped to individual ownership only. **Team/role-based sharing was never built** — out of scope by design, not an oversight.
- `consensus` edge type (fan-out to N nodes, join, hand off to an aggregator). ✅ Implemented end-to-end in the engine — **never run**. This is the single most architecturally complex piece built this session and it has zero test coverage.

## Beyond the original plan (added along the way)

- "Master agent" quick-add: describe an agent in plain English, an LLM produces its config, created through the same API as manual creation. ✅ Verified live, multiple times.
- `GET /graphs` roster endpoint + graph pickers on Hierarchy/Runs (fixes a real usability gap — there was no way to discover existing graphs without already knowing their id). ✅ Built, ⚠️ picker itself not yet re-confirmed live after the fix (straightforward, low risk).
- Reviewer/tier mismatch warning. ✅ Verified — fired correctly on a real graph.
- Supervisor (👑) / reviewer (🔎) visual markers on the canvas. ✅ Built, not separately re-confirmed visually.

## Known gaps (honest list)

Closed by the e2e suite (`apps/api/e2e/run.ts`) — all verified passing:
- `consensus` fan-out/join (branches run concurrently, aggregator receives all outputs).
- Fallback-chain classification (a real 401 on the primary causes fallthrough to the next target).
- Encrypted credential storage (a stored per-node credential is actually resolved and used, not silently skipped for the env var).
- True mid-run rerouting (a reroute fired while the first hop is still generating changes the second hop — requires `mode: "live"`, since `pinned`, the default, deliberately never re-reads the graph).

Writing that suite also caught two real bugs, both fixed: `POST /templates/:id/instantiate` (and any bodyless POST) was broken by a client `Content-Type: application/json` header on an empty body; and there was no way to actually *set* `consensusGroup` on a node (it references edge ids that don't exist until after node+edges are created, but no node-update endpoint existed) — added `PATCH /graphs/:id/nodes/:nodeId`.

Still genuinely missing (not just untested):
1. **The containerized `web` Docker image has never successfully built** in this environment (a persistent npm-registry network issue in this sandbox, not a code problem — the API image builds fine). The web app has been running via local `pnpm start` the entire session, not its intended container.
2. **Team/role-based sharing does not exist.** Auth is single-owner only, by design.
3. A few frontend pages (run detail/replay, the graph pickers) are confirmed via typecheck/build and the backend they call is e2e-tested, but haven't all been personally clicked through in a browser.

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

## License

Apache-2.0 — explicit patent grant, standard for OSS infra/agent tooling.
