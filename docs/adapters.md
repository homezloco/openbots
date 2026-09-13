# Provider adapters

`packages/providers` normalizes Anthropic, OpenAI, xAI, OpenRouter, and
generic OpenAI-compatible endpoints behind one `ProviderAdapter` interface
(`src/types.ts`, `src/registry.ts`).

## Why built on the Vercel AI SDK

Provider wire formats drift independently (tool-calling shapes especially).
Rather than hand-rolling and maintaining N bespoke request/response
mappings, each adapter wraps the corresponding `@ai-sdk/*` package —
drift is absorbed upstream instead of becoming an OpenBots maintenance
burden. OpenRouter and the generic `openai-compatible` provider both route
through `@ai-sdk/openai-compatible` since they speak the same wire format;
no dedicated client needed for either.

## Capability flags, not a lowest common denominator

Each adapter declares `ProviderCapabilities` (`streaming`, `toolCalling`,
`vision`, `promptCaching`) rather than the engine assuming uniform support
across providers. A graph that wires a node to a provider lacking a
capability the node's config needs should surface that as a validation
error, not a silent runtime failure — not yet implemented, tracked as a
Phase 1/2 item.

## Prompt caching

The `promptCaching` flag means "this codebase has an explicit opt-in
mechanism for this provider", not "this provider caches". OpenAI caches
automatically with no code at all, and is flagged `false` for that reason
— its savings still land in cost estimates via the SDK's normalized usage.

Two providers have real mechanisms, and they work differently:

**`anthropic`** (direct) — gated behind the `ANTHROPIC_PROMPT_CACHING`
env var, off by default. `engine.ts::buildPromptOptions` puts
`cache_control` on the system prompt via `providerOptions`, and
`withStepCaching` adds a single *moving* breakpoint on the last message
of each tool-loop step (`prepareStep`), so a multi-step investigation
stops resending every prior file read at full price. One moving marker,
not one per step — Anthropic allows only four breakpoints per request.

**`openrouter`** — always on for `anthropic/*` models, because it costs
nothing when unused. It cannot use `providerOptions`: the generic
`@ai-sdk/openai-compatible` serializer drops them entirely. Instead
`registry.ts::openRouterCachingFetch` injects `cache_control` into the
serialized body through the provider's own `fetch` hook, marking the
system message and the final message. It uses **per-content-block**
breakpoints rather than OpenRouter's top-level `cache_control`, because
the top-level form forces routing to Anthropic direct while per-block
works through Bedrock and Vertex too. Any unexpected body shape is sent
through untouched — a cost optimization must never break a request.

**Usage accounting on OpenRouter needs its own converter.** The
openai-compatible package maps `cached_tokens` → `cacheRead` but
hard-codes `cacheWrite: void 0`, since cache writes aren't in the OpenAI
shape it targets. OpenRouter does report `cache_write_tokens` (and the
package's schema for that object is `$loose`, so the field survives
parsing), so `convertOpenRouterUsage` supplies it via the sanctioned
`convertUsage` setting. Without it, write tokens fall into `noCache` and
get priced at 1.0x instead of Anthropic's 1.25x cache-write rate — a real
cost under-estimate on exactly the calls that populate a cache.

Measured end-to-end on two hops against one node (OpenRouter → Bedrock,
`anthropic/claude-sonnet-4`): hop 1 recorded 5,531 cache-write tokens at
$0.02189; hop 2 recorded 5,519 cache-read tokens at $0.00306 — **86%
cheaper on the repeat hop**, with both buckets now priced correctly.

## Guarding against silent breakage

Not yet implemented, but planned before Phase 2 ships full provider
coverage: golden/contract tests per adapter (recorded fixtures + a
periodic live smoke test in CI) so a provider API change is caught by a
red build rather than a user bug report.

## Credentials

`apps/api/src/orchestrator/credentials.ts` resolves a model provider's
API key in order: a node-specific stored credential, then a graph-wide
one, then an environment variable — different agents can use different
accounts/keys for the same provider. Stored credentials
(`provider_credentials`) are AES-256-GCM encrypted (`auth/crypto.ts`) and
the plaintext never appears in any API response.

