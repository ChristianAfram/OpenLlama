/**
 * IDE audit timeline model (v0.8 — C2).
 *
 * Pure functions that fold the flat, hash-chained audit ledger into an
 * IDE-friendly structure: events grouped by `correlation_id` into "runs" (a
 * top-level agent run together with any subagents it spawned, since a child
 * shares its parent's correlation id), each with ordered entries and per-result
 * counts.
 *
 * This module reads the AUTHORITATIVE record (the audit ledger) and reshapes it
 * for display only — it makes no decisions and performs no I/O. An editor renders
 * the result as a tree; `opencli audit timeline --json` emits it verbatim.
 */

import type { AuditEvent } from "../kernel/audit.js";

/** One entry in a run's timeline — a single audit event, display-shaped. */
export interface TimelineEntry {
  event_id: string;
  seq: number;
  timestamp: string;
  action: string;
  tool_name: string | null;
  target: string | null;
  result: string | null;
  permission_level: number | null;
  risk_level: string | null;
  policy_decision: string | null;
  session_id: string | null;
  /** "mcp" for MCP tool calls, else null/"native". */
  source_kind: string | null;
}

/** A run = all events sharing one correlation_id (parent + subagents). */
export interface TimelineRun {
  correlation_id: string;
  /** Distinct session ids seen in this run (parent first by first-appearance). */
  sessions: string[];
  started_at: string;
  ended_at: string;
  entries: TimelineEntry[];
  counts: { total: number; executed: number; blocked: number; failed: number };
}

export interface Timeline {
  runs: TimelineRun[];
  total_events: number;
}

const UNCORRELATED = "(uncorrelated)";

/**
 * Build the timeline from a list of audit events. Events are grouped by
 * correlation_id; within a run they are ordered by seq. Runs are ordered by the
 * seq of their first event (chronological). Events without a correlation_id are
 * collected under a single "(uncorrelated)" run so nothing is dropped.
 */
export function buildTimeline(events: AuditEvent[]): Timeline {
  const byCorrelation = new Map<string, AuditEvent[]>();
  for (const ev of events) {
    const key = ev.correlation_id ?? UNCORRELATED;
    const bucket = byCorrelation.get(key);
    if (bucket) bucket.push(ev);
    else byCorrelation.set(key, [ev]);
  }

  const runs: TimelineRun[] = [];
  for (const [correlation_id, group] of byCorrelation) {
    const ordered = [...group].sort((a, b) => a.seq - b.seq);
    runs.push(buildRun(correlation_id, ordered));
  }

  // Chronological run order by first event's seq.
  runs.sort((a, b) => (a.entries[0]?.seq ?? 0) - (b.entries[0]?.seq ?? 0));

  return { runs, total_events: events.length };
}

function buildRun(correlation_id: string, ordered: AuditEvent[]): TimelineRun {
  const entries = ordered.map(toEntry);
  const sessions: string[] = [];
  let executed = 0;
  let blocked = 0;
  let failed = 0;

  for (const e of entries) {
    if (e.session_id && !sessions.includes(e.session_id)) sessions.push(e.session_id);
    if (e.result === "executed") executed++;
    else if (e.result === "blocked") blocked++;
    else if (e.result === "failed") failed++;
  }

  return {
    correlation_id,
    sessions,
    started_at: entries[0]?.timestamp ?? "",
    ended_at: entries[entries.length - 1]?.timestamp ?? "",
    entries,
    counts: { total: entries.length, executed, blocked, failed },
  };
}

function toEntry(ev: AuditEvent): TimelineEntry {
  return {
    event_id: ev.event_id,
    seq: ev.seq,
    timestamp: ev.timestamp,
    action: ev.action,
    tool_name: ev.tool_name ?? null,
    target: ev.target ?? null,
    result: ev.result ?? null,
    permission_level: ev.permission_level ?? null,
    risk_level: ev.risk_level ?? null,
    policy_decision: ev.policy_decision ?? null,
    session_id: ev.session_id ?? null,
    source_kind: ev.source_kind ?? null,
  };
}

/** Render the timeline as a compact text tree (the non-JSON CLI output). */
export function formatTimeline(timeline: Timeline): string {
  if (timeline.runs.length === 0) return "No events in the audit ledger.\n";
  const lines: string[] = [];
  lines.push(`${timeline.runs.length} run(s), ${String(timeline.total_events)} event(s)`);
  lines.push("─".repeat(60));
  for (const run of timeline.runs) {
    const c = run.counts;
    const subagents = run.sessions.length > 1 ? `, ${String(run.sessions.length)} sessions` : "";
    lines.push(
      `▶ ${shortId(run.correlation_id)}  ` +
        `[${String(c.total)} events: ${String(c.executed)} ok, ${String(c.blocked)} blocked, ${String(c.failed)} failed${subagents}]`,
    );
    for (const e of run.entries) {
      const tag = e.tool_name ?? e.action;
      const decision = e.policy_decision ? ` ${e.policy_decision}` : "";
      const lvl = e.permission_level !== null ? ` L${String(e.permission_level)}` : "";
      lines.push(
        `   ${resultGlyph(e.result)} ${tag}${lvl}${decision}` +
          `${e.target ? ` → ${e.target}` : ""}  (${shortId(e.event_id)})`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

function resultGlyph(result: string | null): string {
  if (result === "executed") return "✓";
  if (result === "blocked") return "✗";
  if (result === "failed") return "!";
  return "·";
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
