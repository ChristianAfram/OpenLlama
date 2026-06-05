/**
 * core — cross-cutting minimum policy behavior (Master Plan §8).
 *
 * "If audit logging is unavailable → DENY all high/critical actions."
 *
 * The no-audit-no-action invariant already aborts a mutation whose audit write
 * fails (the executor returns audit_failed with no side effect). This rule makes
 * the intent explicit at policy time: when the caller knows audit is down, a
 * high/critical action is denied before it is even attempted.
 */

import type { PolicyRule, RuleVerdict } from "../types.js";

export const auditAvailabilityRule: PolicyRule = {
  id: "core.audit_required",
  evaluate(input): RuleVerdict | null {
    if (input.audit_available !== false) return null;
    if (input.risk_level === "high" || input.risk_level === "critical") {
      return {
        decision: "DENY",
        rule_id: "core.audit_unavailable",
        reason: "audit logging is unavailable; high/critical actions are denied",
      };
    }
    return null;
  },
};
