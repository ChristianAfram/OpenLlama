/**
 * run_shell — Level 4, requires approval.
 *
 * Runs a non-destructive shell command inside the repo root. The classifier
 * independently enforces that commands containing destructive tokens (rm -rf,
 * dd if=, etc.) are raised to Level 5, which the executor blocks unless an L5
 * grant + confirmation phrase is supplied. This layer is defence-in-depth: we
 * also refuse a hard-coded denylist here.
 *
 * The `apply()` thunk returns stdout as the summary so the model sees real
 * output rather than a generic "executed" message.
 *
 * Rollback: commands are assumed non-reversible; the audit event records what
 * ran so the operator can manually inspect or undo.
 */

import { execSync } from "node:child_process";
import { z } from "zod";
import type { MutatingTool, ToolDescriptor } from "./registry.js";

const schema = z.object({
  command: z.string().min(1).describe("Shell command to run inside the repository root"),
  timeout_ms: z
    .number()
    .int()
    .min(100)
    .max(60_000)
    .optional()
    .default(15_000)
    .describe("Timeout in milliseconds (100–60000, default 15000)"),
});

/** Tokens that the executor's classifier also catches — belt-and-suspenders. */
const LOCAL_DESTRUCTIVE_TOKENS = [
  "rm -rf",
  "rm -fr",
  "rm --recursive",
  "dd if=",
  "mkfs",
  ":(){:|:&};:",
  "fork bomb",
  "shred",
  "git clean -f",
  "git reset --hard",
];

export const runShellDescriptor: ToolDescriptor = {
  name: "run_shell",
  description:
    "Run a shell command inside the repository root. Non-destructive commands only; destructive tokens are blocked.",
  permission_level: 4,
  risk_level: "high",
  allowed_paths: ["${REPO_ROOT}/**"],
  denied_paths: [],
  requires_approval: true,
  audit_required: true,
  rate_limit: "20/min",
  rollback: "manual_inspection_required",
};

export const runShellTool: MutatingTool<z.infer<typeof schema>> = {
  descriptor: runShellDescriptor,
  schema,
  plan(args, ctx) {
    const lower = args.command.toLowerCase();
    const match = LOCAL_DESTRUCTIVE_TOKENS.find((tok) => lower.includes(tok));
    if (match) {
      throw new Error(
        `command contains destructive token "${match}" — use a safer alternative or request Level 5 approval`,
      );
    }

    return {
      target: `shell:${args.command}`,
      data_changed: [],
      rollback_path: "manual_inspection_required",
      summary: `run_shell: ${args.command}`,
      apply: () => {
        const stdout = execSync(args.command, {
          cwd: ctx.repoRoot,
          timeout: args.timeout_ms,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        return stdout.trimEnd() || "(no output)";
      },
    };
  },
};
