import { readFile, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { tool, type Tool } from "ai";
import { z } from "zod";

export type ToolName = "current_time" | "calculator";
export const FILE_TOOL_NAMES = ["read_file", "list_directory"] as const;

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
};

/**
 * Resolves a relative path against `root` and rejects anything that
 * escapes it (via "..", a symlink-free absolute-looking segment, etc.) —
 * the actual security boundary for the file tools. `path.relative` gives
 * a string starting with ".." exactly when the target falls outside root.
 */
function resolveWithinRoot(root: string, relativePath: string): string {
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path "${relativePath}" escapes the allowed root`);
  }
  return target;
}

const MAX_FILE_READ_BYTES = 50_000;

/** Built fresh per node, bound to that node's fileAccessRoot — never shared across nodes with different roots. */
function createFileTools(root: string): Record<(typeof FILE_TOOL_NAMES)[number], Tool> {
  return {
    list_directory: tool({
      description: `List files and directories at a path relative to ${root}. Cannot see outside this root.`,
      inputSchema: z.object({ path: z.string().default(".") }),
      execute: async ({ path }) => {
        const target = resolveWithinRoot(root, path);
        const entries = await readdir(target, { withFileTypes: true });
        return entries.map((e: Dirent) => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" }));
      },
    }),
    read_file: tool({
      description: `Read a text file's contents by path relative to ${root}. Cannot see outside this root. Read-only.`,
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        const target = resolveWithinRoot(root, path);
        const info = await stat(target);
        if (!info.isFile()) throw new Error(`${path} is not a file`);
        const content = await readFile(target, "utf8");
        return { content: content.slice(0, MAX_FILE_READ_BYTES), truncated: content.length > MAX_FILE_READ_BYTES };
      },
    }),
  };
}

/**
 * `fileAccessRoot` must be set on the node AND the tool name must appear in
 * `toolNames` — naming "read_file" in a node's tool list alone grants
 * nothing without a configured root, and configuring a root alone grants
 * nothing without opting into the tool by name. Defense in depth against a
 * node accidentally getting file access from either field alone.
 */
export function resolveTools(
  toolNames: string[],
  options: { fileAccessRoot?: string } = {},
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
  return [...staticTools, ...fileTools];
}
