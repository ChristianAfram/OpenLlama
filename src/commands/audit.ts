/**
 * `opencli audit` sub-commands.
 *
 *   audit show                      – human-readable event timeline
 *   audit verify                    – walk the hash chain and report the first break
 *   audit export [--siem] [--otel]  – emit events as JSONL / OTel-compatible records
 *   audit metrics                   – golden-signal + agentic metrics summary
 *   audit rollback <event_id>       – reverse a specific executed mutation
 */

import { Command } from "commander";
import {
  getDefaultLedger,
  type AuditEvent,
  type VerifyResult,
} from "../kernel/audit.js";
import { RollbackEngine } from "../kernel/rollback.js";
import { getDefaultSnapshotStore } from "../kernel/snapshot.js";
import { computeMetrics, formatMetrics, type AuditMetrics } from "../lib/metrics.js";
import { error } from "../lib/ui.js";
import { resolve } from "node:path";

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
      "Export events as JSONL for SIEM/OTel ingestion. " +
      "--siem emits raw audit events (Splunk/Elastic); " +
      "--otel emits OpenTelemetry-compatible log records.",
    )
    .option("--siem", "emit raw audit event JSONL (default)")
    .option(
      "--otel",
      "emit OTel-compatible LogRecord JSONL (resourceLogs schema)",
    )
    .action((opts: { siem?: boolean; otel?: boolean }) => {
      const ledger = getDefaultLedger();
      const events = ledger.exportAll();

      if (opts.otel) {
        // OTel-compatible LogRecord format (OTLP JSON schema, single resource).
        // Each audit event becomes one LogRecord; the resource identifies the
        // opencli service. Consumers can forward this to Tempo/Grafana, Splunk
        // OTel, or any OTLP-compatible backend.
        for (const ev of events) {
          process.stdout.write(JSON.stringify(toOtelLogRecord(ev)) + "\n");
        }
      } else {
        // --siem or default: raw audit event JSONL.
        for (const ev of events) {
          process.stdout.write(JSON.stringify(ev) + "\n");
        }
      }
    });

  // ── metrics ───────────────────────────────────────────────────────────────
  audit
    .command("metrics")
    .description(
      "Show golden-signal + agentic metrics derived from the audit ledger " +
      "(blocked-action rate, approval-denial rate, injection-detection rate, etc.)",
    )
    .option("--json", "emit metrics as a JSON object instead of plain text")
    .action((opts: { json?: boolean }) => {
      const ledger = getDefaultLedger();
      const events = ledger.exportAll();
      const metrics: AuditMetrics = computeMetrics(events);

      if (opts.json) {
        process.stdout.write(JSON.stringify(metrics, null, 2) + "\n");
      } else {
        process.stdout.write(formatMetrics(metrics));
      }
    });

  // ── rollback ──────────────────────────────────────────────────────────────
  audit
    .command("rollback <event_id>")
    .description(
      "Roll back a specific executed mutation identified by its audit event_id. " +
      "Creates a new audit event recording the reversal.",
    )
    .option("--cwd <dir>", "repository root (default: current dir)")
    .action(async (eventId: string, opts: { cwd?: string }) => {
      const repoRoot = resolve(opts.cwd ?? process.cwd());
      const ledger = getDefaultLedger();
      const snapshots = getDefaultSnapshotStore();
      const engine = new RollbackEngine(ledger, snapshots, repoRoot);

      const result = await engine.rollback(eventId);

      switch (result.status) {
        case "rolled_back":
          process.stdout.write(`✓ rolled back: ${result.description}\n`);
          if (result.rollback_event_id) {
            process.stdout.write(`  audit: ${result.rollback_event_id}\n`);
          }
          break;

        case "already_reversed":
          process.stdout.write(`ℹ already reversed: ${result.description}\n`);
          break;

        case "irrecoverable":
          process.stderr.write(
            `✗ irrecoverable: ${result.description}\n`,
          );
          if (result.instructions) {
            process.stderr.write(`\n${result.instructions}\n`);
          }
          process.exitCode = 1;
          break;

        case "precondition_failed":
          error(`precondition failed: ${result.description}`);
          process.exitCode = 1;
          break;

        case "not_found":
          error(result.description);
          process.exitCode = 1;
          break;
      }
    });
}

// ─── OTel LogRecord conversion ─────────────────────────────────────────────────

/**
 * Convert an audit event to an OTel-compatible LogRecord.
 *
 * Schema: https://opentelemetry.io/docs/specs/otel/logs/data-model/
 * The body carries the full audit event as a JSON string; key fields are also
 * promoted to attributes for easy filtering in Grafana / Splunk OTel.
 */
function toOtelLogRecord(ev: AuditEvent): unknown {
  return {
    timeUnixNano: String(new Date(ev.timestamp).getTime() * 1_000_000),
    severityNumber: severityForResult(ev.result),
    severityText: ev.result === "executed" ? "INFO" : ev.result === "blocked" ? "WARN" : "ERROR",
    body: { stringValue: JSON.stringify(ev) },
    attributes: [
      { key: "opencli.event_id", value: { stringValue: ev.event_id } },
      { key: "opencli.action", value: { stringValue: ev.action } },
      { key: "opencli.result", value: { stringValue: ev.result ?? "" } },
      { key: "opencli.risk_level", value: { stringValue: ev.risk_level ?? "" } },
      { key: "opencli.permission_level", value: { intValue: ev.permission_level ?? 0 } },
      { key: "opencli.tool_name", value: { stringValue: ev.tool_name ?? "" } },
      { key: "opencli.policy_decision", value: { stringValue: ev.policy_decision ?? "" } },
      { key: "opencli.actor", value: { stringValue: ev.actor ?? "" } },
      { key: "opencli.target", value: { stringValue: ev.target ?? "" } },
      { key: "opencli.hash", value: { stringValue: ev.hash.slice(0, 16) } },
    ],
    traceId: ev.correlation_id?.replace(/-/g, "").slice(0, 32) ?? "",
    spanId: ev.event_id.replace(/-/g, "").slice(0, 16),
  };
}

function severityForResult(result: string | undefined): number {
  switch (result) {
    case "executed": return 9;  // INFO
    case "blocked":  return 13; // WARN
    case "failed":   return 17; // ERROR
    default:         return 9;
  }
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatEvent(ev: AuditEvent): string {
  const lines: string[] = [];
  lines.push(
    `[${ev.seq}] ${ev.timestamp}  ${ev.action}` +
      (ev.tool_name ? ` (${ev.tool_name})` : ""),
  );
  lines.push(`    id:     ${ev.event_id}`);
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
