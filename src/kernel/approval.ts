/**
 * The approval gate — Prompt 5.
 *
 * Levels 0–3 execute without approval (read/draft/low-risk reversible writes are
 * audited but not gated). Levels 4 and 5 may only proceed with a **scoped,
 * expiring approval grant**, and Level 5 additionally requires a **manual
 * confirmation phrase** typed by a human. There is no "approve everything"
 * grant: a scope that is unbounded in tool, path, or time is rejected.
 *
 * The agent can never approve its own action. Approval comes from an injected
 * `ApprovalProvider` (mirroring the `AuditSink` seam): the engine supplies none,
 * so agent-driven L4/L5 actions stay blocked; a human-driven CLI supplies an
 * interactive provider. Verification (`verifyGrant`) is a pure function so the
 * boundary is exhaustively testable.
 *
 * Master Plan §10 / framework §10, §25, §42.
 */

import type { PermissionLevel, RiskLevel } from "./audit.js";
import { globMatch } from "../lib/glob-match.js";

// ─── Request / grant / decision types ─────────────────────────────────────────

/** Everything the approver must see before confirming (framework §42). */
export interface ApprovalRequest {
  /** Unique id for THIS action; a grant must reference it. */
  action_id: string;
  tool_name: string;
  /** The classified permission level (always ≥ 4 when approval is requested). */
  permission_level: PermissionLevel;
  risk_level: RiskLevel;
  target?: string;
  /** What will happen. */
  summary: string;
  /** What changes (per-path before/after blob hashes). */
  data_changed: { path: string; before_hash: string | null; after_hash: string }[];
  /** How to undo it. */
  rollback_path: string;
  /** Why the classifier raised the level. */
  reason: string;
  session_id?: string;
  requested_by: string;
}

/** A narrow, explicit authorization scope. Empty tool/path lists are overbroad. */
export interface ApprovalScope {
  /** Tool names this grant authorizes. Must be non-empty and must not contain "*". */
  tools: string[];
  /** Target path globs this grant authorizes. Must be non-empty and not a catch-all. */
  path_globs: string[];
  /** Session this grant is bound to. Required — a grant is never cross-session. */
  session_id: string;
  /** Highest permission level this grant authorizes. */
  max_level: PermissionLevel;
}

export interface ApprovalGrant {
  approval_id: string;
  action_id: string;
  permission_level: PermissionLevel;
  approved_by: string;
  approved_at: string; // RFC3339
  expires_at: string; // RFC3339 — never absent, never "forever"
  scope: ApprovalScope;
  reason: string;
  rollback_path?: string;
  /** For Level 5: the exact confirmation phrase the human typed. */
  confirmation_phrase?: string;
}

export type ApprovalDecision =
  | { status: "granted"; grant: ApprovalGrant }
  | { status: "denied"; reason: string };

/**
 * The seam the executor consults for L4/L5 actions. Implementations: an
 * interactive CLI provider (human types yes / the confirmation phrase), or a
 * scripted provider in tests. The engine supplies NONE — the agent cannot
 * approve itself.
 */
export interface ApprovalProvider {
  requestApproval(req: ApprovalRequest): ApprovalDecision | Promise<ApprovalDecision>;
}

// ─── Confirmation phrase (Level 5) ────────────────────────────────────────────

/**
 * The exact phrase a human must type to confirm a Level 5 action. Derived from
 * the action so a generic "yes" can never satisfy an L5 confirmation, and so a
 * confirmation for one action cannot be replayed for another.
 */
export function requiredConfirmationPhrase(req: ApprovalRequest): string {
  const targetPart = req.target ? ` ${req.target}` : "";
  return `CONFIRM ${req.tool_name}${targetPart}`;
}

// ─── Verification (pure) ──────────────────────────────────────────────────────

export type GrantRejection =
  | "action_mismatch"
  | "expired"
  | "level_exceeds_grant"
  | "scope_tool_mismatch"
  | "scope_path_mismatch"
  | "scope_session_mismatch"
  | "overbroad_scope"
  | "missing_confirmation"
  | "wrong_confirmation";

export interface GrantVerifyResult {
  ok: boolean;
  rejection?: GrantRejection;
  detail?: string;
}

/** Longest a grant may remain valid. Enforces "scoped in time, never forever." */
export const MAX_GRANT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Path globs that authorize essentially everything — never allowed in a scope. */
const CATCH_ALL_GLOBS = new Set(["*", "**", "**/*", "/**", "**/**"]);

