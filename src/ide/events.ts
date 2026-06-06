/**
 * IDE bridge — structured agent event stream (v0.8 — C1).
 *
 * An editor/extension drives the agent by running `opencli agent --json` and
 * rendering the NDJSON event stream emitted on stdout. This module defines the
 * stable event contract and a serializer.
 *
 * Governance note. The bridge is strictly OBSERVATIONAL: an AgentObserver is a
 * read-only callback the engine invokes at lifecycle points. It can never run a
 * tool, mutate state, or bypass a kernel gate — every world action still flows
 * through the executor and the audit ledger exactly as in a normal run. The
 * stream is local stdout (the same content the human terminal would show).
 */

/** The status of a single tool call as seen by the engine loop. */
export type ToolCallStatus = "ok" | "blocked" | "invalid_args" | "error";

/** One event in the agent run stream. `v` is the contract version. */
export type AgentEvent =
  | {
      type: "run_start";
      v: 1;
      session_id: string;
      correlation_id: string;
      model: string;
      instruction: string;
    }
  | { type: "iteration"; v: 1; n: number }
  | { type: "assistant"; v: 1; content: string }
  | {
      type: "tool_call";
      v: 1;
      name: string;
      status: ToolCallStatus;
      audit_event_id: string | null;
      feedback: string;
    }
  | {
      type: "run_end";
      v: 1;
      stop_reason: string;
      iterations: number;
      tool_calls: number;
      answer: string;
    };

/** A read-only observer the engine invokes as a run progresses. */
export type AgentObserver = (event: AgentEvent) => void;

/** Serialize one event as a single NDJSON line (no embedded newlines). */
export function serializeEvent(event: AgentEvent): string {
  return JSON.stringify(event);
}

/** Parse a single NDJSON line back into an AgentEvent (for IDE consumers/tests). */
export function parseEvent(line: string): AgentEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as AgentEvent;
    if (typeof obj === "object" && obj !== null && typeof (obj as { type?: unknown }).type === "string") {
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}
