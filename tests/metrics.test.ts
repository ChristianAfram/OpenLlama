/**
 * Metrics tests (Prompt 10).
 *
 * Proves computeMetrics produces correct golden-signal + agentic metrics
 * from a known set of audit events.
 */

import { describe, it, expect } from "vitest";
import { computeMetrics } from "../src/lib/metrics.js";
import type { AuditEvent } from "../src/kernel/audit.js";

function makeEvent(overrides: Partial<AuditEvent>): AuditEvent {
  return {
    seq: 1,
    event_id: "00000000-0000-0000-0000-000000000001",
    prev_hash: "0".repeat(64),
    hash: "a".repeat(64),
    timestamp: new Date().toISOString(),
    action: "test_action",
    ...overrides,
  };
}

describe("computeMetrics", () => {
  it("empty ledger returns zero metrics", () => {
    const m = computeMetrics([]);
    expect(m.total_events).toBe(0);
    expect(m.executed).toBe(0);
    expect(m.blocked).toBe(0);
    expect(m.errors).toBe(0);
    expect(m.blocked_action_rate).toBe(0);
    expect(m.policy_deny_count).toBe(0);
    expect(m.approval_denial_count).toBe(0);
    expect(m.consecutive_denial_peak).toBe(0);
    expect(m.rollback_count).toBe(0);
    expect(Object.keys(m.tool_call_counts)).toHaveLength(0);
  });

  it("counts executed, blocked, and failed correctly", () => {
    const events = [
      makeEvent({ result: "executed" }),
      makeEvent({ result: "executed" }),
      makeEvent({ result: "blocked" }),
      makeEvent({ result: "failed" }),
    ];
    const m = computeMetrics(events);
    expect(m.executed).toBe(2);
    expect(m.blocked).toBe(1);
    expect(m.errors).toBe(1);
    expect(m.total_events).toBe(4);
  });

  it("computes blocked_action_rate correctly", () => {
    const events = [
      makeEvent({ result: "executed" }),
      makeEvent({ result: "executed" }),
      makeEvent({ result: "blocked" }),
    ];
    const m = computeMetrics(events);
    // 1 blocked / 3 (executed + blocked)
    expect(m.blocked_action_rate).toBeCloseTo(1 / 3, 5);
  });

  it("counts DENY policy decisions", () => {
    const events = [
      makeEvent({ result: "blocked", policy_decision: "DENY" }),
      makeEvent({ result: "blocked", policy_decision: "DENY" }),
      makeEvent({ result: "executed" }),
    ];
    const m = computeMetrics(events);
    expect(m.policy_deny_count).toBe(2);
  });

  it("counts approval denials at L4+", () => {
    const events = [
      makeEvent({ result: "blocked", permission_level: 4, error: "approval denied: user rejected" }),
      makeEvent({ result: "blocked", permission_level: 4, error: "policy denied: secret path" }),
      makeEvent({ result: "executed", permission_level: 4 }),
    ];
    const m = computeMetrics(events);
    // Only the first event matches "approval denied"
    expect(m.approval_denial_count).toBe(1);
    expect(m.approval_denial_rate).toBeCloseTo(1 / 3, 5);
  });

  it("detects injection events from error text", () => {
    const events = [
      makeEvent({ result: "blocked", error: "prompt_injection attempt blocked" }),
      makeEvent({ result: "blocked", error: "secret path denied" }),
    ];
    const m = computeMetrics(events);
    expect(m.injection_detection_count).toBe(1);
  });

  it("tracks consecutive denial peak", () => {
    const events = [
      makeEvent({ result: "blocked" }),
      makeEvent({ result: "blocked" }),
      makeEvent({ result: "blocked" }),
      makeEvent({ result: "executed" }),
      makeEvent({ result: "blocked" }),
      makeEvent({ result: "blocked" }),
    ];
    const m = computeMetrics(events);
    expect(m.consecutive_denial_peak).toBe(3);
  });

  it("counts rollback events", () => {
    const events = [
      makeEvent({ action: "write_file_rollback", result: "executed" }),
      makeEvent({ action: "edit_file_rollback", result: "executed" }),
      makeEvent({ action: "write_file", result: "executed" }),
    ];
    const m = computeMetrics(events);
    expect(m.rollback_count).toBe(2);
  });

  it("counts per-tool call counts", () => {
    const events = [
      makeEvent({ tool_name: "write_file", result: "executed" }),
      makeEvent({ tool_name: "write_file", result: "executed" }),
      makeEvent({ tool_name: "read_file", result: "executed" }),
      makeEvent({ tool_name: "edit_file", result: "blocked" }),
    ];
    const m = computeMetrics(events);
    expect(m.tool_call_counts["write_file"]).toBe(2);
    expect(m.tool_call_counts["read_file"]).toBe(1);
    expect(m.tool_call_counts["edit_file"]).toBe(1);
  });

  it("records earliest and latest event timestamps", () => {
    const t1 = "2026-01-01T00:00:00.000Z";
    const t2 = "2026-06-01T00:00:00.000Z";
    const events = [
      makeEvent({ timestamp: t1 }),
      makeEvent({ timestamp: t2 }),
    ];
    const m = computeMetrics(events);
    expect(m.earliest_event).toBe(t1);
    expect(m.latest_event).toBe(t2);
  });

  it("blocked_action_rate is 0 when no mutations attempted", () => {
    const events = [makeEvent({ result: "executed", action: "read_file" })];
    // read-only tools count as executed — but if there are 0 blocked, rate = 0
    // The rate formula is blocked/(executed+blocked) = 0/1 = 0
    const m = computeMetrics(events);
    expect(m.blocked_action_rate).toBe(0);
  });
});
