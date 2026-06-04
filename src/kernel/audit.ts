/**
 * Hash-chained, append-only audit ledger.
 *
 * The thesis invariant lives here: every world-mutating tool call must route
 * through `appendEvent` *before* the side effect runs, and the executor must
 * confirm the write succeeded. If the write fails this module throws — never
 * silently proceeds.
 *
 * Properties (Master Plan §9):
 *   - Append-only: UPDATE/DELETE are blocked by SQLite triggers.
 *   - Hash-chained: hash = sha256(prev_hash + canonical_json(event_body)).
 *     Any retroactive edit breaks the chain; `audit verify` detects it.
 *   - Redaction mandatory: secrets are stripped before storage via redaction.ts.
 *   - Export: `exportEvents` emits JSONL for SIEM ingestion.
 */

import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { canonicalJson } from "../lib/canonical-json.js";
import { redactDeep, type RedactionRecord } from "../lib/redaction.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type PermissionLevel = 0 | 1 | 2 | 3 | 4 | 5;
export type PolicyDecision =
  | "ALLOW"
  | "DENY"
  | "REQUIRE_APPROVAL"
  | "REQUIRE_CONFIRMATION";
export type InputSource = "user" | "developer" | "tool_output" | "external";
export type ActionResult = "executed" | "blocked" | "failed";

/** The logical body of an event (what is hashed and stored). */
export interface AuditEventBody {
  event_id: string;
  timestamp: string; // RFC3339
  actor?: string;
  session_id?: string;
  correlation_id?: string;
  service?: string;
  action: string;
  risk_level?: RiskLevel;
  permission_level?: PermissionLevel;
  policy_decision?: PolicyDecision;
  policy_reason?: string;
  approval_id?: string;
  input_source?: InputSource;
  target?: string;
  data_read?: unknown[];
  data_changed?: unknown[];
  tool_name?: string;
  model?: string;
  prompt_version?: string;
  result?: ActionResult;
  error?: string;
  rollback_path?: string;
  cost_estimate?: string;
  redactions?: RedactionRecord[];
}

/** A fully stored event including chain fields. */
export interface AuditEvent extends AuditEventBody {
  seq: number;
  prev_hash: string;
  hash: string;
}

/** What the caller provides — the ledger fills event_id, timestamp, chain fields. */
export type AppendInput = Omit<
  AuditEventBody,
  "event_id" | "timestamp" | "redactions"
>;

export interface AppendResult {
  event_id: string;
  seq: number;
  hash: string;
}

export interface VerifyResult {
  valid: boolean;
  /** Total events checked */
  count: number;
  /** seq of the first broken link, or null if chain is intact */
  first_break_seq: number | null;
  /** Human-readable description of the break */
  break_reason: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** The hash of the empty/genesis predecessor used by the first event. */
export const GENESIS_HASH = "0".repeat(64);

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT    NOT NULL UNIQUE,
  prev_hash       TEXT    NOT NULL,
  hash            TEXT    NOT NULL,
  timestamp       TEXT    NOT NULL,
  actor           TEXT,
  session_id      TEXT,
  correlation_id  TEXT,
  service         TEXT,
  action          TEXT    NOT NULL,
  risk_level      TEXT,
  permission_level INTEGER,
  policy_decision TEXT,
  policy_reason   TEXT,
  approval_id     TEXT,
  input_source    TEXT,
  target          TEXT,
  data_read       TEXT,
  data_changed    TEXT,
  tool_name       TEXT,
  model           TEXT,
  prompt_version  TEXT,
  result          TEXT,
  error           TEXT,
  rollback_path   TEXT,
  cost_estimate   TEXT,
  redactions      TEXT
);

-- Enforce append-only at the DB level, not just in code.
CREATE TRIGGER IF NOT EXISTS no_update_events
  BEFORE UPDATE ON events
  BEGIN
    SELECT RAISE(ABORT, 'audit ledger is append-only: UPDATE not permitted');
  END;

CREATE TRIGGER IF NOT EXISTS no_delete_events
  BEFORE DELETE ON events
  BEGIN
    SELECT RAISE(ABORT, 'audit ledger is append-only: DELETE not permitted');
  END;
