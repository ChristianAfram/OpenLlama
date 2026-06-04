/**
 * read_file — Level 0, read-only.
 *
 * Reads a UTF-8 file confined to the repo root (secret paths denied). Returns
 * the contents to the model. Logged, never gated.
 */

import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { resolveWithinRepo } from "./paths.js";
import type { Tool, ToolDescriptor } from "./registry.js";

const MAX_BYTES = 256 * 1024; // cap to avoid blowing the model context

const schema = z.object({
  path: z.string().min(1).describe("Repo-relative path of the file to read"),
});

export const readFileDescriptor: ToolDescriptor = {
  name: "read_file",
  description: "Read the contents of a file within the repository.",
  permission_level: 0,
  risk_level: "low",
  allowed_paths: ["${REPO_ROOT}/**"],
  denied_paths: ["**/.env*", "**/.git/config", "**/secrets/**", "**/.github/workflows/**"],
  requires_approval: false,
  audit_required: true,
  rate_limit: "240/min",
  rollback: "n/a",
};

export const readFileTool: Tool<z.infer<typeof schema>> = {
  descriptor: readFileDescriptor,
  schema,
  execute(args, ctx) {
    const abs = resolveWithinRepo(ctx.repoRoot, args.path);
    const stat = statSync(abs);
    if (!stat.isFile()) {
      return { ok: false, output: `not a file: ${args.path}` };
    }
    if (stat.size > MAX_BYTES) {
      return {
        ok: false,
        output: `file too large (${String(stat.size)} bytes > ${String(MAX_BYTES)} cap): ${args.path}`,
      };
    }
    const content = readFileSync(abs, "utf8");
    return {
      ok: true,
      output: content,
      data: { path: args.path, bytes: stat.size },
      audit: { target: args.path, data_read: [args.path] },
    };
  },
};
