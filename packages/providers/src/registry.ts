import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import type { ProviderId } from "@openbots/graph-schema";
import type { ProviderAdapter, ProviderCredentials } from "./types.js";

/**
 * Every provider is normalized behind the Vercel AI SDK rather than
 * hand-rolled request/response mapping — provider wire-format drift (new
 * tool-calling shapes, streaming changes) is absorbed upstream instead of
 * becoming an OpenBots maintenance burden. See docs/adapters.md.
 */
const adapters: Record<ProviderId, ProviderAdapter> = {
  anthropic: {
    id: "anthropic",
    capabilities: { streaming: true, toolCalling: true, vision: true },
    getModel: (modelId, creds) => createAnthropic({ apiKey: creds.apiKey })(modelId),
  },
  openai: {
    id: "openai",
    capabilities: { streaming: true, toolCalling: true, vision: true },
    getModel: (modelId, creds) => createOpenAI({ apiKey: creds.apiKey })(modelId),
  },
  xai: {
    id: "xai",
    capabilities: { streaming: true, toolCalling: true, vision: true },
    getModel: (modelId, creds) => createXai({ apiKey: creds.apiKey })(modelId),
  },
  openrouter: {
    id: "openrouter",
    // Routed through the generic OpenAI-compatible adapter — OpenRouter
    // speaks the OpenAI wire format, so no dedicated client is needed.
    capabilities: { streaming: true, toolCalling: true, vision: false },
    getModel: (modelId, creds) =>
      createOpenAICompatible({
        name: "openrouter",
        apiKey: creds.apiKey,
        baseURL: creds.baseURL ?? "https://openrouter.ai/api/v1",
      }).chatModel(modelId),
  },
  "openai-compatible": {
    id: "openai-compatible",
    capabilities: { streaming: true, toolCalling: false, vision: false },
    getModel: (modelId, creds) => {
      if (!creds.baseURL) {
        throw new Error("openai-compatible provider requires baseURL");
      }
      return createOpenAICompatible({
        name: "openai-compatible",
        apiKey: creds.apiKey,
        baseURL: creds.baseURL,
      }).chatModel(modelId);
    },
  },
};

export function getProviderAdapter(id: ProviderId): ProviderAdapter {
  return adapters[id];
}

export function getModel(
  providerId: ProviderId,
  modelId: string,
  credentials: ProviderCredentials,
) {
  return getProviderAdapter(providerId).getModel(modelId, credentials);
}
