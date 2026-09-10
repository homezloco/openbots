import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { tool, type Tool } from "ai";
import { z } from "zod";

export type ToolName = "current_time" | "calculator" | "pc_telemetry";
export const FILE_TOOL_NAMES = ["read_file", "list_directory"] as const;
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
    description: name === "read_file" ? "Read a text file within a configured root directory." : "List entries in a directory within a configured root.",
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
      name: "dispatch_to_graph",
      description: "Fire-and-forget: start a run in another graph you own, without waiting for its result.",
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
