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
// Derived from MockLanguageModelV3's own instance method rather than a
// hand-typed guess — this stays correct if the class's doGenerate
// signature ever shifts again (e.g. a future MockLanguageModelV4) without
// needing another manual edit here. (The constructor-config route fails:
// the config parameter is optional and its doGenerate field is a
// function-or-fixture union, so Parameters<> can't be applied to it.)
type MockDoGenerate = MockLanguageModelV3["doGenerate"];
type MockDoGenerateOptions = Parameters<MockDoGenerate>[0];
type MockDoGenerateResult = Awaited<ReturnType<MockDoGenerate>>;

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

        const result: MockDoGenerateResult = {
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 },
          },
          content: [{ type: "text", text }],
          warnings: [],
        };
        return result;
      },
    }),
};

/** Every occurrence of {{input}} in a template, replaced with the hop input. */
const TEMPLATE_INPUT_PLACEHOLDER = /\{\{input\}\}/g;

/**
 * Finds the first JSON object or array in `text` by scanning for the
 * first `{` or `[` and walking forward to its matching close bracket
 * (naive bracket counting — good enough for v1, no string-literal
 * escaping awareness). Returns null if no opening bracket is found or it
 * never closes.
 */
function extractFirstJson(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const TRANSFORM_OPERATIONS = ["template", "uppercase", "extract-json"] as const;
type TransformOperation = (typeof TRANSFORM_OPERATIONS)[number];

function runTransform(operation: TransformOperation, template: string, input: string): string {
  switch (operation) {
    case "template":
      return TEMPLATE_INPUT_PLACEHOLDER.test(template)
        ? template.replace(TEMPLATE_INPUT_PLACEHOLDER, input)
        : `${template}\n${input}`;
    case "uppercase":
      return input.toUpperCase();
    case "extract-json":
      return extractFirstJson(input) ?? "TRANSFORM_ERROR: no JSON found in input";
  }
}

/**
 * The first non-agent node type: no model call, zero cost, fully
 * deterministic. Like "mock", it's implemented as a MockLanguageModelV3
 * so it slots into the same generateText() call path as every real
 * provider — but unlike "mock", the modelId itself selects which
 * operation runs (see ProviderId's doc comment), and the systemPrompt
 * carries that operation's config rather than being an LLM instruction.
 * getModel() builds the operation closure from modelId once, since
 * that's the only place modelId reaches an adapter (doGenerate only
 * ever sees the resulting prompt messages).
 */
const transformAdapter: ProviderAdapter = {
  id: "transform",
  capabilities: { streaming: false, toolCalling: false, vision: false, promptCaching: false },
  getModel: (modelId) => {
    const operation = modelId as TransformOperation;
    if (!TRANSFORM_OPERATIONS.includes(operation)) {
      throw new Error(
        `Unknown transform operation "${modelId}" — valid operations are: ${TRANSFORM_OPERATIONS.join(", ")}`,
      );
    }
    return new MockLanguageModelV3({
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

        const text = runTransform(operation, systemText, userText);

        const result: MockDoGenerateResult = {
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 },
          },
          content: [{ type: "text", text }],
          warnings: [],
        };
        return result;
      },
    });
  },
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
  transform: transformAdapter,
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
