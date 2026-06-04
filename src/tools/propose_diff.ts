/**
 * propose_diff — Level 1, draft only.
 *
 * Produces a unified diff between a file's current contents (or empty, for a
 * new file) and the model's proposed new contents. **Writes nothing.** This is
 * how the agent proposes a change for a human to review; actually applying it
 * is a Level 3/4 write tool that arrives in Prompts 3 and 6.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { resolveWithinRepo } from "./paths.js";
import { unifiedDiff } from "../lib/diff.js";
import type { Tool, ToolDescriptor } from "./registry.js";

const schema = z.object({
  path: z.string().min(1).describe("Repo-relative path the change targets"),
  new_content: z.string().describe("The full proposed new contents of the file"),
});

export const proposeDiffDescriptor: ToolDescriptor = {
  name: "propose_diff",
  description:
    "Propose a change to a file as a unified diff. Writes nothing — produces a reviewable proposal only.",
  permission_level: 1,
  risk_level: "low",
  allowed_paths: ["${REPO_ROOT}/**"],
  denied_paths: ["**/.env*", "**/secrets/**", "**/.git/**", "**/.github/workflows/**"],
  requires_approval: false,
  audit_required: true,
  rate_limit: "120/min",
  rollback: "n/a",
};

export const proposeDiffTool: Tool<z.infer<typeof schema>> = {
  descriptor: proposeDiffDescriptor,
  schema,
  execute(args, ctx) {
    const abs = resolveWithinRepo(ctx.repoRoot, args.path);

    let oldContent = "";
    let isNew = true;
    if (existsSync(abs) && statSync(abs).isFile()) {
      oldContent = readFileSync(abs, "utf8");
      isNew = false;
    }

    const diff = unifiedDiff(
      oldContent,
      args.new_content,
      isNew ? "/dev/null" : `a/${args.path}`,
      `b/${args.path}`,
    );

    const output =
      diff === ""
        ? `(no change — proposed content is identical to ${args.path})`
        : diff;

    return {
      ok: true,
      output,
      data: { path: args.path, isNew, changed: diff !== "" },
      audit: { target: args.path, data_read: isNew ? [] : [args.path] },
    };
  },
};
