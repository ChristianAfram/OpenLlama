/**
 * The policy engine (Master Plan §8, framework §8).
 *
 * Evaluates a proposed action against the bundle of version-controlled rules and
 * returns the most-restrictive decision with a reason code. Deterministic and
 * pure: no I/O, so every decision is exhaustively testable and reproducible.
 *
 * Implementation note. The Master Plan's preferred production form is an
 * OPA/WASM bundle compiled from /policies/*.rego. This engine is the in-process
 * evaluator of the SAME documented policy, implemented natively in TypeScript so
 * OpenLlama stays a single local tool with no external policy server and no
 * native build-time toolchain (framework §15: prefer a small, maintainable local
 * implementation over a fragile dependency). The rule set, decisions, and reason
 * codes are the source of truth; docs/policy.md is the human-readable bundle.
 */

import { moreRestrictive, type PolicyInput, type PolicyResult, type PolicyRule, type RuleVerdict } from "./types.js";
import { agentActionsRule } from "./rules/agent-actions.js";
import { secretsRule } from "./rules/secrets.js";
import { filesystemRule } from "./rules/filesystem.js";
import { gitRule } from "./rules/git.js";
import { dependenciesRule } from "./rules/dependencies.js";
import { networkRule } from "./rules/network.js";
import { modelGovernanceRule } from "./rules/model-governance.js";
import { auditAvailabilityRule } from "./rules/core.js";

/** The default policy bundle, in evaluation order (order is cosmetic — the
 *  aggregation is order-independent: most restrictive always wins). */
export const DEFAULT_BUNDLE: readonly PolicyRule[] = [
  auditAvailabilityRule,
  agentActionsRule,
  secretsRule,
  filesystemRule,
  gitRule,
  dependenciesRule,
  networkRule,
  modelGovernanceRule,
];

/** A stable identifier for the bundle version (bump on rule changes). */
export const POLICY_BUNDLE_VERSION = "openllama-policy-v1";

export class PolicyEngine {
  constructor(private readonly rules: readonly PolicyRule[] = DEFAULT_BUNDLE) {}

  get version(): string {
    return POLICY_BUNDLE_VERSION;
  }

  /**
   * Evaluate an action. Returns the most-restrictive decision across all rules
   * that fired, plus the full list of contributing verdicts for the audit trail.
   * With no firing rule the decision is ALLOW (but agent_actions always fires).
   */
  evaluate(input: PolicyInput): PolicyResult {
    const contributing: RuleVerdict[] = [];
    for (const rule of this.rules) {
      const verdict = rule.evaluate(input);
      if (verdict) contributing.push(verdict);
    }

    // Pick the most-restrictive verdict; on a tie, the first rule that fired
    // wins (evaluation order is the tie-breaker, decisions are not).
    let winner: RuleVerdict | null = null;
    for (const v of contributing) {
      if (winner === null || moreRestrictive(winner.decision, v.decision) !== winner.decision) {
        winner = v;
      }
    }

    const result: RuleVerdict = winner ?? {
      decision: "ALLOW",
      rule_id: "policy.default_allow",
      reason: "no policy rule fired",
    };

    return {
      decision: result.decision,
      rule_id: result.rule_id,
      reason: result.reason,
      contributing,
    };
  }
}

/** A process-wide default engine for callers that don't inject one. */
let _default: PolicyEngine | null = null;
export function getDefaultPolicyEngine(): PolicyEngine {
  return (_default ??= new PolicyEngine());
}
