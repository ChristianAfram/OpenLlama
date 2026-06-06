/**
 * IDE audit timeline tests (v0.8 — C2).
 *
 * Proves:
 *   - events are grouped by correlation_id into runs; runs ordered chronologically.
 *   - a parent + subagent (shared correlation_id, distinct session_id) form ONE
 *     run with both sessions listed.
 *   - per-result counts (executed / blocked / failed) are correct.
 *   - events without a correlation_id collect under "(uncorrelated)" (nothing dropped).
 *   - entries within a run are ordered by seq; started_at/ended_at bound the run.
 *   - formatTimeline renders without throwing and reflects the counts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLedger } from "../src/kernel/audit.js";
import { buildTimeline, formatTimeline } from "../src/ide/timeline.js";

let dir: string;
let ledger: AuditLedger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencli-timeline-"));
  ledger = new AuditLedger(join(dir, "audit.sqlite"));
});

afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("buildTimeline", () => {
  it("groups events by correlation_id and orders runs chronologically", () => {
    ledger.appendEvent({ action: "a", correlation_id: "run-1", session_id: "s1", result: "executed" });
    ledger.appendEvent({ action: "b", correlation_id: "run-2", session_id: "s2", result: "executed" });
    ledger.appendEvent({ action: "c", correlation_id: "run-1", session_id: "s1", result: "blocked" });

    const timeline = buildTimeline(ledger.getEvents());
    expect(timeline.runs).toHaveLength(2);
    // run-1 appeared first (seq 1) → ordered before run-2 (seq 2).
    expect(timeline.runs[0]!.correlation_id).toBe("run-1");
    expect(timeline.runs[1]!.correlation_id).toBe("run-2");
    expect(timeline.total_events).toBe(3);
  });

  it("folds a parent + subagent into one run with both sessions", () => {
    // Parent and child share a correlation_id but have distinct session_ids.
    ledger.appendEvent({ action: "delegate", correlation_id: "corr", session_id: "parent", result: "executed" });
    ledger.appendEvent({ action: "read_file", correlation_id: "corr", session_id: "child", result: "executed" });

    const timeline = buildTimeline(ledger.getEvents());
    expect(timeline.runs).toHaveLength(1);
    const run = timeline.runs[0]!;
    expect(run.sessions).toEqual(["parent", "child"]); // first-appearance order
    expect(run.entries).toHaveLength(2);
  });

  it("computes per-result counts", () => {
    ledger.appendEvent({ action: "x", correlation_id: "r", result: "executed" });
    ledger.appendEvent({ action: "y", correlation_id: "r", result: "blocked" });
    ledger.appendEvent({ action: "z", correlation_id: "r", result: "failed" });
    ledger.appendEvent({ action: "w", correlation_id: "r", result: "executed" });

    const run = buildTimeline(ledger.getEvents()).runs[0]!;
    expect(run.counts).toEqual({ total: 4, executed: 2, blocked: 1, failed: 1 });
  });

  it("collects uncorrelated events under a single (uncorrelated) run", () => {
    ledger.appendEvent({ action: "lonely", result: "executed" }); // no correlation_id
    const timeline = buildTimeline(ledger.getEvents());
    expect(timeline.runs).toHaveLength(1);
    expect(timeline.runs[0]!.correlation_id).toBe("(uncorrelated)");
  });

  it("orders entries by seq and bounds the run by first/last timestamp", () => {
    ledger.appendEvent({ action: "first", correlation_id: "r" });
    ledger.appendEvent({ action: "second", correlation_id: "r" });
    const run = buildTimeline(ledger.getEvents()).runs[0]!;
    expect(run.entries.map((e) => e.action)).toEqual(["first", "second"]);
    expect(run.entries[0]!.seq).toBeLessThan(run.entries[1]!.seq);
    expect(run.started_at).toBe(run.entries[0]!.timestamp);
    expect(run.ended_at).toBe(run.entries[1]!.timestamp);
  });

  it("carries mcp source_kind and policy decision through to entries", () => {
    ledger.appendEvent({
      action: "mcp:srv:tool",
      tool_name: "mcp:srv:tool",
      correlation_id: "r",
      result: "blocked",
      policy_decision: "DENY",
      source_kind: "mcp",
      mcp_server: "srv",
      permission_level: 5,
    });
    const entry = buildTimeline(ledger.getEvents()).runs[0]!.entries[0]!;
    expect(entry.source_kind).toBe("mcp");
    expect(entry.policy_decision).toBe("DENY");
    expect(entry.permission_level).toBe(5);
  });

  it("returns an empty timeline for no events", () => {
    const timeline = buildTimeline([]);
    expect(timeline.runs).toHaveLength(0);
    expect(timeline.total_events).toBe(0);
  });
});

describe("formatTimeline", () => {
  it("renders a tree reflecting the run and its counts", () => {
    ledger.appendEvent({ action: "read_file", tool_name: "read_file", correlation_id: "abcd1234ef", result: "executed", permission_level: 0 });
    ledger.appendEvent({ action: "run_shell", tool_name: "run_shell", correlation_id: "abcd1234ef", result: "blocked", policy_decision: "REQUIRE_CONFIRMATION", permission_level: 5 });

    const out = formatTimeline(buildTimeline(ledger.getEvents()));
    expect(out).toContain("1 run(s), 2 event(s)");
    expect(out).toContain("read_file");
    expect(out).toContain("run_shell");
    expect(out).toContain("1 ok, 1 blocked");
  });

  it("renders an empty-ledger message", () => {
    expect(formatTimeline(buildTimeline([]))).toContain("No events");
  });
});
