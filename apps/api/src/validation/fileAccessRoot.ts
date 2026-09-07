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
