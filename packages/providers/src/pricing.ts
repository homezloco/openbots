import type { ProviderId } from "@openbots/graph-schema";

/**
 * Hand-maintained, USD per million tokens. This WILL go stale the moment a
 * provider changes pricing or ships a new model — same drift problem as
 * provider adapters (see docs/adapters.md). Treat estimatedCostUsd
 * everywhere downstream as an approximation, never a billing-grade figure.
 * Unknown models fall back to a conservative flat estimate rather than 0,
 * so missing a price-table update doesn't silently hide cost entirely.
 */
const PRICES_PER_MILLION_TOKENS: Partial<Record<ProviderId, Record<string, { input: number; output: number }>>> = {
  anthropic: {
    "claude-sonnet-5": { input: 3, output: 15 },
    "claude-opus-5": { input: 15, output: 75 },
    "claude-haiku-4-5-20251001": { input: 0.8, output: 4 },
  },
  openai: {
    "gpt-5": { input: 5, output: 15 },
    "gpt-5-mini": { input: 0.5, output: 2 },
  },
  xai: {
    "grok-4": { input: 3, output: 15 },
  },
  // No network call, no real tokens billed — always zero cost regardless
  // of model id (see registry.ts's mockAdapter).
  mock: {
    "mock-model": { input: 0, output: 0 },
  },
  // No model call at all — always zero cost regardless of which
  // operation the model id selects (see registry.ts's transformAdapter).
  transform: {
    template: { input: 0, output: 0 },
    uppercase: { input: 0, output: 0 },
    "extract-json": { input: 0, output: 0 },
  },
};

const FALLBACK_ESTIMATE = { input: 3, output: 15 };

/**
 * Provider-wide ratios (not per-model), confirmed against both
 * Anthropic's and OpenAI's current published pricing: a cache write
 * (5-minute TTL — the only TTL this codebase uses, see engine.ts) costs
 * more than a plain input token since the provider has to actually
 * process and store it; a cache read is a 90% discount off the plain
 * rate. OpenAI's caching has no write-token concept (it's automatic and
 * free to enable), so cacheWriteTokens is always 0 there in practice —
 * this constant simply never gets multiplied against anything for that
 * provider.
 */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER_5M = 1.25;

/**
 * inputTokens is the TOTAL input tokens for the call (what every caller
 * already had); cacheReadTokens/cacheWriteTokens are the subset of that
 * total the provider reported as cached (from the AI SDK's
 * LanguageModelUsage.inputTokenDetails, normalized across providers).
 * Defaulting both to 0 means a caller that doesn't know about caching at
 * all gets today's exact flat-rate math, unchanged.
 */
export function estimateCostUsd(
  provider: ProviderId,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number {
  const rate = PRICES_PER_MILLION_TOKENS[provider]?.[model] ?? FALLBACK_ESTIMATE;
  const noCacheTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
  const inputCost =
    noCacheTokens * rate.input +
    cacheReadTokens * rate.input * CACHE_READ_MULTIPLIER +
    cacheWriteTokens * rate.input * CACHE_WRITE_MULTIPLIER_5M;
  return (inputCost + outputTokens * rate.output) / 1_000_000;
}