This is a *different* system from `user_credentials` — account-scoped,
not graph/node-scoped, holding the GitHub PAT/SSH key `/push` and `/pr`
use (see `docs/orchestration.md`'s "Confirmed push and PR creation"
section) and `metrics_<slug>` logins for `business_metrics`. Don't
conflate them: a graph-scoped provider credential authenticates model
calls; an account-scoped user credential authenticates git or a named
metrics source.

**Metrics scale by slug, not by new tools.** Each site/app is one
`metrics_<slug>` row the account adds at `/settings`:
`{username, password, baseUrl, style}` (`style` is `"dashboard"` or
`"login"`). N websites = N slugs, same tool. Save-time validation
rejects an incomplete shape so a later hop cannot see `null`. The
tool returns `{error, kind:"config"}` when the source is missing or
incomplete (human fixes it at `/settings`) and `{error, kind:"upstream"}`
when the remote site itself failed. Agents never write those rows —
a file-writing specialist cannot "fix analytics" that is actually a
missing OpenBots credential. Don't scrape Render/Railway for every
new site; that's a one-off operator bootstrap, not the product path.

## MCP client

OpenBots is an MCP **client**, not a server and not a plugin host. A node
with `"mcp"` in `tools[]` and a non-empty `mcpServers[]` can call tools
on remote Streamable HTTP (SSE fallback) MCP servers. The worker never
spawns stdio processes and never `import()`s user code — same network
shape as `pc_telemetry` / `business_metrics`.

- Operator fence: `ALLOWED_MCP_SERVERS` (comma-separated http(s) URL
  prefixes, empty-deny). Checked at save **and** on every hop. Redirects
  are refused (`redirect: "error"`).
- Per-server `allowedTools` is an exact-name allowlist; empty means zero
  tools, not all of them. Model-facing names are `mcp_<slug>_<toolName>`.
- Optional `credentialProvider` looks up `user_credentials` and sends
  `Authorization: Bearer`. Missing credential skips that server; the hop
  still runs. Tokens never live on the node row or in API responses.
- Connection lifetime is one hop (`apps/api/src/orchestrator/mcpTool.ts`).
  One server failing does not fail the hop.
- Humans configure this on the node settings form: Discover
  (`POST /mcp/discover`) lists advertised tools for a checklist. Discover
  never calls a tool.

stdio MCP, OpenBots-as-MCP-server, resources/prompts/sampling, and OAuth
browser flows are all out of scope.

## Built-in tools

The registry is a small allowlist, not dynamic npm plugins. File tools
need both the tool name on the node *and* a configured root inside the
matching operator allowlist.

| Tool | Where it lives | Notes |
|---|---|---|
| `calculator`, `current_time` | `packages/providers` | Always safe. |
| `read_file`, `list_directory`, `search_knowledge` | `packages/providers` | `ALLOWED_FILE_ACCESS_ROOTS`; empty-deny. `search_knowledge` chunks the folder and ranks excerpts (lexical; OpenAI embedding re-rank if `OPENAI_API_KEY` is set). Not a vector database. |
| `write_file`, `edit_file` | `packages/providers` | Separate `ALLOWED_FILE_WRITE_ROOTS`; isolated git worktree. |
| `pc_telemetry` | `packages/providers` | Read-only WebSocket to a local monitor. |
| `business_metrics` | `apps/api` | Account `metrics_<slug>` credentials at `/settings`. |
| `dispatch_to_graph`, `check_dispatch_status`, `manage_target_graphs` | `apps/api` | Cross-graph; ownership re-checked at call time. |
| `run_remote_command` | `apps/api` | `ALLOWED_SSH_HOSTS` + per-node command labels. |
| `mcp` + `mcpServers[]` | `apps/api` | Remote MCP client; `ALLOWED_MCP_SERVERS`; namespaced `mcp_<slug>_<tool>`. |
