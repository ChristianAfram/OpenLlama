/**
 * git — protected-branch, force-push, history-rewrite rules (Master Plan §8).
 *
 * Mirrors the illustrative git.rego in the plan:
 *   - force-push / force-with-lease / -f          → REQUIRE_CONFIRMATION
 *   - push to main / master / production           → REQUIRE_CONFIRMATION
 *   - push to release/* or hotfix/*                → REQUIRE_CONFIRMATION
 *
 * The classifier already raises these to L5 (critical); this rule restates the
 * decision with a git-specific reason code so the audit trail explains *why*.
 */

import type { PolicyRule, RuleVerdict } from "../types.js";

const FORCE_TOKENS = ["--force", "--force-with-lease", "-f"];
const PROTECTED_BRANCH = [/^main$/i, /^master$/i, /^production$/i, /^prod$/i];
const PROTECTED_PREFIX = [/^release\//i, /^hotfix\//i];

function isProtectedBranch(branch: string): boolean {
  const b = branch.trim();
  return PROTECTED_BRANCH.some((re) => re.test(b)) || PROTECTED_PREFIX.some((re) => re.test(b));
}

export const gitRule: PolicyRule = {
  id: "git.protected_operations",
  evaluate(input): RuleVerdict | null {
    if (input.tool !== "git" && input.tool !== "git_push") return null;

    // Force-push detection across command string, args, and branch field.
    const haystack = [
      input.command ?? "",
      input.git_branch ?? "",
      ...(input.args ? Object.values(input.args).map((v) => String(v)) : []),
    ]
      .join(" ")
      .toLowerCase();
    if (FORCE_TOKENS.some((tok) => new RegExp(`(^|\\s)${escapeRe(tok)}(\\s|$)`).test(haystack))) {
      return {
        decision: "REQUIRE_CONFIRMATION",
        rule_id: "git.force_push",
        reason: "force-push / history rewrite requires manual confirmation",
      };
    }

    if (input.git_branch !== undefined && isProtectedBranch(input.git_branch)) {
      return {
        decision: "REQUIRE_CONFIRMATION",
        rule_id: "git.protected_branch",
        reason: `push to protected branch "${input.git_branch}" requires manual confirmation`,
      };
    }
    return null;
  },
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