`;

// ─── AuditLedger ─────────────────────────────────────────────────────────────

export class AuditLedger {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly lastHashStmt: Database.Statement;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    // WAL mode for better concurrency; still synchronous writes.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec(SCHEMA);

    this.insertStmt = this.db.prepare(`
      INSERT INTO events (
        event_id, prev_hash, hash, timestamp, actor, session_id,
        correlation_id, service, action, risk_level, permission_level,
        policy_decision, policy_reason, approval_id, input_source, target,
        data_read, data_changed, tool_name, model, prompt_version,
        result, error, rollback_path, cost_estimate, redactions
      ) VALUES (
        @event_id, @prev_hash, @hash, @timestamp, @actor, @session_id,
        @correlation_id, @service, @action, @risk_level, @permission_level,
        @policy_decision, @policy_reason, @approval_id, @input_source, @target,
        @data_read, @data_changed, @tool_name, @model, @prompt_version,
        @result, @error, @rollback_path, @cost_estimate, @redactions
      )
    `);

    this.lastHashStmt = this.db.prepare(
      "SELECT hash FROM events ORDER BY seq DESC LIMIT 1",
    );
  }

  /**
   * Append an event to the ledger.
   *
   * Runs the redaction pass, computes the hash chain, inserts, and confirms
   * the write. **Throws if the write is not confirmed.** The caller (executor)
   * must not proceed with any side effect unless this returns successfully.
   */
  appendEvent(input: AppendInput): AppendResult {
    // 1. Redact secrets across every field.
    const redactions: RedactionRecord[] = [];
    const sanitized = sanitizeInput(input, redactions);

    // 2. Generate deterministic event_id and timestamp.
    const event_id = randomUUID();
    const timestamp = new Date().toISOString();

    // 3. Build the event body (what is hashed).
    const body: AuditEventBody = {
      event_id,
      timestamp,
      ...sanitized,
      ...(redactions.length > 0 ? { redactions } : {}),
    };

    // 4. Compute the hash chain.
    const prev = this.lastHashStmt.get() as { hash: string } | undefined;
    const prev_hash = prev?.hash ?? GENESIS_HASH;
    const hash = computeHash(prev_hash, body);

    // 5. Serialize JSON array fields for storage.
    const row = {
      event_id,
      prev_hash,
      hash,
      timestamp,
      actor: sanitized.actor ?? null,
      session_id: sanitized.session_id ?? null,
      correlation_id: sanitized.correlation_id ?? null,
      service: sanitized.service ?? null,
      action: sanitized.action,
      risk_level: sanitized.risk_level ?? null,
      permission_level: sanitized.permission_level ?? null,
      policy_decision: sanitized.policy_decision ?? null,
      policy_reason: sanitized.policy_reason ?? null,
      approval_id: sanitized.approval_id ?? null,
      input_source: sanitized.input_source ?? null,
      target: sanitized.target ?? null,
      data_read: sanitized.data_read != null ? JSON.stringify(sanitized.data_read) : null,
      data_changed: sanitized.data_changed != null ? JSON.stringify(sanitized.data_changed) : null,
      tool_name: sanitized.tool_name ?? null,
      model: sanitized.model ?? null,
      prompt_version: sanitized.prompt_version ?? null,
      result: sanitized.result ?? null,
      error: sanitized.error ?? null,
      rollback_path: sanitized.rollback_path ?? null,
      cost_estimate: sanitized.cost_estimate ?? null,
      redactions: redactions.length > 0 ? JSON.stringify(redactions) : null,
    };

    // 6. Insert — better-sqlite3 is synchronous; run() throws on failure.
    const info = this.insertStmt.run(row);
    if (info.changes !== 1) {
      throw new AuditWriteError(
        `audit write not confirmed: expected 1 change, got ${info.changes}`,
      );
    }

    return { event_id, seq: Number(info.lastInsertRowid), hash };
  }

  /**
   * Walk the chain and verify every link.
   * Returns immediately on the first detected break.
   */
  verify(): VerifyResult {
    const rows = this.db
      .prepare(
        "SELECT seq, event_id, prev_hash, hash, timestamp, actor, session_id, correlation_id, service, action, risk_level, permission_level, policy_decision, policy_reason, approval_id, input_source, target, data_read, data_changed, tool_name, model, prompt_version, result, error, rollback_path, cost_estimate, redactions FROM events ORDER BY seq ASC",
      )
      .all() as RawRow[];

    let expectedPrevHash = GENESIS_HASH;

    for (const row of rows) {
      const body = rowToBody(row);
      const expectedHash = computeHash(row.prev_hash, body);

      if (row.prev_hash !== expectedPrevHash) {
        return {
          valid: false,
          count: rows.length,
          first_break_seq: row.seq,
          break_reason: `seq ${row.seq}: prev_hash mismatch (expected ${expectedPrevHash.slice(0, 8)}…, stored ${row.prev_hash.slice(0, 8)}…)`,
        };
      }
      if (row.hash !== expectedHash) {
        return {
          valid: false,
          count: rows.length,
          first_break_seq: row.seq,
          break_reason: `seq ${row.seq}: hash mismatch (recomputed ${expectedHash.slice(0, 8)}…, stored ${row.hash.slice(0, 8)}…)`,
        };
      }

      expectedPrevHash = row.hash;
    }

    return {
      valid: true,
      count: rows.length,
      first_break_seq: null,
      break_reason: null,
    };
  }

  /** Return events in seq order (paginated). */
  getEvents(limit = 100, offset = 0): AuditEvent[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM events ORDER BY seq ASC LIMIT ? OFFSET ?",
      )
      .all(limit, offset) as RawRow[];
    return rows.map(rowToEvent);
  }

  /** Total event count. */
  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as n FROM events")
      .get() as { n: number };
    return row.n;
  }

  /** Export all events as an array (for JSONL serialisation). */
  exportAll(): AuditEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events ORDER BY seq ASC")
      .all() as RawRow[];
    return rows.map(rowToEvent);
  }

  close(): void {
    this.db.close();
  }
}

// ─── Module-level singleton ───────────────────────────────────────────────────

let _defaultLedger: AuditLedger | null = null;

export function defaultLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENLLAMA_AUDIT_DB) return env.OPENLLAMA_AUDIT_DB;
  const xdg = env.XDG_DATA_HOME;
  const base = xdg ? xdg : join(homedir(), ".local", "share");
  return join(base, "openllama", "audit.sqlite");
}

export function getDefaultLedger(
  env: NodeJS.ProcessEnv = process.env,
): AuditLedger {
  if (!_defaultLedger) {
    _defaultLedger = new AuditLedger(defaultLedgerPath(env));
  }
  return _defaultLedger;
}

/** Replace the default ledger (for testing). Returns the previous instance. */
export function _setDefaultLedger(
  ledger: AuditLedger | null,
): AuditLedger | null {
  const prev = _defaultLedger;
  _defaultLedger = ledger;
  return prev;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class AuditWriteError extends Error {
  override name = "AuditWriteError";
}

// ─── Helpers (private) ────────────────────────────────────────────────────────

function computeHash(prevHash: string, body: AuditEventBody): string {
  return createHash("sha256")
    .update(prevHash + canonicalJson(body))
    .digest("hex");
}

/** Run the redaction pass over every string field of the input. */
function sanitizeInput(
  input: AppendInput,
  redactions: RedactionRecord[],
): AppendInput {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    const r = redactDeep(k, v);
    redactions.push(...r.records);
    out[k] = r.value;
  }
  return out as AppendInput;
}

// ─── Row serialisation helpers ────────────────────────────────────────────────

interface RawRow {
  seq: number;
  event_id: string;
  prev_hash: string;
  hash: string;
  timestamp: string;
  actor: string | null;
  session_id: string | null;
  correlation_id: string | null;
  service: string | null;
  action: string;
  risk_level: string | null;
  permission_level: number | null;
  policy_decision: string | null;
  policy_reason: string | null;
  approval_id: string | null;
  input_source: string | null;
  target: string | null;
  data_read: string | null;
  data_changed: string | null;
  tool_name: string | null;
  model: string | null;
  prompt_version: string | null;
  result: string | null;
  error: string | null;
  rollback_path: string | null;
  cost_estimate: string | null;
  redactions: string | null;
}

function rowToBody(row: RawRow): AuditEventBody {
  const body: AuditEventBody = {
    event_id: row.event_id,
    timestamp: row.timestamp,
    action: row.action,
  };
  if (row.actor != null) body.actor = row.actor;
  if (row.session_id != null) body.session_id = row.session_id;
  if (row.correlation_id != null) body.correlation_id = row.correlation_id;
  if (row.service != null) body.service = row.service;
  if (row.risk_level != null) body.risk_level = row.risk_level as RiskLevel;
  if (row.permission_level != null) body.permission_level = row.permission_level as PermissionLevel;
  if (row.policy_decision != null) body.policy_decision = row.policy_decision as PolicyDecision;
  if (row.policy_reason != null) body.policy_reason = row.policy_reason;
  if (row.approval_id != null) body.approval_id = row.approval_id;
  if (row.input_source != null) body.input_source = row.input_source as InputSource;
  if (row.target != null) body.target = row.target;
  if (row.data_read != null) body.data_read = JSON.parse(row.data_read) as unknown[];
  if (row.data_changed != null) body.data_changed = JSON.parse(row.data_changed) as unknown[];
  if (row.tool_name != null) body.tool_name = row.tool_name;
  if (row.model != null) body.model = row.model;
  if (row.prompt_version != null) body.prompt_version = row.prompt_version;
  if (row.result != null) body.result = row.result as ActionResult;
  if (row.error != null) body.error = row.error;
  if (row.rollback_path != null) body.rollback_path = row.rollback_path;
  if (row.cost_estimate != null) body.cost_estimate = row.cost_estimate;
  if (row.redactions != null) body.redactions = JSON.parse(row.redactions) as RedactionRecord[];
  return body;
}

function rowToEvent(row: RawRow): AuditEvent {
  return {
    seq: row.seq,
    prev_hash: row.prev_hash,
    hash: row.hash,
    ...rowToBody(row),
  };
}
