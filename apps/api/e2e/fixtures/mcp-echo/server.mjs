/**
 * Tiny Streamable-HTTP MCP echo server used only by the e2e suite.
 * Zero npm dependencies so the compose image doesn't hit the registry
 * (the same flakiness that used to break `docker compose build web`).
 *
 * Speaks the 2025-era JSON-RPC Streamable HTTP transport the MCP client
 * SDK uses by default (`versionNegotiation: legacy`): initialize,
 * tools/list, tools/call. Tools: `echo` (granted in e2e) and
 * `secret_ping` (advertised, never granted).
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT ?? 3930);
const HOST = process.env.HOST ?? "0.0.0.0";

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-03-26", "2024-11-05", "2026-07-28"];

const TOOLS = [
  {
    name: "echo",
    description:
      "Echo the given text back. Returns JSON { echo: <the text you sent> }. Optional delayMs sleeps " +
      "before responding (clamped, e2e-only — used to deterministically exercise dispatch_to_graph's timeout fallback).",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to echo" },
        delayMs: { type: "number", description: "Optional: milliseconds to sleep before responding" },
      },
      required: ["text"],
    },
  },
  {
    name: "secret_ping",
    description: "A secret ping that e2e agents must never be granted.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "echo_headers",
    description:
      "Returns the exact incoming authorization and x-e2e-test-key request header values (or null if absent) — " +
      "e2e-only, used to verify custom MCP auth headers actually arrive as configured.",
    inputSchema: { type: "object", properties: {} },
  },
];

function result(id, value) {
  return { jsonrpc: "2.0", id, result: value };
}

function error(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const MAX_DELAY_MS = 30_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function handleMessage(msg, reqHeaders) {
  if (!msg || typeof msg !== "object") return null;
  const { id, method, params } = msg;
  if (typeof method !== "string") return id === undefined ? null : error(id, -32600, "Invalid request");

  if (method === "initialize") {
    const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
    return result(id, {
      protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "mcp-echo", version: "1.0.0" },
    });
  }
  if (method.startsWith("notifications/")) return null;
  if (method === "ping") return result(id, {});
  if (method === "tools/list") return result(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
    if (name === "echo") {
      const text = typeof args.text === "string" ? args.text : "";
      if (typeof args.delayMs === "number" && args.delayMs > 0) {
        await sleep(Math.min(args.delayMs, MAX_DELAY_MS));
      }
      return result(id, { content: [{ type: "text", text: JSON.stringify({ echo: text }) }] });
    }
    if (name === "secret_ping") {
      return result(id, { content: [{ type: "text", text: "PONG_SECRET" }] });
    }
    if (name === "echo_headers") {
      const seen = {
        authorization: reqHeaders?.authorization ?? null,
        "x-e2e-test-key": reqHeaders?.["x-e2e-test-key"] ?? null,
      };
      return result(id, { content: [{ type: "text", text: JSON.stringify(seen) }] });
    }
    return result(id, {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
    });
  }
  if (id === undefined) return null;
  return error(id, -32601, `Method not found: ${method}`);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  return JSON.parse(raw);
}

createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (req.method === "GET" && path === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (path !== "/mcp") {
    res.writeHead(404);
    res.end();
    return;
  }
  if (req.method === "DELETE") {
    res.writeHead(200);
    res.end();
    return;
  }
  if (req.method === "GET") {
    // Stateless JSON server — no standalone SSE stream.
    res.writeHead(405, { allow: "POST, DELETE" });
    res.end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST, DELETE" });
    res.end();
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
    return;
  }

  const messages = Array.isArray(body) ? body : [body];
  const responses = (await Promise.all(messages.map((msg) => handleMessage(msg, req.headers)))).filter(Boolean);
  const sessionId = req.headers["mcp-session-id"] || randomUUID();
  const headers = {
    "mcp-session-id": String(sessionId),
    "mcp-protocol-version": "2025-03-26",
  };

  if (responses.length === 0) {
    res.writeHead(202, headers);
    res.end();
    return;
  }

  const payload = responses.length === 1 ? responses[0] : responses;
  const accept = String(req.headers.accept ?? "");
  if (accept.includes("text/event-stream") && !accept.includes("application/json")) {
    res.writeHead(200, { ...headers, "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const r of responses) {
      res.write(`event: message\ndata: ${JSON.stringify(r)}\n\n`);
    }
    res.end();
    return;
  }

  res.writeHead(200, { ...headers, "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}).listen(PORT, HOST, () => {
  console.log(`mcp-echo listening on ${HOST}:${PORT}`);
});
