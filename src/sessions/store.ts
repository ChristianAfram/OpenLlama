/**
 * Session store — persisted, resumable agent transcripts (v0.8 — Sessions).
 *
 * Each `opencli agent` run becomes a session: its turns (user instruction,
 * assistant reasoning, fenced tool results), token usage, cwd, model, and final
 * status. Resuming a session rebuilds the ConversationContext from these turns
 * so a conversation can continue across invocations.
 *
 * Relationship to the audit ledger:
 *   - The audit ledger (src/kernel/audit.ts) is the COMPLIANCE record: append-
 *     only, hash-chained, tamper-evident. It already carries session_id and
 *     correlation_id on every event.
 *   - This store is OPERATOR STATE: mutable (status/updated_at change), deletable
 *     (`session rm`), and a convenience for resume + listing. It is NOT a
 *     security control and is never exported to a SIEM. The correlation_id is
 *     the join key back to the authoritative audit timeline.
 *
 * Secret safety (framework §11, §32): transcript content is passed through the
 * same secret redaction used for the ledger before it is written to disk, so a
 * stored transcript never persists a credential in the clear.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redactValue } from "../lib/redaction.js";
import { defaultSessionDbPath } from "./path.js";

export type SessionStatus = "active" | "completed" | "aborted" | "killed";
export type TurnRole = "user" | "assistant" | "tool_result";

export interface SessionMeta {
  session_id: string;
  correlation_id: string;
  created_at: string;
  updated_at: string;
  status: SessionStatus;
  cwd: string;
  model: string;
  prompt_version: string;
  parent_session_id: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  stop_reason: string | null;
}

export interface StoredTurn {
  seq: number;
  session_id: string;
  role: TurnRole;
  /** For tool_result turns: the fence source (typically the tool name). */
  source: string | null;
  content: string;
  tool_name: string | null;
  audit_event_id: string | null;
  created_at: string;
}

export interface CreateSessionInput {
  session_id: string;
  correlation_id: string;
  cwd: string;
  model: string;
  prompt_version: string;
  parent_session_id?: string | null;
}

export interface AppendTurnInput {
  role: TurnRole;
  source?: string | null;
  content: string;
  tool_name?: string | null;
  audit_event_id?: string | null;
}

