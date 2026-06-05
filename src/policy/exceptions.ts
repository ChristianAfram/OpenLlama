/**
 * Exception lifecycle (Master Plan §10, framework §25).
 *
 * Accepted risk must expire. Every exception needs an owner, an expiry, and a
 * compensating control; an entry past `expires_at` becomes a HARD BLOCKER — the
 * policy CI job fails the build. This module loads and validates the catalog.
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export interface ExceptionRecord {
  exception_id?: string;
  risk?: string;
  impact?: string;
  reason?: string;
  owner?: string;
  approved_by?: string;
  created_at?: string;
  expires_at?: string;
  compensating_control?: string;
  status?: string;
}

export interface ExceptionProblem {
  exception_id: string;
  problem: string;
}

export interface ExceptionValidation {
  total: number;
  active: number;
  /** Records past their expiry that are still active — hard blockers. */
  expired: ExceptionProblem[];
  /** Structural problems: missing owner / expiry / compensating control. */
  malformed: ExceptionProblem[];
  ok: boolean;
}

/** Parse the catalog file into records. Returns [] for an empty file. */
export function loadExceptions(path: string): ExceptionRecord[] {
  const text = readFileSync(path, "utf8");
  const data: unknown = parseYaml(text);
  if (data == null) return [];
  if (!Array.isArray(data)) {
    throw new Error(`exceptions catalog must be a YAML list, got ${typeof data}`);
  }
  return data as ExceptionRecord[];
}

/**
 * Validate every exception against the lifecycle rules (framework §25):
 *   - must have owner, expires_at, and compensating_control
 *   - an active exception past expires_at is an expired hard blocker
 * An exception with status other than "active" (e.g. "resolved") is not a
 * blocker but is still checked for structural completeness.
 */
export function validateExceptions(
  records: ExceptionRecord[],
  now: Date = new Date(),
): ExceptionValidation {
  const expired: ExceptionProblem[] = [];
  const malformed: ExceptionProblem[] = [];
  let active = 0;

  for (const rec of records) {
    const id = rec.exception_id ?? "(missing exception_id)";
    const isActive = (rec.status ?? "active") === "active";
    if (isActive) active++;

    if (!rec.owner) malformed.push({ exception_id: id, problem: "missing owner" });
    if (!rec.compensating_control) {
      malformed.push({ exception_id: id, problem: "missing compensating_control" });
    }
    if (!rec.expires_at) {
      malformed.push({ exception_id: id, problem: "missing expires_at (no permanent exceptions)" });
      continue;
    }

    const expiresAt = Date.parse(String(rec.expires_at));
    if (Number.isNaN(expiresAt)) {
      malformed.push({ exception_id: id, problem: `unparseable expires_at: "${String(rec.expires_at)}"` });
      continue;
    }
    if (isActive && expiresAt < now.getTime()) {
      expired.push({
        exception_id: id,
        problem: `expired on ${String(rec.expires_at)} — accepted risk has lapsed`,
      });
    }
  }

  return {
    total: records.length,
    active,
    expired,
    malformed,
    ok: expired.length === 0 && malformed.length === 0,
  };
}
