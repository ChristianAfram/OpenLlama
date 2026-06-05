/**
 * `openllama kill-switch` — manage the global halt for all mutating tools.
 *
 * When the kill switch is active, every attempt to execute a mutating tool
 * is blocked before any side effect runs.
 *
 *   openllama kill-switch status              # show current state
 *   openllama kill-switch activate [--reason] # activate the kill switch
 *   openllama kill-switch deactivate          # deactivate
 */

import { Command } from "commander";
import { getDefaultKillSwitch } from "../kernel/kill-switch.js";

export function registerKillSwitchCommand(program: Command): void {
  const ks = program
    .command("kill-switch")
    .description(
      "Manage the global kill switch that halts all mutating tools. " +
        "When active, no write, edit, shell, or git action can execute.",
    );

  ks.command("status")
    .description("Show the current kill-switch state")
    .action(() => {
      const state = getDefaultKillSwitch().getState();
      if (state.active) {
        process.stdout.write(
          `kill switch: ACTIVE\n` +
            `  triggered_by: ${state.triggered_by}\n` +
            `  activated_at: ${state.activated_at}\n` +
            `  reason: ${state.reason}\n`,
        );
        process.exitCode = 1; // non-zero so scripts can detect active state
      } else {
        process.stdout.write("kill switch: inactive\n");
      }
    });

  ks.command("activate")
    .description("Activate the kill switch — all mutating tools will be blocked")
    .option("-r, --reason <text>", "reason for activation", "manual activation")
    .action((opts: { reason: string }) => {
      const sw = getDefaultKillSwitch();
      sw.activate(opts.reason, "manual");
      process.stderr.write(`kill switch activated: ${opts.reason}\n`);
    });

  ks.command("deactivate")
    .description("Deactivate the kill switch — mutating tools will be allowed again")
    .action(() => {
      getDefaultKillSwitch().deactivate();
      process.stderr.write("kill switch deactivated\n");
    });
}
