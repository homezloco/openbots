import { jsonSchema, tool, type Tool } from "ai";
import { Client, SSEClientTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { and, eq } from "drizzle-orm";
import type { AgentNode, McpServer } from "@openbots/graph-schema";
import { db } from "../db/client.js";
import { userCredentials } from "../db/schema.js";
import { decryptCredential } from "../auth/crypto.js";
import { checkMcpServersAllowed } from "../validation/mcpServer.js";

const CONNECT_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 30_000;

export interface McpGrantedTool {
  sdkName: string;
  description: string;
}

export interface McpResolution {
  tools: Record<string, Tool>;
  granted: McpGrantedTool[];
  skipped: string[];
  closeAll: () => Promise<void>;
}

const emptyResolution = (): McpResolution => ({
  tools: {},
  granted: [],
  skipped: [],
  closeAll: async () => {},
});

/** Model-facing name: `mcp_<slug>_<toolName>`. Slug cannot contain `_`. */
export function mcpSdkName(slug: string, toolName: string): string {
  return `mcp_${slug}_${toolName}`;
}

function redact(message: string): string {
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/(Authorization:\s*)\S+/gi, "$1[redacted]");
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : JSON.stringify(content);
  return content
    .map((block) => {
      if (block && typeof block === "object" && "text" in block) return String((block as { text: unknown }).text);
      return JSON.stringify(block);
    })
    .join("\n");
}

/**
 * Hop-time MCP client. Dual-gate: `"mcp"` in tools[] AND a non-empty
 * mcpServers list, plus a fresh ALLOWED_MCP_SERVERS re-check — config is
 * a convenience, not the security boundary (same sentence as
 * fileAccessRoot / dispatchTargets). One connect per server per hop;
 * never cached across hops or consensus branches. Failure of one server
 * skips that server; the hop still runs with whatever else connected.
 */
export async function resolveMcpTools(node: AgentNode, ownerId: string | null, builtinNames: Set<string>): Promise<McpResolution> {
  if (!node.tools.includes("mcp")) return emptyResolution();
  const servers = node.mcpServers ?? [];
  if (servers.length === 0) return emptyResolution();

  const allowError = checkMcpServersAllowed(servers);
  if (allowError) {
    const skipped = [`MCP skipped: ${allowError}`];
    console.warn(`[mcp] ${skipped[0]}`);
    return { ...emptyResolution(), skipped };
  }

  const tools: Record<string, Tool> = {};
  const granted: McpGrantedTool[] = [];
  const skipped: string[] = [];
  const closers: Array<() => Promise<void>> = [];

  const closeAll = async () => {
    await Promise.allSettled(closers.map((close) => close()));
  };

  for (const server of servers) {
    await resolveOneServer(server, ownerId, builtinNames, tools, granted, skipped, closers);
  }

  return { tools, granted, skipped, closeAll };
}

async function resolveOneServer(
  server: McpServer,
  ownerId: string | null,
  builtinNames: Set<string>,
  tools: Record<string, Tool>,
  granted: McpGrantedTool[],
  skipped: string[],
  closers: Array<() => Promise<void>>,
): Promise<void> {
  if (server.allowedTools.length === 0) {
    skipped.push(`MCP server ${server.slug}: no tools granted (empty allowedTools).`);
    return;
  }

  let token: string | undefined;
  if (server.credentialProvider) {
    if (!ownerId) {
      skipped.push(`MCP server ${server.slug}: credential ${server.credentialProvider} not configured`);
      return;
    }
    const cred = await db.query.userCredentials.findFirst({
      where: and(eq(userCredentials.userId, ownerId), eq(userCredentials.provider, server.credentialProvider)),
    });
    if (!cred) {
      skipped.push(`MCP server ${server.slug}: credential ${server.credentialProvider} not configured`);
      return;
    }
    token = decryptCredential(cred.encryptedKey);
  }

  let connected: { client: Client; close: () => Promise<void> };
  try {
    connected = await connectMcp(new URL(server.url), token);
  } catch (err) {
    const reason = redact(err instanceof Error ? err.message : String(err));
    skipped.push(`MCP server ${server.slug}: skipped (${reason})`);
    console.warn(`[mcp] ${server.slug}: connect failed: ${reason}`);
    return;
  }
  closers.push(connected.close);

  let advertised: { name: string; description?: string; inputSchema?: unknown }[];
  try {
    const listed = await connected.client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
    advertised = listed.tools;
  } catch (err) {
    const reason = redact(err instanceof Error ? err.message : String(err));
    skipped.push(`MCP server ${server.slug}: skipped (listTools: ${reason})`);
    console.warn(`[mcp] ${server.slug}: listTools failed: ${reason}`);
    return;
  }

  const byName = new Map(advertised.map((t) => [t.name, t]));
  for (const name of server.allowedTools) {
    const meta = byName.get(name);
    if (!meta) {
      skipped.push(`MCP server ${server.slug}: advertised tools do not include "${name}"`);
      continue;
    }
    if (!meta.inputSchema || typeof meta.inputSchema !== "object") {
      skipped.push(`MCP server ${server.slug}: tool "${name}" has no inputSchema; skipped`);
      continue;
    }
    const sdkName = mcpSdkName(server.slug, name);
    if (builtinNames.has(sdkName) || sdkName in tools) {
      skipped.push(`MCP server ${server.slug}: tool "${name}" collides with a built-in name; skipped`);
      continue;
    }

    const description = `[MCP:${server.slug}] ${meta.description ?? name}`;
    const client = connected.client;
    tools[sdkName] = tool({
      description,
      inputSchema: jsonSchema(meta.inputSchema as Record<string, unknown>),
      execute: async (args: unknown) => {
        const arguments_ =
          args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
        const result = await client.callTool({ name, arguments: arguments_ }, { timeout: CALL_TIMEOUT_MS });
        if (result.isError) {
          return { error: contentText(result.content) };
        }
        if (result.structuredContent !== undefined) return result.structuredContent;
        return { content: contentText(result.content) };
      },
    });
    granted.push({ sdkName, description });
    builtinNames.add(sdkName);
  }
}

