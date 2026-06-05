/**
 * dependencies — license/allowlist gates for newly added deps (Master Plan §8).
 *
 * A package-install command pulls third-party code into the project (framework
 * §15 supply chain). Until a license/allowlist gate exists, an install through
 * run_shell must at least REQUIRE_APPROVAL so it is never silent. This rule
 * activates when a dep-install tool/command is present; it is exercised by
 * tests today and gates real installs once a network/dep tool lands.
 */

import type { PolicyRule, RuleVerdict } from "../types.js";

const INSTALL_PATTERNS = [
  /\bnpm\s+(install|i|add)\b/i,
  /\bpnpm\s+(add|install)\b/i,
  /\byarn\s+add\b/i,
  /\bpip\s+install\b/i,
  /\bpip3\s+install\b/i,
  /\bcargo\s+add\b/i,
  /\bgo\s+get\b/i,
  /\bgem\s+install\b/i,
];

export const dependenciesRule: PolicyRule = {
  id: "dependencies.install_gate",
  evaluate(input): RuleVerdict | null {
    const cmd = input.command;
    if (!cmd) return null;
    if (!INSTALL_PATTERNS.some((re) => re.test(cmd))) return null;
    return {
      decision: input.enterprise ? "DENY" : "REQUIRE_APPROVAL",
      rule_id: "dependencies.install_gate",
      reason: input.enterprise
        ? "dependency install is blocked in enterprise mode pending a license allowlist"
        : "dependency install requires approval (no license allowlist yet)",
    };
  },
};
