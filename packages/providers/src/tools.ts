import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { tool, type Tool } from "ai";
import { z } from "zod";

export type ToolName = "current_time" | "calculator" | "pc_telemetry";
export const FILE_TOOL_NAMES = ["read_file", "list_directory", "search_knowledge"] as const;
export const WRITE_TOOL_NAMES = ["write_file", "edit_file"] as const;

/**
 * v1: a small built-in registry, not dynamic npm-package loading. Loading
 * arbitrary third-party packages by name from DB config would let anyone
 * who can edit a graph run arbitrary code in the API process — a real
 * security boundary, not just a scope decision. A future version should
 * sandbox that (separate worker process/container per tool) before
 * allowing user-supplied plugins; see PLAN.md.
 *
 * Typed as Record<ToolName, Tool> rather than left inferred: an inferred
 * type here can't be named portably in the emitted .d.ts (it reaches into
 * pnpm's isolated store paths), which breaks consumers' typechecking.
 */
const registry: Record<ToolName, Tool> = {
  current_time: tool({
    description: "Get the current UTC date and time.",
    inputSchema: z.object({}),
    execute: async () => ({ utc: new Date().toISOString() }),
  }),
  calculator: tool({
    description: "Evaluate a basic arithmetic expression (+ - * / and parentheses only).",
    inputSchema: z.object({ expression: z.string() }),
    execute: async ({ expression }) => {
      // Whitelist enforced before Function() ever sees the string: only
      // digits/operators/parens/whitespace can appear, so there is no way
      // to reach an identifier or function call through this expression.
      if (!/^[0-9+\-*/(). \s]+$/.test(expression)) {
        throw new Error("Expression contains disallowed characters");
      }
      const result = Function(`"use strict"; return (${expression});`)();
      return { result };
    },
  }),
  /**
   * Read-only by construction: this only ever sends {subscribe: channel}
   * to linux-command-centre's local WebSocket stream (thermal/battery),
   * which itself only pushes sensor readings — there is no message this
   * tool can send that triggers a write/control action. The actual
   * control surface (systemctl, apt, firewall, user management, etc.)
   * goes through a separate privileged helper gated by an interactive
   * Polkit prompt and is deliberately NOT wired up here — see PLAN.md for
   * the risk reasoning.
   */
  pc_telemetry: tool({
    description:
      "Read current PC hardware telemetry (thermal: CPU temps/fan RPM/turbo state, or battery: charge level/status) from a locally running linux-command-centre instance. Read-only.",
    inputSchema: z.object({ channel: z.enum(["thermal", "battery"]) }),
    execute: async ({ channel }) => {
      const wsUrl = process.env.PC_TELEMETRY_WS_URL ?? "ws://127.0.0.1:52341";
      return new Promise((resolvePromise, reject) => {
        let settled = false;
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          ws.close();
          reject(new Error(`Timed out waiting for "${channel}" telemetry from ${wsUrl} — is linux-command-centre running?`));
        }, 5000);

        ws.addEventListener("open", () => ws.send(JSON.stringify({ subscribe: channel })));
        ws.addEventListener("message", (event) => {
          if (settled) return;
          try {
            const msg = JSON.parse(String(event.data));
            if (msg.channel === channel) {
              settled = true;
              clearTimeout(timeout);
              ws.close();
              resolvePromise(msg.data);
            }
          } catch {
            // ignore malformed frames
          }
        });
        ws.addEventListener("error", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`Could not reach linux-command-centre telemetry at ${wsUrl}`));
        });
      });
    },
  }),
};

/**
 * Resolves a relative path against `root` and rejects anything that
 * escapes it lexically (via "..", an absolute-looking segment, etc.).
 * That alone is NOT sufficient: a symlink inside `root` whose target
 * points outside it would let the OS follow it to wherever it points
 * despite the string-level check passing — always a latent gap for
 * read_file (information disclosure), but a much higher-severity one now
 * that write tools exist (arbitrary write onto a live project). So after
 * the lexical check, walk up from the target to the nearest ancestor that
 * actually exists (the target itself for a read; a not-yet-created
 * file's parent-or-higher for a write) and verify ITS real path
 * (symlinks resolved) is still within root's real path.
 */
