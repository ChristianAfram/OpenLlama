#!/usr/bin/env node
/**
 * OpenLlama CLI entry point.
 *
 * Registers commands against the commander program. Prompt 0 ships a single
 * read-only command (`chat`). The governance kernel and mutating tools are
 * added in subsequent prompts; nothing here can touch the world yet.
 */

import { Command } from "commander";
import { registerAgentCommand } from "./commands/agent.js";
import { registerAuditCommand } from "./commands/audit.js";
import { registerChatCommand } from "./commands/chat.js";
import { registerEvalCommand } from "./commands/eval.js";
import { registerExecCommand } from "./commands/exec.js";
import { registerPolicyCommand } from "./commands/policy.js";

const program = new Command();

program
  .name("openllama")
  .description(
    "Local-first, governance-native AI coding agent. " +
      "No tool that mutates the world runs unless an audit write succeeds first.",
  )
  .version("0.1.0-pre.0");

registerAgentCommand(program);
registerAuditCommand(program);
registerChatCommand(program);
registerEvalCommand(program);
registerExecCommand(program);
registerPolicyCommand(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`fatal: ${message}\n`);
  process.exitCode = 1;
});
