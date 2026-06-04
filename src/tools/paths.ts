/**
 * Path containment + denylist for path-bound tools.
 *
 * Even read-only tools confine themselves to the repo root and refuse to touch
 * secret paths (`.env`, `.git/config`, `secrets/`, CI workflow files). This is
 * defense-in-depth at the tool layer; the executor enforces the same descriptor
 * allow/deny lists for mutating tools in Prompt 4. Keeping it here means a
 * read_file can never be used to exfiltrate a `.env` even before the kernel
 * path-containment lands.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { isSecretPath } from "../lib/redaction.js";

export class PathDeniedError extends Error {
  override name = "PathDeniedError";
}

/** Fragments that are always denied, independent of the secret-path check. */
const ALWAYS_DENIED = [
  "/.git/",
  "/.github/workflows/",
];

/**
 * Resolve `target` against `repoRoot`, guaranteeing the result stays inside the
 * root and is not a denied/secret path. Throws PathDeniedError otherwise.
 */
export function resolveWithinRepo(repoRoot: string, target: string): string {
  const root = resolve(repoRoot);
  const abs = isAbsolute(target) ? resolve(target) : resolve(root, target);

  // After normalization, a relative path starting with ".." (or that is exactly
  // "..") climbed out of the root. An absolute `rel` means a different drive.
  const rel = relative(root, abs);
  if (rel === ".." || rel.startsWith(".." + "/") || isAbsolute(rel)) {
    throw new PathDeniedError(`path escapes repository root: ${target}`);
  }

  if (isSecretPath(abs)) {
    throw new PathDeniedError(`path is on the secret denylist: ${target}`);
  }
  const normalized = abs.replace(/\\/g, "/");
  if (ALWAYS_DENIED.some((frag) => (normalized + "/").includes(frag))) {
    throw new PathDeniedError(`path is denied: ${target}`);
  }

  return abs;
}