async function resolveWithinRoot(root: string, relativePath: string): Promise<string> {
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path "${relativePath}" escapes the allowed root`);
  }

  const realRoot = await realpath(root);
  let probe = target;
  for (;;) {
    try {
      const real = await realpath(probe);
      const realRel = relative(realRoot, real);
      if (realRel.startsWith("..") || isAbsolute(realRel)) {
        throw new Error(`Path "${relativePath}" escapes the allowed root via a symlink`);
      }
      return target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = dirname(probe);
      if (parent === probe) throw new Error(`Path "${relativePath}" escapes the allowed root`);
      probe = parent;
    }
  }
}

const MAX_FILE_READ_BYTES = 50_000;
const MAX_FILE_WRITE_BYTES = 200_000;

const SEARCH_SKIP_DIRS = new Set(["node_modules", ".git", ".openbots", "dist", "build", ".next", "coverage", "vendor"]);
const SEARCH_TEXT_EXT = new Set([
  ".md",
  ".txt",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".py",
  ".go",
  ".rs",
  ".yml",
  ".yaml",
  ".html",
  ".css",
  ".csv",
]);
const SEARCH_MAX_FILES = 80;
const SEARCH_MAX_FILE_BYTES = 64_000;
const SEARCH_CHUNK = 800;
const SEARCH_TOP_K = 8;

function tokenizeQuery(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2),
  );
}

function overlapScore(query: Set<string>, text: string): number {
  if (query.size === 0) return 0;
  const tokens = tokenizeQuery(text);
  let n = 0;
  for (const t of query) if (tokens.has(t)) n++;
  return n;
}

interface KnowledgeHit {
  path: string;
  score: number;
  excerpt: string;
}

async function walkTextFiles(root: string): Promise<{ rel: string; content: string }[]> {
  const realRoot = await realpath(root);
  const out: { rel: string; content: string }[] = [];

  async function visit(dir: string): Promise<void> {
    if (out.length >= SEARCH_MAX_FILES) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= SEARCH_MAX_FILES) return;
      if (SEARCH_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = entry.name.includes(".") ? entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase() : "";
      if (!SEARCH_TEXT_EXT.has(ext)) continue;
      let real: string;
      try {
        real = await realpath(full);
      } catch {
        continue;
      }
      const relToRoot = relative(realRoot, real);
      if (relToRoot.startsWith("..") || isAbsolute(relToRoot)) continue;
      let content: string;
      try {
        const info = await stat(real);
        if (info.size > SEARCH_MAX_FILE_BYTES) continue;
        content = await readFile(real, "utf8");
      } catch {
        continue;
      }
      out.push({ rel: relToRoot, content });
    }
  }

  await visit(realRoot);
  return out;
}

function chunkContent(content: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += SEARCH_CHUNK) {
    chunks.push(content.slice(i, i + SEARCH_CHUNK));
  }
  return chunks;
}

/**
 * A dedicated opt-in key, not the ambient OPENAI_API_KEY — that var may be
 * set only so some unrelated node can use GPT as a fallback model
 * provider, with zero connection to "is it OK to send this root's file
 * excerpts to OpenAI's embeddings endpoint." Every other tool that talks
 * to a third party (mcp, run_remote_command, dispatch_to_graph) requires
 * its own explicit config; this is that config for search_knowledge.
 */
async function embedRerank(query: string, hits: KnowledgeHit[]): Promise<KnowledgeHit[]> {
  const key = process.env.SEARCH_KNOWLEDGE_EMBEDDING_API_KEY;
  if (!key || hits.length === 0) return hits;
  try {
    const { embed, embedMany } = await import("ai");
    const { createOpenAI } = await import("@ai-sdk/openai");
    const model = createOpenAI({ apiKey: key }).embedding("text-embedding-3-small");
    const q = await embed({ model, value: query });
    const docs = await embedMany({ model, values: hits.map((h) => h.excerpt) });
    const qv = q.embedding;
    const reranked = hits.map((h, i) => {
      const dv = docs.embeddings[i] ?? [];
      let dot = 0;
      let qn = 0;
      let dn = 0;
      for (let j = 0; j < qv.length; j++) {
        const a = qv[j] ?? 0;
        const b = dv[j] ?? 0;
        dot += a * b;
        qn += a * a;
        dn += b * b;
      }
      const cosine = qn && dn ? dot / (Math.sqrt(qn) * Math.sqrt(dn)) : 0;
      return { ...h, score: cosine * 0.7 + h.score * 0.3 };
    });
    reranked.sort((a, b) => b.score - a.score);
    return reranked;
  } catch {
    return hits;
  }
}

async function searchKnowledge(root: string, query: string, subpath: string): Promise<{ query: string; hits: KnowledgeHit[] }> {
  const start = await resolveWithinRoot(root, subpath);
  const files = await walkTextFiles(start);
  const qTokens = tokenizeQuery(query);
  const hits: KnowledgeHit[] = [];
  for (const file of files) {
    for (const chunk of chunkContent(file.content)) {
      const score = overlapScore(qTokens, chunk);
      if (score <= 0) continue;
      hits.push({ path: file.rel, score, excerpt: chunk.trim() });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, SEARCH_TOP_K);
  return { query, hits: await embedRerank(query, top) };
}

/** Built fresh per node, bound to that node's fileAccessRoot — never shared across nodes with different roots. */
function createFileTools(root: string): Record<(typeof FILE_TOOL_NAMES)[number], Tool> {
  return {
    list_directory: tool({
      description: `List files and directories at a path relative to ${root}. Cannot see outside this root.`,
      inputSchema: z.object({ path: z.string().default(".") }),
      execute: async ({ path }) => {
        const target = await resolveWithinRoot(root, path);
        const entries = await readdir(target, { withFileTypes: true });
        return entries.map((e: Dirent) => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" }));
      },
    }),
    read_file: tool({
      description: `Read a text file's contents by path relative to ${root}. Cannot see outside this root. Read-only.`,
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        const target = await resolveWithinRoot(root, path);
        const info = await stat(target);
        if (!info.isFile()) throw new Error(`${path} is not a file`);
        const content = await readFile(target, "utf8");
        return { content: content.slice(0, MAX_FILE_READ_BYTES), truncated: content.length > MAX_FILE_READ_BYTES };
      },
    }),
    search_knowledge: tool({
      description: `Search text files under ${root} for a query and return the top matching excerpts with paths. Read-only. Cannot see outside this root. Prefer this over reading every file when you need to find something in the folder.${
        process.env.SEARCH_KNOWLEDGE_EMBEDDING_API_KEY
          ? " The operator has enabled OpenAI embedding rerank: matched excerpts (not full files) are sent to OpenAI's embeddings API to improve ranking."
          : ""
      }`,
      inputSchema: z.object({
        query: z.string().min(1),
        path: z.string().default(".").describe("Subdirectory relative to the root, default the whole root"),
      }),
      execute: async ({ query, path }) => searchKnowledge(root, query, path),
    }),
  };
}

