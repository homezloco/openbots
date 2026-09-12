import type { ProviderId } from "@openbots/graph-schema";
import type { LanguageModel } from "ai";

/**
 * Declared per-provider rather than assumed uniform, so the orchestration
 * engine and canvas can react ("this node's model doesn't support tool
 * calling") instead of the adapter layer silently degrading to a lowest
 * common denominator.
 */
export interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  vision: boolean;
  /**
   * Whether this codebase has an explicit cache-breakpoint mechanism for
   * this provider (engine.ts::callAgent, gated behind
   * ANTHROPIC_PROMPT_CACHING). False does not mean "no caching at all" —
   * OpenAI's own caching is automatic server-side and needs no opt-in
   * here; this flag is specifically about whether there's a
   * cache_control-style knob this codebase knows how to pull.
   */
  promptCaching: boolean;
}

export interface ProviderCredentials {
  apiKey: string;
  /** Required for "openai-compatible"; ignored by first-party adapters. */
  baseURL?: string;
}

export interface ProviderAdapter {
  id: ProviderId;
  capabilities: ProviderCapabilities;
  /** Returns an ai-sdk LanguageModel ready to pass to generateText/streamText. */
  getModel(modelId: string, credentials: ProviderCredentials): LanguageModel;
}
