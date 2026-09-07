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
`vision`) rather than the engine assuming uniform support across
providers. A graph that wires a node to a provider lacking a capability
the node's config needs should surface that as a validation error, not a
silent runtime failure — not yet implemented, tracked as a Phase 1/2 item.

## Guarding against silent breakage

Not yet implemented, but planned before Phase 2 ships full provider
coverage: golden/contract tests per adapter (recorded fixtures + a
periodic live smoke test in CI) so a provider API change is caught by a
red build rather than a user bug report.

## Credentials

`apps/api/src/orchestrator/credentials.ts` currently reads one API key per
provider from the environment — a scaffold placeholder. Phase 2 replaces
this with per-graph/per-node key management (see `PLAN.md`) so different
agents can use different accounts/keys for the same provider.
