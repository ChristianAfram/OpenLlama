/**
 * git — Level 4/5 git operations.
 *
 * Operations and their levels:
 *
 *   commit  L4  — stages tracked files and creates a commit
 *   push    L5  — pushes a branch to the remote (classifier also catches this)
 *   status  L0  — read-only, re-exported via read_file / grep; here for
 *                 convenience, treated as a non-mutating plan with a no-op apply
 *
 * Force-push is ALWAYS refused at the tool layer (classifier also raises it to
 * L5 via the DESTRUCTIVE_COMMAND rule, but belt-and-suspenders here).
 *
 * The apply() thunk returns the git command's stdout so the model sees the
 * actual commit hash / remote ref line.
 *
 * Rollback: git reset --hard <before_sha> (commit); git push --force-with-lease
 * to the before_sha (push, operator-manual).
 */

import { execSync } from "node:child_process";
import { z } from "zod";
import type { MutatingTool, ToolDescriptor } from "./registry.js";

const operationSchema = z.union([
  z.object({
    operation: z.literal("commit"),
    message: z.string().min(1).describe("Commit message"),
    paths: z
      .array(z.string().min(1))
      .optional()
      .describe("Repo-relative paths to stage; omit to stage all tracked changes"),
  }),
  z.object({
    operation: z.literal("push"),
    remote: z.string().default("origin").describe("Remote name (default: origin)"),
    branch: z.string().min(1).describe("Branch to push"),
    force: z.literal(false).optional().describe("Force-push is always refused"),
  }),
  z.object({
    operation: z.literal("status"),
  }),
]);

type GitArgs = z.infer<typeof operationSchema>;

export const gitDescriptor: ToolDescriptor = {
  name: "git",
  description: "Run a scoped git operation (commit, push, status). Force-push is always refused.",
  permission_level: 4,
  risk_level: "high",
  allowed_paths: ["${REPO_ROOT}/**"],
  denied_paths: [],
  requires_approval: true,
  audit_required: true,
  rate_limit: "20/min",
  rollback: "git_reset_or_operator_manual",
};

export const gitTool: MutatingTool<GitArgs> = {
  descriptor: gitDescriptor,
  schema: operationSchema,
  plan(args, ctx) {
    switch (args.operation) {
      case "status": {
        return {
          target: "git:status",
          data_changed: [],
          rollback_path: "n/a",
          summary: "git status (read-only)",
          apply: () => {
            return execSync("git status --short", {
              cwd: ctx.repoRoot,
              encoding: "utf8",
              stdio: ["pipe", "pipe", "pipe"],
            }).trimEnd() || "(clean)";
          },
        };
      }

      case "commit": {
        const beforeSha = getHeadSha(ctx.repoRoot);
        const pathsDisplay = args.paths?.join(", ") ?? "(all tracked changes)";

        return {
          target: `git:commit`,
          data_changed: [],
          rollback_path: `git reset --hard ${beforeSha}`,
          summary: `git commit: "${args.message}" — staged ${pathsDisplay}`,
          apply: () => {
            if (args.paths && args.paths.length > 0) {
              const escaped = args.paths.map((p) => shellQuote(p)).join(" ");
              execSync(`git add -- ${escaped}`, {
                cwd: ctx.repoRoot,
                encoding: "utf8",
                stdio: ["pipe", "pipe", "pipe"],
              });
            } else {
              execSync("git add -u", {
                cwd: ctx.repoRoot,
                encoding: "utf8",
                stdio: ["pipe", "pipe", "pipe"],
              });
            }
            const out = execSync(
              `git commit --message ${shellQuote(args.message)}`,
              {
                cwd: ctx.repoRoot,
                encoding: "utf8",
                stdio: ["pipe", "pipe", "pipe"],
              },
            );
            return out.trimEnd();
          },
        };
      }

      case "push": {
        if (args.force === false) {
          // Literal false: belt-and-suspenders since the schema rejects anything
          // truthy, but be explicit.
        }
        // Extra guard: refuse common force-push spellings in the branch arg.
        const branchLower = args.branch.toLowerCase();
        if (branchLower.includes("--force") || branchLower.includes("-f")) {
          throw new Error("force-push is never permitted through the git tool");
        }

        const remote = args.remote;
        const branch = args.branch;

        return {
          target: `git:push:${remote}/${branch}`,
          data_changed: [],
          rollback_path: "operator manual: git push --force-with-lease to prior sha",
          summary: `git push ${remote} ${branch}`,
          apply: () => {
            const out = execSync(`git push ${shellQuote(remote)} ${shellQuote(branch)}`, {
              cwd: ctx.repoRoot,
              encoding: "utf8",
              stdio: ["pipe", "pipe", "pipe"],
            });
            return out.trimEnd() || `pushed ${branch} to ${remote}`;
          },
        };
      }
    }
  },
};

function getHeadSha(repoRoot: string): string {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "unknown";
  }
}

/** Minimal shell quoting — wraps in single quotes, escaping embedded singles. */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
