/**
 * agent_actions — permission-level enforcement for every tool call.
 *
 * The baseline rule every action passes through: map the classified permission
 * level to a policy decision (Master Plan §7/§8).
 *
 *   L0–L3  → ALLOW            (logged; no approval)
 *   L4     → REQUIRE_APPROVAL (scoped, expiring grant)
 *   L5     → REQUIRE_CONFIRMATION (manual, action-specific phrase, every time)
 *
 * "Default for anything unclassified: Level 4" is enforced upstream by the
 * classifier (which never returns below the descriptor floor); here we simply
 * honour the level it produced.
 */

import type { PolicyRule, RuleVerdict } from "../types.js";

export const agentActionsRule: PolicyRule = {
  id: "agent_actions.permission_level",
  evaluate(input): RuleVerdict | null {
    if (input.permission_level >= 5) {
      return {
        decision: "REQUIRE_CONFIRMATION",
        rule_id: "agent_actions.level_5",
        reason: "level 5 action requires manual confirmation every time",
      };
    }
    if (input.permission_level >= 4) {
      return {
        decision: "REQUIRE_APPROVAL",
        rule_id: "agent_actions.level_4",
        reason: "level 4 action requires a scoped, expiring approval grant",
      };
    }
    // L0–L3: allowed, still audited. Return an explicit ALLOW so the decision is
    // attributable to a rule rather than a silent default.
    return {
      decision: "ALLOW",
      rule_id: "agent_actions.level_0_3",
      reason: `level ${String(input.permission_level)} action is allowed and logged`,
    };
  },
};
