#!/usr/bin/env node
/**
 * OpenCLI CLI entry point.
 *
 * Registers the public v0.7 command surface.
 * Mutating operations are reachable only through kernel-gated commands such as
 * agent and exec. The executor enforces the no-audit-no-action invariant before
 * any side effect runs.
 */

import { Command } from "commander";
import { VERSION } from "./version.js";
import { registerAgentCommand } from "./commands/agent.js";
import { registerAuditCommand } from "./commands/audit.js";
import { registerChatCommand } from "./commands/chat.js";
import { registerEvalCommand } from "./commands/eval.js";
import { registerExecCommand } from "./commands/exec.js";
import { registerKillSwitchCommand } from "./commands/kill-switch.js";
import { registerPolicyCommand } from "./commands/policy.js";
import { registerSessionCommand } from "./commands/session.js";

const program = new Command();

program
  .name("opencli")
  .description(
    "Local-first, governance-native AI coding CLI. " +
      "No tool that mutates the world runs unless an audit write succeeds first.",
  )
  .version(VERSION);

registerAgentCommand(program);
registerAuditCommand(program);
registerChatCommand(program);
registerEvalCommand(program);
registerExecCommand(program);
registerKillSwitchCommand(program);
registerPolicyCommand(program);
registerSessionCommand(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`fatal: ${message}\n`);
  process.exitCode = 1;
});
