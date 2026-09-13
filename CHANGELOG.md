# Changelog

All notable changes to OpenBots are documented here. This project uses
[semantic versioning](https://semver.org/); pre-1.0, minor versions may
contain breaking changes, which will always be called out explicitly.

## v0.1.0 — 2026-09-13

First tagged release. OpenBots has been developed and dogfooded against
real workloads before this point; this tag marks the version considered
ready for other people to run.

### Orchestration

- **Live, editable canvas.** Agent hierarchy and routing are a graph you
  edit directly. Drag an edge while a run is executing and the next hop
  follows the new target (`mode: "live"`); `pinned` snapshots the graph
  at creation instead. This falls out of the engine resolving each hop
  fresh rather than planning a run ahead of time — see
  `docs/blog/why-you-cant-reroute-a-running-workflow.md`.
- **Three routing kinds.** `explicit` (always this path), `auto`
  (semantic match against a target's name and description), and
  `consensus` (fan out to N branches, join, hand to an aggregator).
  Hybrid nodes combine `auto` with a `consensusGroup`, fanning out only
  when the model signals `ALL`.
- **Sentinel conventions** the engine teaches automatically: `UNKNOWN`
  when a router can't confidently pick, `ALL` for fan-out, `DONE` to end
  without routing.
- **Cross-graph dispatch.** `dispatch_to_graph` blocks and returns the
  target graph's real output, so a lead can delegate, review, and
  re-dispatch with revisions. Cycle-guarded by `runs.dispatchDepth`.
  `manage_target_graphs` additionally allows restructuring a target.
- **Rewind-and-fork.** Re-execute any past hop as a new run; the source
  run is immutable.
- **Scheduled and event triggers.** Cron schedules via BullMQ job
  schedulers, plus inbound webhooks with per-trigger tokens and rate
  limits.

### Models and tools

- **Model-agnostic, BYOK.** Anthropic, OpenAI, xAI, OpenRouter, and any
  OpenAI-compatible endpoint including local Ollama — no API key
  required for a fully local setup.
- **Prompt caching** on Anthropic (opt-in via `ANTHROPIC_PROMPT_CACHING`,
  including a moving breakpoint across multi-step tool loops) and on
  OpenRouter for Anthropic-family models (always on; measured ~86%
  cheaper on a repeat hop). See `docs/adapters.md`.
- **Non-agent `transform` nodes** — `template`, `uppercase`,
  `extract-json`: deterministic, zero-cost, no model call.
- **Built-in tools:** file read/write, `search_knowledge`, `run_code`
  (E2B / Daytona / self-hosted Piston), `run_remote_command`,
  `business_metrics`, `pc_telemetry`, and an MCP client supporting
  Streamable HTTP/SSE with custom-header auth.
- **`mock` provider** for deterministic, zero-cost testing.

### Safety

- Agent file writes are isolated to a git worktree on their own branch —
  never your checkout — and auto-committed per hop.
- `/push` and `/pr` are matched by exact regex against the human's own
  typed input **before any model involvement**, so nothing an agent
  reads can trigger an irreversible action.
- Every dangerous capability is empty-deny behind an operator allowlist
  (`ALLOWED_FILE_ACCESS_ROOTS`, `ALLOWED_FILE_WRITE_ROOTS`,
  `ALLOWED_SSH_HOSTS`, `ALLOWED_MCP_SERVERS`, `SANDBOX_PROVIDER`), and
  node config is never the security boundary.
- Credentials are AES-256-GCM encrypted and never returned by any API
  response. Tool output is redacted before reaching the model.
- Full reasoning in
  `docs/blog/giving-agents-write-access-without-losing-sleep.md`.

### Testing

- **Free PR tier** (`test:e2e:mock`, 14 cases) runs on every pull
  request with no API keys and no billed calls — fork PRs included.
- **Full suite** (`test:e2e`, 120 cases) runs against a real stack with
  real model calls on pushes to `main`, provider-configurable via
  `E2E_PROVIDER` / `E2E_MODEL`.

### Known limitations

- Single-owner auth; no teams, sharing, or RBAC.
- `/push` and `/pr` support `github.com` only.
- Integrations go through MCP rather than a built-in connector library.
- Consensus fan-out runs branches inline within one job, without
  partial-failure retry.
- Conversation memory is bounded transcript truncation, not
  summarization or structured recall.
- Agent worktrees are never garbage-collected.
- A run output that is valid JSON text round-trips through `jsonb` as a
  parsed document.
- The full e2e suite depends on live model behavior and can show one or
  two non-deterministic failures on an otherwise working `main`.

See [`PLAN.md`](./PLAN.md) for the complete, honest engineering ledger.

### License

Apache-2.0 plus a narrow Additional Use Grant: self-hosting, modifying,
and forking are free, including commercially; offering OpenBots to third
parties as a hosted multi-tenant service requires a commercial
agreement. See [`LICENSE`](./LICENSE).
