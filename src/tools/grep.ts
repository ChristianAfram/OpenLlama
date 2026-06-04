/**
 * grep — Level 0, read-only.
 *
 * Searches file contents under a repo-relative root for a regex, returning
 * matching lines with file:line prefixes. Implemented in pure Node (no shelling
 * out — that would be run_shell, a higher permission level). Skips binary-ish
 * files, the .git directory, node_modules, and secret paths.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import { resolveWithinRepo, PathDeniedError } from "./paths.js";
import { isSecretPath } from "../lib/redaction.js";
import type { Tool, ToolDescriptor } from "./registry.js";

const MAX_MATCHES = 200;
const MAX_FILE_BYTES = 512 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage"]);

const schema = z.object({
  pattern: z.string().min(1).describe("Regular expression to search for"),
  path: z
    .string()
    .default(".")
    .describe("Repo-relative directory to search under (default: repo root)"),
  ignore_case: z.boolean().default(false).describe("Case-insensitive match"),
});

export const grepDescriptor: ToolDescriptor = {
  name: "grep",
  description: "Search file contents under a directory for a regular expression.",
  permission_level: 0,
  risk_level: "low",
  allowed_paths: ["${REPO_ROOT}/**"],
  denied_paths: ["**/.env*", "**/secrets/**", "**/.git/**"],
  requires_approval: false,
  audit_required: true,
  rate_limit: "120/min",
  rollback: "n/a",
};

export const grepTool: Tool<z.infer<typeof schema>> = {
  descriptor: grepDescriptor,
  schema,
  execute(args, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(args.pattern, args.ignore_case ? "i" : "");
    } catch (err) {
      return {
        ok: false,
        output: `invalid regex: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const root = resolveWithinRepo(ctx.repoRoot, args.path);
    const matches: string[] = [];
    walk(root, ctx.repoRoot, re, matches);

    const truncated = matches.length >= MAX_MATCHES;
    return {
      ok: true,
      output:
        matches.length === 0
          ? "(no matches)"
          : matches.slice(0, MAX_MATCHES).join("\n") +
            (truncated ? `\n… (truncated at ${String(MAX_MATCHES)} matches)` : ""),
      data: { count: matches.length, truncated },
      audit: { target: args.path, data_read: [args.path] },
    };
  },
};

function walk(dir: string, repoRoot: string, re: RegExp, matches: string[]): void {
  if (matches.length >= MAX_MATCHES) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (matches.length >= MAX_MATCHES) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, repoRoot, re, matches);
    } else if (entry.isFile()) {
      if (isSecretPath(full)) continue;
      searchFile(full, repoRoot, re, matches);
    }
  }
}

function searchFile(file: string, repoRoot: string, re: RegExp, matches: string[]): void {
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return;
    const content = readFileSync(file, "utf8");
    if (content.includes("\0")) return; // looks binary (NUL byte)
    const rel = relative(repoRoot, file);
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= MAX_MATCHES) return;
      if (re.test(lines[i]!)) {
        matches.push(`${rel}:${String(i + 1)}: ${lines[i]!.trim()}`);
      }
    }
  } catch (err) {
    if (err instanceof PathDeniedError) return;
    // Unreadable file — skip silently.
  }
}