/**
 * Verify a grant against the request it is meant to authorize, at time `now`.
 * Pure: no I/O, no clock of its own. Returns the first failing reason.
 */
export function verifyGrant(
  grant: ApprovalGrant,
  req: ApprovalRequest,
  now: Date,
): GrantVerifyResult {
  // 0. The grant must reference THIS action.
  if (grant.action_id !== req.action_id) {
    return { ok: false, rejection: "action_mismatch", detail: "grant is for a different action" };
  }

  // 1. Reject overbroad ("approve everything") scopes outright.
  const overbroad = findOverbreadth(grant, now);
  if (overbroad) {
    return { ok: false, rejection: "overbroad_scope", detail: overbroad };
  }

  // 2. Expiry — a grant past its expires_at is dead.
  const expiresAt = Date.parse(grant.expires_at);
  if (Number.isNaN(expiresAt)) {
    return { ok: false, rejection: "expired", detail: "expires_at is not a valid timestamp" };
  }
  if (now.getTime() >= expiresAt) {
    return { ok: false, rejection: "expired", detail: `expired at ${grant.expires_at}` };
  }

  // 3. Level — the action's level must not exceed what the grant authorizes.
  if (req.permission_level > grant.scope.max_level) {
    return {
      ok: false,
      rejection: "level_exceeds_grant",
      detail: `action is level ${String(req.permission_level)}; grant authorizes up to ${String(grant.scope.max_level)}`,
    };
  }

  // 4. Tool — must be explicitly listed.
  if (!grant.scope.tools.includes(req.tool_name)) {
    return {
      ok: false,
      rejection: "scope_tool_mismatch",
      detail: `tool "${req.tool_name}" not in grant scope`,
    };
  }

  // 5. Path — the target must match at least one scoped glob.
  if (req.target !== undefined) {
    const matched = grant.scope.path_globs.some((g) => globMatch(g, req.target!));
    if (!matched) {
      return {
        ok: false,
        rejection: "scope_path_mismatch",
        detail: `target "${req.target}" not in grant scope`,
      };
    }
  }

  // 6. Session — the grant is bound to a session.
  if (grant.scope.session_id !== req.session_id) {
    return {
      ok: false,
      rejection: "scope_session_mismatch",
      detail: "grant is bound to a different session",
    };
  }

  // 7. Level 5 — a correct manual confirmation phrase is mandatory.
  if (req.permission_level >= 5) {
    if (!grant.confirmation_phrase) {
      return {
        ok: false,
        rejection: "missing_confirmation",
        detail: "level 5 requires a manual confirmation phrase",
      };
    }
    if (grant.confirmation_phrase !== requiredConfirmationPhrase(req)) {
      return {
        ok: false,
        rejection: "wrong_confirmation",
        detail: "confirmation phrase does not match this action",
      };
    }
  }

  return { ok: true };
}

/**
 * Returns a human-readable reason if the grant's scope is overbroad, else null.
 * An overbroad scope is one that is unbounded in tool, path, or time.
 */
function findOverbreadth(grant: ApprovalGrant, now: Date): string | null {
  const { scope } = grant;
  if (scope.tools.length === 0) return "scope authorizes no specific tool";
  if (scope.tools.includes("*")) return 'scope tool list contains a wildcard "*"';
  if (scope.path_globs.length === 0) return "scope authorizes no specific path";
  const catchAll = scope.path_globs.find((g) => CATCH_ALL_GLOBS.has(g.trim()));
  if (catchAll) return `scope path "${catchAll}" matches everything`;
  if (!scope.session_id) return "scope is not bound to a session";

  // Time-unbounded: a grant whose lifetime exceeds the cap is "forever-ish".
  const approvedAt = Date.parse(grant.approved_at);
  const expiresAt = Date.parse(grant.expires_at);
  if (!Number.isNaN(approvedAt) && !Number.isNaN(expiresAt)) {
    if (expiresAt - approvedAt > MAX_GRANT_TTL_MS) {
      return `grant lifetime exceeds the ${String(MAX_GRANT_TTL_MS / 3_600_000)}h cap`;
    }
  }
  // Also reject a grant already issued far in the future relative to now.
  if (!Number.isNaN(expiresAt) && expiresAt - now.getTime() > MAX_GRANT_TTL_MS) {
    return `grant expiry is beyond the ${String(MAX_GRANT_TTL_MS / 3_600_000)}h horizon`;
  }
  return null;
}
