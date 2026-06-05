/**
 * `openllama exec <tool> --json '<args>'` — run a single tool through the kernel
 * without the model. A developer/demo affordance that exercises the exact gated
 * path: read/draft tools dispatch directly; mutating tools route through the
 * executor and the no-audit-no-action invariant. Every run is audited.
 */

import { resolve } from "node:path";
import { Command } from "commander";
import { error, info } from "../lib/ui.js";
import { buildDefaultRegistry } from "../tools/index.js";
import { dispatchTool, isMutatingTool } from "../tools/registry.js";
import { Executor } from "../kernel/executor.js";
import { CliApprovalProvider } from "../kernel/approval-cli.js";

interface ExecOptions {
  json?: string;
  cwd?: string;
  enterprise?: boolean;
}

export function registerExecCommand(program: Command): void {
  program
    .command("exec")
    .description("Run a single tool through the governance kernel (no model)")
    .argument("<tool>", "tool name, e.g. read_file or write_file")
    .option("--json <args>", "tool arguments as a JSON object", "{}")
    .option("--cwd <dir>", "repository root (default: current dir)")
    .option("--enterprise", "enterprise mode: policy violations are hard blocks")
    .action(async (toolName: string, options: ExecOptions) => {
      const repoRoot = resolve(options.cwd ?? process.cwd());
      const registry = buildDefaultRegistry();
      const tool = registry.get(toolName);
      if (!tool) {
        error(`unknown tool: ${toolName}`);
        process.exitCode = 1;
        return;
      }

      let args: unknown;
      try {
        args = JSON.parse(options.json ?? "{}");
      } catch (err) {
        error(`--json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }

      if (isMutatingTool(tool)) {
        const executor = new Executor();
        // A human at the terminal can approve L4/L5 actions interactively; the
        // provider denies automatically when stdin is not a TTY.
        const outcome = await executor.execute(tool, args, {
          ctx: { repoRoot },
          approvals: new CliApprovalProvider(),
          requested_by: "user:cli",
          ...(options.enterprise ? { enterprise: true } : {}),
        });
        switch (outcome.status) {
          case "executed":
            info(`✓ executed (audit ${outcome.event_id})`);
            process.stdout.write(`${outcome.summary}\nrollback: ${outcome.rollback_path}\n`);
            break;
          case "blocked":
            error(`blocked: ${outcome.reason}`);
            process.exitCode = 1;
            break;
          case "audit_failed":
            error(outcome.reason);
            process.exitCode = 1;
            break;
          case "apply_failed":
            error(`apply failed after audit: ${outcome.reason}`);
            process.exitCode = 1;
            break;
        }
        return;
      }

      // Read/draft tool.
      const outcome = await dispatchTool(registry, toolName, args, { ctx: { repoRoot } });
      switch (outcome.status) {
        case "ok":
          process.stdout.write(outcome.result.output + "\n");
          break;
        case "invalid_args":
          error(`invalid args: ${outcome.error}`);
          process.exitCode = 1;
          break;
        case "unknown_tool":
          error(outcome.error);
          process.exitCode = 1;
          break;
        case "error":
          error(outcome.error);
          process.exitCode = 1;
          break;
      }
    });
}
