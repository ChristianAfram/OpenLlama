/**
 * edit_file — Level 4, requires approval.
 *
 * Edits an EXISTING file by replacing an exact string with a new string. The
 * file must exist and the `old_string` must appear exactly once in it —
 * ambiguous replacements are refused. As a MutatingTool, `plan()` reads and
 * hashes the file without writing; the executor applies only after audit.
 *
 * Rollback: restore the before-content (recorded in the audit event).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { resolveWithinRepo } from "./paths.js";
import type { MutatingTool, ToolDescriptor } from "./registry.js";

const schema = z.object({
  path: z.string().min(1).describe("Repo-relative path of the file to edit"),
  old_string: z.string().min(1).describe("Exact text to replace — must appear exactly once"),
  new_string: z.string().describe("Replacement text"),
});

export const editFileDescriptor: ToolDescriptor = {
  name: "edit_file",
  description:
    "Edit an existing file by replacing an exact string. The old_string must appear exactly once.",
  permission_level: 4,
  risk_level: "high",
  allowed_paths: ["${REPO_ROOT}/**"],
  denied_paths: ["**/.env*", "**/.git/**", "**/secrets/**", "**/.github/workflows/**"],
  requires_approval: true,
  audit_required: true,
  rate_limit: "30/min",
  rollback: "restore_before_content",
};

export const editFileTool: MutatingTool<z.infer<typeof schema>> = {
  descriptor: editFileDescriptor,
  schema,
  plan(args, ctx) {
    const abs = resolveWithinRepo(ctx.repoRoot, args.path);

    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw new Error(`file does not exist: ${args.path}`);
    }

    const before = readFileSync(abs, "utf8");
    const occurrences = countOccurrences(before, args.old_string);
    if (occurrences === 0) {
      throw new Error(`old_string not found in ${args.path}`);
    }
    if (occurrences > 1) {
      throw new Error(
        `old_string appears ${String(occurrences)} times in ${args.path} — must be unique`,
      );
    }

    const after = before.replace(args.old_string, args.new_string);
    const beforeHash = "sha256:" + createHash("sha256").update(before).digest("hex");
    const afterHash = "sha256:" + createHash("sha256").update(after).digest("hex");

    const added = countLines(args.new_string) - countLines(args.old_string);
    const changeDesc = added > 0 ? `+${String(added)} lines` : added < 0 ? `${String(added)} lines` : "same line count";

    return {
      target: args.path,
      data_changed: [{ path: args.path, before_hash: beforeHash, after_hash: afterHash }],
      rollback_path: `restore ${args.path} from audit event before_hash=${beforeHash}`,
      reversal: {
        kind: "restore_file",
        path: args.path,
        before_content: before,
        before_hash: beforeHash,
        after_hash: afterHash,
      },
      summary: `edited ${args.path} (${changeDesc})`,
      apply: () => {
        // Re-read at apply time; if the file changed between plan and apply,
        // the replacement would be wrong — refuse rather than corrupt.
        const current = readFileSync(abs, "utf8");
        if (current !== before) {
          throw new Error(`${args.path} changed between plan and apply; aborting edit`);
        }
        writeFileSync(abs, after, "utf8");
      },
    };
  },
};

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

function countLines(s: string): number {
  return (s.match(/\n/g) ?? []).length;
}
