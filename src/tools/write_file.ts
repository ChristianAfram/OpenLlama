/**
 * write_file — Level 3, low-risk reversible write.
 *
 * Creates a NEW file only. It refuses to overwrite an existing file (that is an
 * edit_file, Level 4, which arrives in Prompt 6). As a MutatingTool it never
 * touches the world in `plan()` — it computes the change and its blob hashes,
 * and hands the executor an `apply()` thunk that the executor runs only after a
 * confirmed audit write.
 *
 * Rollback: delete the created file.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { resolveWithinRepo } from "./paths.js";
import type { MutatingTool, ToolDescriptor } from "./registry.js";

const schema = z.object({
  path: z.string().min(1).describe("Repo-relative path of the NEW file to create"),
  content: z.string().describe("Full contents to write to the new file"),
});

export const writeFileDescriptor: ToolDescriptor = {
  name: "write_file",
  description:
    "Create a NEW file with the given contents. Refuses to overwrite an existing file.",
  permission_level: 3,
  risk_level: "low",
  allowed_paths: ["${REPO_ROOT}/**"],
  denied_paths: ["**/.env*", "**/.git/**", "**/secrets/**", "**/.github/workflows/**"],
  requires_approval: false,
  audit_required: true,
  rate_limit: "60/min",
  rollback: "delete_created_file",
};

export const writeFileTool: MutatingTool<z.infer<typeof schema>> = {
  descriptor: writeFileDescriptor,
  schema,
  plan(args, ctx) {
    const abs = resolveWithinRepo(ctx.repoRoot, args.path);
    if (existsSync(abs)) {
      throw new Error(
        `refusing to overwrite existing file "${args.path}": write_file creates new files only (use edit_file, Level 4)`,
      );
    }
    const afterHash = "sha256:" + createHash("sha256").update(args.content).digest("hex");

    return {
      target: args.path,
      data_changed: [{ path: args.path, before_hash: null, after_hash: afterHash }],
      rollback_path: `delete ${args.path}`,
      reversal: { kind: "delete_created_file", path: args.path },
      summary: `created new file ${args.path} (${String(Buffer.byteLength(args.content))} bytes)`,
      apply: () => {
        // Re-check at apply time to avoid a TOCTOU overwrite if the file
        // appeared between plan and apply.
        if (existsSync(abs)) {
          throw new Error(`file appeared before write: ${args.path}`);
        }
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, args.content, { flag: "wx" });
      },
    };
  },
};
