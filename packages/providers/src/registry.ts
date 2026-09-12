import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { MockLanguageModelV3 } from "ai/test";
import type { ProviderId } from "@openbots/graph-schema";
import type { ProviderAdapter, ProviderCredentials } from "./types.js";

/**
 * Pulls plain text out of a LanguageModelV2 prompt message's `content`,
 * which is either the plain-string shorthand (system messages) or the
 * structured `{type: "text", text}[]` array form (user/assistant messages)
 * — defensive about which shape shows up here, same as engine.ts's own
 * handling of AI SDK step results it doesn't control the shape of.
 */
function extractPromptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && (part as { type?: string }).type === "text"
          ? ((part as { text?: string }).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

/** Matches "ROUTE_TO <name>" anywhere in a node's (already auto-routing-context-appended) system prompt. */
const MOCK_ROUTE_TO = /ROUTE_TO\s+(\S+)/;

/**
 * No network call, no credentials required (see credentials.ts's "mock"
 * cases) — exists purely so tests can exercise routing/orchestration
 * deterministically without billed API calls. Two fixed behaviors, no
 * randomness: echo "MOCK: " + the last 200 chars of the user prompt, or
 * — if the system prompt contains "ROUTE_TO <name>" — reply with exactly
 * <name>, so a future routing test can steer auto-routing deterministically
 * (resolve.ts matches an auto edge's target name against the output text).
 */
// Derived from MockLanguageModelV3's own constructor type rather than a
// hand-typed guess — this stays correct if the class's doGenerate
// signature ever shifts again (e.g. a future MockLanguageModelV4) without
// needing another manual edit here.
type MockLanguageModelV3Config = ConstructorParameters<typeof MockLanguageModelV3>[0];
type MockDoGenerate = NonNullable<MockLanguageModelV3Config["doGenerate"]>;
type MockDoGenerateOptions = Parameters<MockDoGenerate>[0];

const mockAdapter: ProviderAdapter = {
  id: "mock",
  capabilities: { streaming: false, toolCalling: false, vision: false, promptCaching: false },
  getModel: () =>
    new MockLanguageModelV3({
      doGenerate: async (options: MockDoGenerateOptions) => {
        const messages = (options.prompt ?? []) as { role: string; content: unknown }[];
        const systemText = messages
          .filter((m) => m.role === "system")
          .map((m) => extractPromptText(m.content))
          .join("\n");
        const userText = messages
          .filter((m) => m.role === "user")
          .map((m) => extractPromptText(m.content))
          .join("\n");

        const routeMatch = systemText.match(MOCK_ROUTE_TO);
        const text = routeMatch ? routeMatch[1] : `MOCK: ${userText.slice(-200)}`;

        return {
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          content: [{ type: "text", text }],
          warnings: [],
        };
      },
    }),
};

/**
 * Every provider is normalized behind the Vercel AI SDK rather than
 * hand-rolled request/response mapping — provider wire-format drift (new
 * tool-calling shapes, streaming changes) is absorbed upstream instead of
 * becoming an OpenBots maintenance burden. See docs/adapters.md.
 */
const adapters: Record<ProviderId, ProviderAdapter> = {
  anthropic: {
    id: "anthropic",
    // The only provider with an explicit cache_control opt-in this
    // codebase implements — see engine.ts::callAgent and
    // ANTHROPIC_PROMPT_CACHING.
    capabilities: { streaming: true, toolCalling: true, vision: true, promptCaching: true },
    getModel: (modelId, creds) => createAnthropic({ apiKey: creds.apiKey })(modelId),
  },
  openai: {
    id: "openai",
    // promptCaching: false here means "no explicit opt-in mechanism in
    // this codebase" — OpenAI's own caching is automatic and free
    // server-side (no code needed), and pricing.ts::estimateCostUsd
    // already accounts for it via the AI SDK's normalized
    // inputTokenDetails regardless of this flag.
    capabilities: { streaming: true, toolCalling: true, vision: true, promptCaching: false },
    getModel: (modelId, creds) => createOpenAI({ apiKey: creds.apiKey })(modelId),
  },
  xai: {
    id: "xai",
    capabilities: { streaming: true, toolCalling: true, vision: true, promptCaching: false },
    getModel: (modelId, creds) => createXai({ apiKey: creds.apiKey })(modelId),
  },
  openrouter: {
    id: "openrouter",
    // Routed through the generic OpenAI-compatible adapter — OpenRouter
    // speaks the OpenAI wire format, so no dedicated client is needed.
    capabilities: { streaming: true, toolCalling: true, vision: false, promptCaching: false },
    getModel: (modelId, creds) =>
      createOpenAICompatible({
        name: "openrouter",
        apiKey: creds.apiKey,
        baseURL: creds.baseURL ?? "https://openrouter.ai/api/v1",
      }).chatModel(modelId),
  },
  "openai-compatible": {
    id: "openai-compatible",
    capabilities: { streaming: true, toolCalling: false, vision: false, promptCaching: false },
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
  mock: mockAdapter,
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