async function connectMcp(url: URL, token: string | undefined): Promise<{ client: Client; close: () => Promise<void> }> {
  const authProvider = token ? { token: async () => token } : undefined;
  const requestInit: RequestInit = { redirect: "error" };
  const fetchNoRedirect: typeof fetch = (input, init) => fetch(input, { ...init, redirect: "error" });

  const streamable = new StreamableHTTPClientTransport(url, {
    requestInit,
    fetch: fetchNoRedirect,
    authProvider,
    reconnectionOptions: {
      initialReconnectionDelay: 250,
      maxReconnectionDelay: 250,
      maxRetries: 0,
      reconnectionDelayGrowFactor: 1,
    },
  });
  const streamableClient = new Client({ name: "openbots", version: "0.1.0" });
  let streamableErr: unknown;
  try {
    await streamableClient.connect(streamable, { timeout: CONNECT_TIMEOUT_MS });
    return {
      client: streamableClient,
      close: async () => {
        try {
          await streamable.terminateSession();
        } catch {
          /* 405 / already gone */
        }
        try {
          await streamableClient.close();
        } catch {
          /* already closed */
        }
      },
    };
  } catch (err) {
    streamableErr = err;
    try {
      await streamableClient.close();
    } catch {
      /* ignore */
    }
  }

  const sse = new SSEClientTransport(url, { requestInit, fetch: fetchNoRedirect, authProvider });
  const sseClient = new Client({ name: "openbots", version: "0.1.0" });
  try {
    await sseClient.connect(sse, { timeout: CONNECT_TIMEOUT_MS });
    return {
      client: sseClient,
      close: async () => {
        try {
          await sseClient.close();
        } catch {
          /* already closed */
        }
      },
    };
  } catch (sseErr) {
    try {
      await sseClient.close();
    } catch {
      /* ignore */
    }
    throw streamableErr instanceof Error ? streamableErr : sseErr;
  }
}

export interface DiscoveredMcpTool {
  name: string;
  description: string;
}

/**
 * Human-triggered probe for the settings UI. Connect + listTools only —
 * never callTool. Caller must have already checked the URL allowlist.
 */
export async function discoverMcpServer(
  url: string,
  ownerId: string,
  credentialProvider?: string,
): Promise<{ name: string; tools: DiscoveredMcpTool[] }> {
  let token: string | undefined;
  if (credentialProvider) {
    const cred = await db.query.userCredentials.findFirst({
      where: and(eq(userCredentials.userId, ownerId), eq(userCredentials.provider, credentialProvider)),
    });
    if (!cred) {
      throw new Error(`credential ${credentialProvider} not configured`);
    }
    token = decryptCredential(cred.encryptedKey);
  }

  const connected = await connectMcp(new URL(url), token);
  try {
    const listed = await connected.client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
    const info = connected.client.getServerVersion();
    return {
      name: info?.name ?? "mcp",
      tools: listed.tools.map((t) => ({ name: t.name, description: t.description ?? "" })),
    };
  } finally {
    await connected.close();
  }
}

/**
 * Same family as appendRemoteCommandContext: a model granted MCP has zero
 * built-in knowledge of the namespaced tool names. Lists only tools that
 * actually wrapped this hop; connect/credential failures are named so the
 * model doesn't invent a call that isn't in `tools`.
 */
export function appendMcpContext(systemPrompt: string, resolution: McpResolution): string {
  if (resolution.granted.length === 0 && resolution.skipped.length === 0) return systemPrompt;
  const parts: string[] = [];
  if (resolution.granted.length > 0) {
    const list = resolution.granted.map((t) => `- ${t.sdkName}: ${t.description}`).join("\n");
    parts.push(
      `You can call these MCP tools by their exact names (you cannot invent a new server, URL, or tool name, and you cannot expand this list):\n${list}`,
    );
  }
  if (resolution.skipped.length > 0) {
    parts.push(`MCP setup notes (these tools are NOT available this hop):\n${resolution.skipped.map((s) => `- ${s}`).join("\n")}`);
  }
  return `${systemPrompt}\n\n${parts.join("\n\n")}`;
}