/**
 * Write tools operate against an isolated git worktree (see
 * gitWorktree.ts), never the repo's main checkout — `root` here is
 * already that worktree's path by the time this is called, substituted
 * in by the caller (engine.ts), not the node's raw fileAccessRoot.
 * `touchedFiles` is a shared, mutable set the caller inspects after the
 * model call finishes to decide whether/what to commit — one commit per
 * hop, not one per tool call (see docs/orchestration.md).
 */
function createWriteTools(root: string, touchedFiles: Set<string>): Record<(typeof WRITE_TOOL_NAMES)[number], Tool> {
  return {
    write_file: tool({
      description: `Create or overwrite a file by path relative to ${root}. Cannot escape this root. Creates parent directories as needed.`,
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => {
        if (Buffer.byteLength(content, "utf8") > MAX_FILE_WRITE_BYTES) {
          throw new Error(`Content exceeds the ${MAX_FILE_WRITE_BYTES}-byte write limit`);
        }
        const target = await resolveWithinRoot(root, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
        touchedFiles.add(target);
        return { written: true, path };
      },
    }),
    edit_file: tool({
      description: `Edit a file by path relative to ${root}, replacing an exact, unique occurrence of old_string with new_string. old_string must match exactly once — the edit is rejected (not guessed) if it matches zero or multiple times. Cannot escape this root.`,
      inputSchema: z.object({ path: z.string(), old_string: z.string(), new_string: z.string() }),
      execute: async ({ path, old_string, new_string }) => {
        const target = await resolveWithinRoot(root, path);
        const info = await stat(target);
        if (!info.isFile()) throw new Error(`${path} is not a file`);
        // The full, untruncated file — never gated by MAX_FILE_READ_BYTES.
        // A match that's unique in a truncated prefix but not in the
        // whole file must still be treated as ambiguous.
        const content = await readFile(target, "utf8");
        const occurrences = content.split(old_string).length - 1;
        if (occurrences === 0) throw new Error(`old_string not found in ${path}`);
        if (occurrences > 1) throw new Error(`old_string matches ${occurrences} times in ${path} — must match exactly once`);
        const updated = content.replace(old_string, new_string);
        if (Buffer.byteLength(updated, "utf8") > MAX_FILE_WRITE_BYTES) {
          throw new Error(`Resulting content exceeds the ${MAX_FILE_WRITE_BYTES}-byte write limit`);
        }
        await writeFile(target, updated, "utf8");
        touchedFiles.add(target);
        return { edited: true, path };
      },
    }),
  };
}

/**
 * Runtime backstop for write access, independent of (and in addition to)
 * whatever save-time validation the API layer does. Mirrors the exact
 * allowlist logic in apps/api/src/validation/fileAccessRoot.ts — kept as
 * a small duplicate here rather than an import, since packages/providers
 * must not depend on apps/api (wrong direction). Unlike the read
 * allowlist (checked only once, at node-save time), this is re-checked
 * every time tools are resolved: a node created while a path was
 * write-allowlisted must not keep silently writing to it forever after
 * an operator later tightens ALLOWED_FILE_WRITE_ROOTS.
 */
export function isWithinAllowedWriteRoot(candidate: string): boolean {
  const raw = process.env.ALLOWED_FILE_WRITE_ROOTS;
  if (!raw) return false;
  const allowedRoots = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const resolvedCandidate = resolve(candidate);
  return allowedRoots.some((root) => {
    const resolvedRoot = resolve(root);
    const rel = relative(resolvedRoot, resolvedCandidate);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

/**
 * `fileAccessRoot` must be set on the node AND the tool name must appear in
 * `toolNames` — naming "read_file" in a node's tool list alone grants
 * nothing without a configured root, and configuring a root alone grants
 * nothing without opting into the tool by name. Defense in depth against a
 * node accidentally getting file access from either field alone. The same
 * dual-gate applies to `write_file`/`edit_file`, additionally requiring
 * `writableRoot` (only ever set by the caller once a node has passed the
 * separate ALLOWED_FILE_WRITE_ROOTS check and had a worktree created —
 * see engine.ts::callAgent).
 */
export function resolveTools(
  toolNames: string[],
  options: { fileAccessRoot?: string; writableRoot?: string; touchedFiles?: Set<string> } = {},
): Record<string, Tool> {
  const resolved: Record<string, Tool> = {};

  for (const name of toolNames) {
    if (name in registry) resolved[name] = registry[name as ToolName];
  }

  if (options.fileAccessRoot) {
    const fileTools = createFileTools(options.fileAccessRoot);
    for (const name of FILE_TOOL_NAMES) {
      if (toolNames.includes(name)) resolved[name] = fileTools[name];
    }
  }

  if (options.writableRoot && options.touchedFiles && isWithinAllowedWriteRoot(options.writableRoot)) {
    const writeTools = createWriteTools(options.writableRoot, options.touchedFiles);
    for (const name of WRITE_TOOL_NAMES) {
      if (toolNames.includes(name)) resolved[name] = writeTools[name];
    }
  }

  return resolved;
}

export function listAvailableTools(): { name: string; description: string; requiresFileAccessRoot: boolean }[] {
  const staticTools = (Object.keys(registry) as ToolName[]).map((name) => ({
    name,
    description: typeof registry[name].description === "string" ? (registry[name].description as string) : "",
    requiresFileAccessRoot: false,
  }));
  const fileTools = FILE_TOOL_NAMES.map((name) => ({
    name,
    description:
      name === "read_file"
        ? "Read a text file within a configured root directory."
        : name === "list_directory"
          ? "List entries in a directory within a configured root."
          : "Search text files in a configured root and return ranked excerpts (lightweight RAG, not a vector database).",
    requiresFileAccessRoot: true,
  }));
  const writeTools = WRITE_TOOL_NAMES.map((name) => ({
    name,
    description:
      name === "write_file"
        ? "Create or overwrite a file within an isolated git worktree of a configured root directory."
        : "Edit a file within an isolated git worktree by exact, unique string replacement.",
    requiresFileAccessRoot: true,
  }));
  // dispatch_to_graph and business_metrics are apps/api-only tools (they
  // need db access and other apps/api internals this package must never
  // depend on — see orchestrator/dispatchTool.ts and
  // orchestrator/businessMetricsTool.ts) — listed here as metadata only,
  // for any future tool-picker UI, never constructed by resolveTools().
  const crossServiceTools = [
    {
      name: "mcp",
      description: "Call tools on operator-allowlisted remote MCP servers configured on this node.",
      requiresFileAccessRoot: false,
    },
    {
      name: "dispatch_to_graph",
      description: "Agent-as-tool: start a run in another graph you own and block for its real result, bounded by a timeout.",
      requiresFileAccessRoot: false,
    },
    {
      name: "business_metrics",
      description: "Read real conversion/revenue/traffic numbers for a configured property.",
      requiresFileAccessRoot: false,
    },
    {
      name: "check_dispatch_status",
      description: "Check the status/result of a run you previously started with dispatch_to_graph.",
      requiresFileAccessRoot: false,
    },
    {
      name: "list_target_graph",
      description: "List the nodes and routing edges of one of your target graphs.",
      requiresFileAccessRoot: false,
    },
    {
      name: "create_target_node",
      description: "Create a new agent node in one of your target graphs.",
      requiresFileAccessRoot: false,
    },
    {
      name: "update_target_node",
      description: "Update an existing agent node in one of your target graphs.",
      requiresFileAccessRoot: false,
    },
    {
      name: "delete_target_node",
      description: "Delete an agent node from one of your target graphs.",
      requiresFileAccessRoot: false,
    },
    {
      name: "create_target_edge",
      description: "Create a routing edge between two nodes in one of your target graphs.",
      requiresFileAccessRoot: false,
    },
    {
      name: "delete_target_edge",
      description: "Delete a routing edge between two nodes in one of your target graphs.",
      requiresFileAccessRoot: false,
    },
    {
      name: "run_remote_command",
      description: "Run one of your pre-approved commands on a configured SSH host, by label only.",
      requiresFileAccessRoot: false,
    },
  ];
  return [...staticTools, ...fileTools, ...writeTools, ...crossServiceTools];
}
