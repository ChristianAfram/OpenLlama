/**
 * `openllama audit` sub-commands.
 *
 *   audit show              – human-readable event timeline
 *   audit verify            – walk the hash chain and report the first break
 *   audit export [--siem]   – emit events as JSONL to stdout
 */

import { Command } from "commander";
import {
  getDefaultLedger,
  type AuditEvent,
  type VerifyResult,
} from "../kernel/audit.js";

export function registerAuditCommand(program: Command): void {
  const audit = program
    .command("audit")
    .description("Inspect the tamper-evident audit ledger");

  // ── show ──────────────────────────────────────────────────────────────────
  audit
    .command("show")
    .description("Display a human-readable event timeline")
    .option("-n, --limit <n>", "maximum events to show", "50")
    .option("--offset <n>", "skip the first N events", "0")
    .action((opts: { limit: string; offset: string }) => {
      const ledger = getDefaultLedger();
      const events = ledger.getEvents(Number(opts.limit), Number(opts.offset));
      const total = ledger.count();

      if (events.length === 0) {
        process.stdout.write("No events in the audit ledger.\n");
        return;
      }

      process.stdout.write(
        `Showing ${events.length} of ${total} event(s)\n${"─".repeat(60)}\n`,
      );
      for (const ev of events) {
        process.stdout.write(formatEvent(ev));
      }
    });

  // ── verify ────────────────────────────────────────────────────────────────
  audit
    .command("verify")
    .description("Verify the hash chain integrity of the ledger")
    .action(() => {
      const ledger = getDefaultLedger();
      const result: VerifyResult = ledger.verify();

      if (result.valid) {
        process.stdout.write(
          `✓ Chain intact — ${result.count} event(s) verified.\n`,
        );
        process.exitCode = 0;
      } else {
        process.stderr.write(
          `✗ Chain BROKEN at seq ${result.first_break_seq ?? "?"}:\n  ${result.break_reason ?? "unknown"}\n`,
        );
        process.stderr.write(
          `  ${result.count} total event(s) in ledger.\n`,
        );
        process.exitCode = 1;
      }
    });

  // ── export ────────────────────────────────────────────────────────────────
  audit
    .command("export")
    .description(
      "Export all events as JSONL (one JSON object per line) for SIEM ingestion",
    )
    .option("--siem", "alias for the default JSONL export (Splunk/Elastic etc.)")
    .action(() => {
      const ledger = getDefaultLedger();
      const events = ledger.exportAll();
      for (const ev of events) {
        process.stdout.write(JSON.stringify(ev) + "\n");
      }
    });
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatEvent(ev: AuditEvent): string {
  const lines: string[] = [];
  lines.push(
    `[${ev.seq}] ${ev.timestamp}  ${ev.action}` +
      (ev.tool_name ? ` (${ev.tool_name})` : ""),
  );
  if (ev.actor) lines.push(`    actor:  ${ev.actor}`);
  if (ev.target) lines.push(`    target: ${ev.target}`);
  if (ev.result) lines.push(`    result: ${ev.result}`);
  if (ev.risk_level) lines.push(`    risk:   ${ev.risk_level} / L${ev.permission_level ?? "?"}`);
  if (ev.policy_decision) lines.push(`    policy: ${ev.policy_decision}${ev.policy_reason ? ` — ${ev.policy_reason}` : ""}`);
  if (ev.approval_id) lines.push(`    approval: ${ev.approval_id}`);
  if (ev.error) lines.push(`    error:  ${ev.error}`);
  if (ev.redactions && ev.redactions.length > 0) {
    lines.push(`    redacted fields: ${ev.redactions.map((r) => r.field).join(", ")}`);
  }
  lines.push(`    hash:   ${ev.hash.slice(0, 16)}…`);
  lines.push("");
  return lines.join("\n");
}
