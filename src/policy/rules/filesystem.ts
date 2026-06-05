/**
 * filesystem — path allowlists, repo-root containment (Master Plan §8).
 *
 * Tools already resolve and contain paths (resolveWithinRepo throws on escape),
 * so an escaping target should never reach policy. This rule is defense in
 * depth: if a target shows a path-traversal marker or an absolute path outside
 * the repo, DENY with an explicit reason.
 */

import type { PolicyRule, RuleVerdict } from "../types.js";

export const filesystemRule: PolicyRule = {
  id: "filesystem.containment",
  evaluate(input): RuleVerdict | null {
    const target = input.target;
    if (target === undefined) return null;
    // Synthetic targets (shell:…, git:…) are not filesystem paths.
    if (target.includes(":")) return null;
    const normalized = target.replace(/\\/g, "/");
    const escapes =
      normalized.split("/").includes("..") || normalized === "..";
    if (!escapes) return null;
    return {
      decision: "DENY",
      rule_id: "filesystem.repo_root_escape",
      reason: `target escapes the repository root: "${target}"`,
    };
  },
};
