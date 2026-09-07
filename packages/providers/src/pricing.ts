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
};

const FALLBACK_ESTIMATE = { input: 3, output: 15 };

export function estimateCostUsd(
  provider: ProviderId,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rate = PRICES_PER_MILLION_TOKENS[provider]?.[model] ?? FALLBACK_ESTIMATE;
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}
