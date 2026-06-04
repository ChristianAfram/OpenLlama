/**
 * list_dir — Level 0, read-only.
 *
 * Lists the entries of a directory within the repo root.
 */

import { readdirSync } from "node:fs";
import { z } from "zod";
import { resolveWithinRepo } from "./paths.js";
import type { Tool, ToolDescriptor } from "./registry.js";

const schema = z.object({
  path: z
    .string()
    .default(".")
    .describe("Repo-relative directory to list (default: repo root)"),
});

export const listDirDescriptor: ToolDescriptor = {
  name: "list_dir",
  description: "List the files and subdirectories of a directory.",
  permission_level: 0,
  risk_level: "low",
  allowed_paths: ["${REPO_ROOT}/**"],
  denied_paths: ["**/.git/**"],
  requires_approval: false,
  audit_required: true,
  rate_limit: "240/min",
  rollback: "n/a",
};

export const listDirTool: Tool<z.infer<typeof schema>> = {
  descriptor: listDirDescriptor,
  schema,
  execute(args, ctx) {
    const abs = resolveWithinRepo(ctx.repoRoot, args.path);
    const entries = readdirSync(abs, { withFileTypes: true })
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    return {
      ok: true,
      output: entries.join("\n"),
      data: { path: args.path, entries },
      audit: { target: args.path, data_read: [args.path] },
    };
  },
};
