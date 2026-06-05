/**
 * model_governance — only eval-passed models may run (Master Plan §8/§11/§22).
 *
 * Minimum policy behavior: "If the target model has not passed its eval suite →
 * DENY model load." When the caller supplies model + model_eval_passed, a model
 * that has not passed its evals cannot drive a gated action.
 */

import type { PolicyRule, RuleVerdict } from "../types.js";

export const modelGovernanceRule: PolicyRule = {
  id: "model_governance.eval_gate",
  evaluate(input): RuleVerdict | null {
    // Only meaningful when the caller asserts an eval status.
    if (input.model_eval_passed === undefined) return null;
    if (input.model_eval_passed) return null;
    return {
      decision: "DENY",
      rule_id: "model_governance.evals_not_passed",
      reason: `model "${input.model ?? "(unknown)"}" has not passed its required eval suite`,
    };
  },
};
