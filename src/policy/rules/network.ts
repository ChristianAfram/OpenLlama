/**
 * network — egress allowlist; block exfil patterns (Master Plan §8).
 *
 * Minimum policy behavior: "If egress domain not in allowlist → REQUIRES_APPROVAL
 * and record destination." In enterprise mode a non-allowlisted destination is a
 * hard DENY. The default allowlist is empty (local-first: the agent makes no
 * outbound calls), so any egress is gated. Activates when a network-capable tool
 * lands; exercised by tests today.
 */

import type { PolicyRule, RuleVerdict } from "../types.js";

/** Default egress allowlist — empty by design (local-first). */
const DEFAULT_ALLOWLIST: readonly string[] = [];

function isAllowlisted(domain: string): boolean {
  const d = domain.toLowerCase();
  return DEFAULT_ALLOWLIST.some((allowed) => d === allowed || d.endsWith("." + allowed));
}

export const networkRule: PolicyRule = {
  id: "network.egress_allowlist",
  evaluate(input): RuleVerdict | null {
    const domain = input.egress_domain;
    if (!domain) return null;
    if (isAllowlisted(domain)) return null;
    return {
      decision: input.enterprise ? "DENY" : "REQUIRE_APPROVAL",
      rule_id: "network.egress_not_allowlisted",
      reason: `network egress to non-allowlisted destination "${domain}"`,
    };
  },
};