export interface FinishInput {
  status: SessionStatus;
  stop_reason?: string | null;
  total_input_tokens?: number;
  total_output_tokens?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id          TEXT PRIMARY KEY,
  correlation_id      TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  -- Monotonic activity counter for deterministic ordering. updated_at has only
  -- millisecond resolution, so two writes in the same ms would tie; rev does not.
  rev                 INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL,
  cwd                 TEXT NOT NULL,
  model               TEXT,
  prompt_version      TEXT,
  parent_session_id   TEXT,
  total_input_tokens  INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  stop_reason         TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  role            TEXT NOT NULL,
  source          TEXT,
  content         TEXT NOT NULL,
  tool_name       TEXT,
  audit_event_id  TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
`;

interface SessionRow {
  session_id: string;
  correlation_id: string;
  created_at: string;
  updated_at: string;
  status: string;
  cwd: string;
  model: string | null;
  prompt_version: string | null;
  parent_session_id: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  stop_reason: string | null;
}

function rowToMeta(r: SessionRow): SessionMeta {
  return {
    session_id: r.session_id,
    correlation_id: r.correlation_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    status: r.status as SessionStatus,
    cwd: r.cwd,
    model: r.model ?? "",
    prompt_version: r.prompt_version ?? "",
    parent_session_id: r.parent_session_id,
    total_input_tokens: r.total_input_tokens,
    total_output_tokens: r.total_output_tokens,
    stop_reason: r.stop_reason,
  };
}

export class SessionStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
  }

  /** Next value of the global monotonic activity counter. */
  private nextRev(): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(rev), 0) + 1 AS next FROM sessions`)
      .get() as { next: number };
    return row.next;
  }

  /** Create a new session row (status = active). */
  create(input: CreateSessionInput): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions (
           session_id, correlation_id, created_at, updated_at, rev, status, cwd,
           model, prompt_version, parent_session_id
         ) VALUES (@session_id, @correlation_id, @now, @now, @rev, 'active', @cwd,
           @model, @prompt_version, @parent_session_id)`,
      )
      .run({
        session_id: input.session_id,
        correlation_id: input.correlation_id,
        now,
        rev: this.nextRev(),
        cwd: input.cwd,
        model: input.model,
        prompt_version: input.prompt_version,
        parent_session_id: input.parent_session_id ?? null,
      });
  }

  /** Append a turn. Content is redacted before it touches disk. */
  appendTurn(sessionId: string, turn: AppendTurnInput): void {
    const now = new Date().toISOString();
    const safeContent = redactValue("content", turn.content).value;
    this.db
      .prepare(
        `INSERT INTO turns (session_id, role, source, content, tool_name, audit_event_id, created_at)
         VALUES (@session_id, @role, @source, @content, @tool_name, @audit_event_id, @now)`,
      )
      .run({
        session_id: sessionId,
        role: turn.role,
        source: turn.source ?? null,
        content: safeContent,
        tool_name: turn.tool_name ?? null,
        audit_event_id: turn.audit_event_id ?? null,
        now,
      });
    this.db
      .prepare(`UPDATE sessions SET updated_at = ?, rev = ? WHERE session_id = ?`)
      .run(now, this.nextRev(), sessionId);
  }

  /** Mark a session finished and record final status + token totals. */
  finish(sessionId: string, input: FinishInput): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE sessions
            SET status = @status,
                stop_reason = @stop_reason,
                updated_at = @now,
                rev = @rev,
                total_input_tokens = COALESCE(@in, total_input_tokens),
                total_output_tokens = COALESCE(@out, total_output_tokens)
          WHERE session_id = @session_id`,
      )
      .run({
        status: input.status,
        stop_reason: input.stop_reason ?? null,
        now,
        rev: this.nextRev(),
        in: input.total_input_tokens ?? null,
        out: input.total_output_tokens ?? null,
        session_id: sessionId,
      });
  }

  get(sessionId: string): SessionMeta | null {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE session_id = ?`)
      .get(sessionId) as SessionRow | undefined;
    return row ? rowToMeta(row) : null;
  }

  getTurns(sessionId: string): StoredTurn[] {
    return this.db
      .prepare(`SELECT * FROM turns WHERE session_id = ? ORDER BY seq ASC`)
      .all(sessionId) as StoredTurn[];
  }

  /** All sessions, most-recently-updated first. */
  list(): SessionMeta[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions ORDER BY rev DESC`)
      .all() as SessionRow[];
    return rows.map(rowToMeta);
  }

  /** The most recently updated session for a given cwd (for `--continue`). */
  latestForCwd(cwd: string): SessionMeta | null {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE cwd = ? ORDER BY rev DESC LIMIT 1`)
      .get(cwd) as SessionRow | undefined;
    return row ? rowToMeta(row) : null;
  }

  /** Number of turns in a session (for listings). */
  turnCount(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM turns WHERE session_id = ?`)
      .get(sessionId) as { n: number };
    return row.n;
  }

  /** Delete a session and its turns. Returns true if a session was removed. */
  remove(sessionId: string): boolean {
    const tx = this.db.transaction((id: string) => {
      this.db.prepare(`DELETE FROM turns WHERE session_id = ?`).run(id);
      const info = this.db.prepare(`DELETE FROM sessions WHERE session_id = ?`).run(id);
      return info.changes > 0;
    });
    return tx(sessionId);
  }

  close(): void {
    this.db.close();
  }
}

// ─── Default store singleton ─────────────────────────────────────────────────

let _default: SessionStore | undefined;

export function getDefaultSessionStore(
  env: NodeJS.ProcessEnv = process.env,
): SessionStore {
  if (!_default) _default = new SessionStore(defaultSessionDbPath(env));
  return _default;
}

/** Reset the module-level singleton — test helper only. */
export function _resetDefaultSessionStore(): void {
  _default = undefined;
}
