import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

/**
 * `resolveWithinRoot` (packages/providers/src/tools.ts) only stops an
 * agent from escaping *below* whatever root it's given — it says nothing
 * about which root is allowed in the first place. Without this
 * allowlist, an open self-signup account could point fileAccessRoot at
 * `/etc`, the app's own deploy directory, or anywhere else on the
 * worker's filesystem and read it back through the read_file tool. Found
 * in security review; see PLAN.md.
 *
 * Secure by default: if the operator hasn't set ALLOWED_FILE_ACCESS_ROOTS,
 * no fileAccessRoot is permitted at all, rather than defaulting open.
 */
function getAllowedRoots(): string[] {
  const raw = process.env.ALLOWED_FILE_ACCESS_ROOTS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function isWithinAnAllowedRoot(candidate: string): boolean {
  const resolvedCandidate = resolve(candidate);
  return getAllowedRoots().some((root) => {
    const resolvedRoot = resolve(root);
    const rel = relative(resolvedRoot, resolvedCandidate);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

export const fileAccessRootSchema = z
  .string()
  .refine((p) => p.startsWith("/"), "fileAccessRoot must be an absolute path")
  .refine(
    isWithinAnAllowedRoot,
    "fileAccessRoot must be within an operator-configured root (see ALLOWED_FILE_ACCESS_ROOTS)",
  );

/**
 * A separate, independent allowlist from ALLOWED_FILE_ACCESS_ROOTS — a
 * node having read access to a path must never imply write access to it.
 * This is the save-time check (rejects the node config outright with a
 * clear error); packages/providers/src/tools.ts additionally re-checks
 * ALLOWED_FILE_WRITE_ROOTS at tool-resolution time on every run, since
 * unlike read access, write access shouldn't keep working forever after
 * an operator tightens the allowlist post-creation.
 */
function getAllowedWriteRoots(): string[] {
  const raw = process.env.ALLOWED_FILE_WRITE_ROOTS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function isWithinAnAllowedWriteRoot(candidate: string): boolean {
  const resolvedCandidate = resolve(candidate);
  return getAllowedWriteRoots().some((root) => {
    const resolvedRoot = resolve(root);
    const rel = relative(resolvedRoot, resolvedCandidate);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

const WRITE_TOOL_NAMES = ["write_file", "edit_file"];

/**
 * A cross-field check, not a per-field zod schema: whether write access
 * is required depends on `tools`, and `fileAccessRoot` may not be
 * present in the SAME request body for a PATCH (it's a partial update —
 * the effective value could come from the already-stored row). Callers
 * are responsible for resolving the effective (post-merge, for PATCH)
 * values before calling this — see graphs.ts/quickAdd.ts call sites.
 * Returns an error message, or null if the config is fine.
 */
export function checkWriteRootAllowed(tools: string[] | undefined, fileAccessRoot: string | null | undefined): string | null {
  const wantsWrite = tools?.some((t) => WRITE_TOOL_NAMES.includes(t));
  if (!wantsWrite) return null;
  if (!fileAccessRoot) {
    return "fileAccessRoot is required when tools includes write_file/edit_file";
  }
  if (!isWithinAnAllowedWriteRoot(fileAccessRoot)) {
    return "fileAccessRoot must be within an operator-configured write root (see ALLOWED_FILE_WRITE_ROOTS) for a node with write_file/edit_file enabled";
  }
  return null;
}
