/**
 * Policy-as-code: types (Master Plan §8, framework §8).
 *
 * The policy engine evaluates a proposed action and returns one of four
 * decisions with a reason code. It is the version-controlled, reviewed-like-code
 * layer that sits between risk classification and the approval gate: the
 * classifier says HOW risky an action is; policy says WHAT to do about it
 * (allow, deny, require approval, require manual confirmation).
 *
 * The engine is deterministic and pure — no I/O — so every decision is
 * exhaustively testable, and the same bundle that governs the agent governs the
 * project's own changes in CI.
 */

import type { PermissionLevel, RiskLevel } from "../kernel/audit.js";

/** The four policy decisions, mirroring the audit event's policy_decision. */
export type PolicyDecision =
  | "ALLOW"
  | "REQUIRE_APPROVAL"
  | "REQUIRE_CONFIRMATION"
  | "DENY";

/** Strictness ordering — higher wins when rules disagree (most restrictive). */
const DECISION_RANK: Record<PolicyDecision, number> = {
  ALLOW: 0,
  REQUIRE_APPROVAL: 1,
  REQUIRE_CONFIRMATION: 2,
  DENY: 3,
};

/** Return the more restrictive of two decisions. */
export function moreRestrictive(a: PolicyDecision, b: PolicyDecision): PolicyDecision {
  return DECISION_RANK[a] >= DECISION_RANK[b] ? a : b;
}

export function isAtLeastAsRestrictive(a: PolicyDecision, b: PolicyDecision): boolean {
  return DECISION_RANK[a] >= DECISION_RANK[b];
}

/** Everything a policy rule may inspect about a proposed action. */
export interface PolicyInput {
  /** Tool name, e.g. edit_file / run_shell / git. */
  tool: string;
  /** The classified permission level (0–5). */
  permission_level: PermissionLevel;
  /** The classified risk level. */
  risk_level: RiskLevel;
  /** Target resource (repo-relative path, "git:push:origin/main", "shell:…"). */
  target?: string;
  /** Raw, schema-validated tool arguments. */
  args?: Record<string, unknown>;
  /** For shell tools: the command string. */
  command?: string;
  /** For git tools: the branch being pushed/created. */
  git_branch?: string;
  /** Whether the action reads or writes a secret path. */
  secret_path?: boolean;
  /** Whether the audit subsystem is currently writable. */
  audit_available?: boolean;
  /** Network egress destination, if the action makes one. */
  egress_domain?: string;
  /** Model driving the action and whether it passed its eval gates. */
  model?: string;
  model_eval_passed?: boolean;
  /** Hard-block mode: policy violations cannot be downgraded. */
  enterprise?: boolean;
  /** For MCP tools: whether the originating server is on the enterprise allowlist. */
  mcp_server_allowlisted?: boolean;
}

/** A single rule's contribution. A rule returns null when it does not apply. */
export interface RuleVerdict {
  decision: PolicyDecision;
  rule_id: string;
  reason: string;
}

/** A policy rule: a pure function over the input. */
export interface PolicyRule {
  id: string;
  evaluate(input: PolicyInput): RuleVerdict | null;
}

/** The aggregated result of evaluating the whole bundle. */
export interface PolicyResult {
  decision: PolicyDecision;
  /** The rule that set the winning (most-restrictive) decision. */
  rule_id: string;
  reason: string;
  /** Every rule that fired, for transparency / audit. */
  contributing: RuleVerdict[];
}
