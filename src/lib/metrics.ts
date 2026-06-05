/**
 * Golden-signal + agentic metrics derived from the audit ledger.
 *
 * Metrics (Master Plan §20 "Observable and recoverable", framework §20, §35):
 *
 *   Golden signals (distilled for a single-process agent):
 *     errors          — total failed/errored events
 *     blocked         — total blocked events (policy/verifier/kill-switch/approval)
 *     executed        — total successfully executed mutations
 *
 *   Agentic signals (§20 "Agentic signals"):
 *     blocked_action_rate       — blocked / (executed + blocked)
 *     approval_denial_rate      — approval-denied / (all L4/L5 attempts)
 *     injection_detection_rate  — prompt-injection blocks / all injection-like blocks
 *     policy_deny_count         — DENY decisions
 *     consecutive_denial_peaks  — max observed run of consecutive blocked events
 *     tool_call_counts          — per-tool executed counts
 *     rollback_count            — events with action ending in "_rollback"
 *     kill_switch_activations   — events with action "kill_switch_activate"
 */

import type { AuditEvent } from "../kernel/audit.js";

export interface AuditMetrics {
  /** Total events in the ledger. */
  total_events: number;
  /** Events with result=executed. */
  executed: number;
  /** Events with result=blocked. */
  blocked: number;
  /** Events with result=failed. */
  errors: number;
  /** blocked / (executed + blocked), or 0 if no mutations attempted. */
  blocked_action_rate: number;
  /** DENY policy decisions. */
  policy_deny_count: number;
  /** Events where policy_decision is REQUIRE_APPROVAL or REQUIRE_CONFIRMATION that were blocked. */
  approval_denial_count: number;
  /** approval_denial_count / total L4+ attempts. */
  approval_denial_rate: number;
  /** Blocks where policy_reason contains "injection" or "prompt_injection". */
  injection_detection_count: number;
  /** Longest run of consecutive blocked events (tracks denial bursts). */
  consecutive_denial_peak: number;
  /** Events where action ends in "_rollback". */
  rollback_count: number;
  /** Per-tool execution counts (tool_name → count). */
  tool_call_counts: Record<string, number>;
  /** Timestamp of the earliest and latest events. */
  earliest_event: string | null;
  latest_event: string | null;
}

export function computeMetrics(events: AuditEvent[]): AuditMetrics {
  let executed = 0;
  let blocked = 0;
  let errors = 0;
  let policy_deny_count = 0;
  let approval_denial_count = 0;
  let injection_detection_count = 0;
  let rollback_count = 0;
  let consecutiveBlocked = 0;
  let consecutive_denial_peak = 0;
  let l4PlusAttempts = 0;
  const tool_call_counts: Record<string, number> = {};

  for (const ev of events) {
    const result = ev.result;

    if (result === "executed") {
      executed++;
      consecutiveBlocked = 0;
    } else if (result === "blocked") {
      blocked++;
      consecutiveBlocked++;
      if (consecutiveBlocked > consecutive_denial_peak) {
        consecutive_denial_peak = consecutiveBlocked;
      }
    } else if (result === "failed") {
      errors++;
      consecutiveBlocked = 0;
    } else {
      consecutiveBlocked = 0;
    }

    if (ev.policy_decision === "DENY") {
      policy_deny_count++;
    }

    // Approval denial: a blocked event at L4+ where policy_reason mentions "denied".
    const level = ev.permission_level ?? 0;
    if (level >= 4) {
      l4PlusAttempts++;
      if (result === "blocked" && (ev.error ?? "").toLowerCase().includes("approval denied")) {
        approval_denial_count++;
      }
    }

    // Injection detection heuristic: blocked event with policy_reason or error containing
    // injection keywords — recorded structurally by the executor when the action is blocked
    // because external content matched a prompt-injection pattern.
    const reasonText = `${ev.policy_reason ?? ""} ${ev.error ?? ""}`.toLowerCase();
    if (result === "blocked" && (reasonText.includes("injection") || reasonText.includes("prompt_injection"))) {
      injection_detection_count++;
    }

    if (ev.action.endsWith("_rollback")) {
      rollback_count++;
    }

    if (ev.tool_name) {
      tool_call_counts[ev.tool_name] = (tool_call_counts[ev.tool_name] ?? 0) + 1;
    }
  }

  const mutationAttempts = executed + blocked;
  const blocked_action_rate = mutationAttempts > 0 ? blocked / mutationAttempts : 0;
  const approval_denial_rate = l4PlusAttempts > 0 ? approval_denial_count / l4PlusAttempts : 0;

  const earliest_event = events[0]?.timestamp ?? null;
  const latest_event = events[events.length - 1]?.timestamp ?? null;

  return {
    total_events: events.length,
    executed,
    blocked,
    errors,
    blocked_action_rate,
    policy_deny_count,
    approval_denial_count,
    approval_denial_rate,
    injection_detection_count,
    consecutive_denial_peak,
    rollback_count,
    tool_call_counts,
    earliest_event,
    latest_event,
  };
}

export function formatMetrics(m: AuditMetrics): string {
  const lines: string[] = [];
  lines.push("Audit Metrics");
  lines.push("─".repeat(50));
  lines.push(`  Total events:             ${m.total_events}`);
  lines.push(`  Executed mutations:        ${m.executed}`);
  lines.push(`  Blocked actions:           ${m.blocked}`);
  lines.push(`  Failed actions:            ${m.errors}`);
  lines.push(`  Rollback events:           ${m.rollback_count}`);
  lines.push("");
  lines.push("  Agentic signals:");
  lines.push(`    Blocked-action rate:     ${pct(m.blocked_action_rate)}`);
  lines.push(`    Policy DENY count:       ${m.policy_deny_count}`);
  lines.push(`    Approval-denial rate:    ${pct(m.approval_denial_rate)}`);
  lines.push(`    Injection detections:    ${m.injection_detection_count}`);
  lines.push(`    Consecutive denial peak: ${m.consecutive_denial_peak}`);
  lines.push("");
  if (Object.keys(m.tool_call_counts).length > 0) {
    lines.push("  Tool call counts:");
    for (const [tool, count] of Object.entries(m.tool_call_counts).sort(([, a], [, b]) => b - a)) {
      lines.push(`    ${tool.padEnd(24)} ${count}`);
    }
    lines.push("");
  }
  if (m.earliest_event) {
    lines.push(`  Earliest event: ${m.earliest_event}`);
  }
  if (m.latest_event) {
    lines.push(`  Latest event:   ${m.latest_event}`);
  }
  lines.push("");
  return lines.join("\n");
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}
