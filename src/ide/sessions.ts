/**
 * IDE session list model (v0.8 — C3).
 *
 * A pure, serializable summary of resumable sessions for an editor's "resume"
 * picker. The editor renders the list, lets the operator choose one, and relaunches
 * `opencli agent --resume <id> --json`. This module reshapes session-store
 * metadata for display only — it makes no decisions and performs no I/O.
 */

import type { SessionMeta } from "../sessions/store.js";

/** One row in the resume picker. */
export interface SessionSummary {
  session_id: string;
  correlation_id: string;
  status: string;
  created_at: string;
  updated_at: string;
  model: string;
  cwd: string;
  turns: number;
  total_tokens: number;
  stop_reason: string | null;
  /** True when this session was a subagent (has a parent). */
  is_subagent: boolean;
}

export interface SessionList {
  sessions: SessionSummary[];
  count: number;
}

/**
 * Build the session list from store metadata + per-session turn counts. The
 * caller supplies turn counts so this stays pure (no store dependency). Input
 * order is preserved (the store already returns most-recently-updated first).
 */
export function buildSessionList(rows: { meta: SessionMeta; turns: number }[]): SessionList {
  const sessions = rows.map(({ meta, turns }) => toSummary(meta, turns));
  return { sessions, count: sessions.length };
}

function toSummary(meta: SessionMeta, turns: number): SessionSummary {
  return {
    session_id: meta.session_id,
    correlation_id: meta.correlation_id,
    status: meta.status,
    created_at: meta.created_at,
    updated_at: meta.updated_at,
    model: meta.model,
    cwd: meta.cwd,
    turns,
    total_tokens: meta.total_input_tokens + meta.total_output_tokens,
    stop_reason: meta.stop_reason,
    is_subagent: meta.parent_session_id !== null,
  };
}
