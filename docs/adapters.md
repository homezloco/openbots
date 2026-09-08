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

`apps/api/src/orchestrator/credentials.ts` resolves a model provider's
API key in order: a node-specific stored credential, then a graph-wide
one, then an environment variable — different agents can use different
accounts/keys for the same provider. Stored credentials
(`provider_credentials`) are AES-256-GCM encrypted (`auth/crypto.ts`) and
the plaintext never appears in any API response.

This is a *different* system from `user_credentials` — account-scoped,
not graph/node-scoped, holding the GitHub PAT/SSH key `/push` and `/pr`
use (see `docs/orchestration.md`'s "Confirmed push and PR creation"
section). Don't conflate the two: a graph-scoped provider credential
authenticates model calls; an account-scoped user credential
authenticates git operations against GitHub.
