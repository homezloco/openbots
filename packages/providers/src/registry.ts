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
      // .includes, NOT TEMPLATE_INPUT_PLACEHOLDER.test(): calling .test()
      // on a /g regex advances its shared lastIndex, so a second call can
      // silently start mid-string and miss a real placeholder — the
      // stateful-global-regex footgun.
      return template.includes("{{input}}")
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
 * OpenRouter supports Anthropic-style prompt caching, but NOT through the
 * AI SDK's `providerOptions` — the generic openai-compatible serializer
 * drops provider-specific message options entirely (confirmed by grepping
 * the installed @ai-sdk/openai-compatible@3.0.44 dist: it has no
 * providerOptions/cache_control handling at all). So engine.ts's
 * `cacheControl` providerOptions are a silent no-op on this route, and the
 * marker has to be injected into the already-serialized request body
 * instead — via the `fetch` hook the provider settings explicitly expose
 * for exactly this "intercept requests" purpose.
 *
 * Per OpenRouter's own prompt-caching docs, EXPLICIT per-content-block
 * `cache_control` breakpoints work across all Anthropic-compatible
 * providers including Bedrock and Vertex — unlike top-level automatic
 * `cache_control`, which forces routing to Anthropic direct. Our real
 * test call landed on Bedrock, so per-block is the only option that works
 * without constraining routing.
 *
 * Applies at most 2 of Anthropic's 4 allowed breakpoints: the system
 * message (static, resent identically every hop) and the final message
 * (the moving breakpoint that makes a growing tool loop cacheable — the
 * same strategy engine.ts::withStepCaching uses on the direct Anthropic
 * route). Tool-role messages are deliberately skipped: their content
 * shape is not reliably block-convertible across providers.
 */
const ANTHROPIC_MODEL_PREFIX = "anthropic/";

type ChatMessage = { role?: string; content?: unknown };

/** Converts a string content to block form and marks it; leaves existing block arrays alone except for marking the last text block. */
function markCacheable(message: ChatMessage): void {
  if (message.role === "tool") return;
  if (typeof message.content === "string") {
    if (!message.content) return;
    message.content = [{ type: "text", text: message.content, cache_control: { type: "ephemeral" } }];
    return;
  }
  if (Array.isArray(message.content)) {
    for (let i = message.content.length - 1; i >= 0; i--) {
      const block = message.content[i] as { type?: string } | null;
      if (block && typeof block === "object" && block.type === "text") {
        (block as Record<string, unknown>).cache_control = { type: "ephemeral" };
        return;
      }
    }
  }
}

/**
 * The openai-compatible package's default usage converter reads
 * `prompt_tokens_details.cached_tokens` into `cacheRead` but hard-codes
 * `cacheWrite: void 0` — it has no concept of a cache-write count, since
 * that isn't in the OpenAI shape it targets. OpenRouter DOES report one
 * (`prompt_tokens_details.cache_write_tokens`), and the package's schema
 * for that object is `$loose`, so the extra field survives parsing and is
 * readable here.
 *
 * Left unmapped, every cache-write token falls into `noCache` and gets
 * priced at 1.0x instead of Anthropic's 1.25x cache-write rate — real,
 * if modest, cost UNDER-estimation on exactly the calls that populate a
 * cache (measured: a 5,850-token write reported as 0). `convertUsage` is
 * the provider's own sanctioned hook for "token accounting semantics that
 * differ from the default OpenAI-compatible shape", so this rides that
 * rather than patching around it.
 *
 * Faithfully mirrors the upstream default in every other respect
 * (including `raw`), only subtracting the write tokens out of `noCache`
 * so the three buckets still sum to `total`.
 */
// Derived from the installed package's own settings type rather than
// importing LanguageModelV4Usage from a transitive @ai-sdk/provider dep —
// same reasoning as MockDoGenerate above: this stays correct if the
// upstream usage shape changes, and keeps our import surface to direct
// dependencies only.
type ConvertUsageFn = NonNullable<Parameters<typeof createOpenAICompatible>[0]["convertUsage"]>;
type ConvertUsageResult = ReturnType<ConvertUsageFn>;

function convertOpenRouterUsage(usage: Parameters<ConvertUsageFn>[0]): ConvertUsageResult {
  const u = (usage ?? {}) as {
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    prompt_tokens_details?: { cached_tokens?: number | null; cache_write_tokens?: number | null } | null;
    completion_tokens_details?: { reasoning_tokens?: number | null } | null;
  };
  const promptTokens = u.prompt_tokens ?? 0;
  const completionTokens = u.completion_tokens ?? 0;
  const cacheReadTokens = u.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWriteTokens = u.prompt_tokens_details?.cache_write_tokens ?? 0;
  const reasoningTokens = u.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    inputTokens: {
      total: promptTokens,
      // Math.max guards a provider that reports prompt_tokens EXCLUSIVE of
      // cache writes; without it a negative noCache would corrupt pricing.
      noCache: Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens),
      cacheRead: cacheReadTokens,
      cacheWrite: cacheWriteTokens,
    },
    outputTokens: {
      total: completionTokens,
      text: Math.max(0, completionTokens - reasoningTokens),
      reasoning: reasoningTokens,
    },
    raw: u,
  } as ConvertUsageResult;
}

function openRouterCachingFetch(modelId: string): typeof globalThis.fetch {
  return async (input, init) => {
    // Only Anthropic-family models use explicit cache_control breakpoints;
    // everything else on OpenRouter either caches automatically or ignores
    // the field. Bail out untouched on anything unexpected rather than
    // risking a malformed body — a caching optimization must never be able
    // to break a request.
    if (!modelId.startsWith(ANTHROPIC_MODEL_PREFIX) || !init?.body || typeof init.body !== "string") {
      return globalThis.fetch(input, init);
    }
    try {
      const body = JSON.parse(init.body) as { messages?: ChatMessage[] };
      const messages = body.messages;
      if (Array.isArray(messages) && messages.length > 0) {
        const system = messages.find((m) => m.role === "system");
        if (system) markCacheable(system);
        const last = messages[messages.length - 1];
        if (last && last !== system) markCacheable(last);
        return globalThis.fetch(input, { ...init, body: JSON.stringify(body) });
      }
    } catch {
      // Unparseable/unexpected body — send the original untouched.
    }
    return globalThis.fetch(input, init);
  };
}

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
    // promptCaching: true covers Anthropic-family models only, and is
    // implemented by openRouterCachingFetch (body-level injection) rather
    // than providerOptions, which this adapter drops — see that function.
    capabilities: { streaming: true, toolCalling: true, vision: false, promptCaching: true },
    getModel: (modelId, creds) =>
      createOpenAICompatible({
        name: "openrouter",
        apiKey: creds.apiKey,
        baseURL: creds.baseURL ?? "https://openrouter.ai/api/v1",
        fetch: openRouterCachingFetch(modelId),
        convertUsage: convertOpenRouterUsage,
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
