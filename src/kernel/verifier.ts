/**
 * Independent verifier — second-opinion safety check for High/Critical actions.
 *
 * The verifier is a separate component that reviews proposed actions
 * independently of the classifier and policy engine. It runs BEFORE the
 * approval gate: a BLOCK verdict is terminal — no approval can rescue a
 * verifier-blocked action.
 *
 * This implements the framework §24 "independent verifier" requirement for
 * high and critical risk changes.
 *
 * Implementations:
 *   RuleBasedVerifier — deterministic, model-free. Uses the same hard-rule
 *                       signal as the classifier but as an independent layer
 *                       (defense in depth). Used in CI and all unit tests.
 *   NullVerifier      — APPROVE-all. Use in tests that don't need verifier
 *                       interference.
 *
 * The ModelVerifier (live second model instance) is a future milestone; the
 * interface is stable so it can be added without changing callers.
 */

import {
  DESTRUCTIVE_TOKENS,
  PROTECTED_BRANCH_PATTERNS,
  PROTECTED_TARGET_FRAGMENTS,
} from "./classifier.js";
import type { PermissionLevel, RiskLevel } from "./audit.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface VerifierAction {
  tool: string;
  permission_level: PermissionLevel;
  risk_level: RiskLevel;
  target?: string;
  command?: string;
  git_branch?: string;
  summary: string;
}

export type VerifierVerdict = "APPROVE" | "BLOCK";

export interface VerifierResult {
  verdict: VerifierVerdict;
  reason: string;
  /** Stable identifier: "rule-based", "null", "model:<name>", … */
  verifier_id: string;
}

export interface Verifier {
  /**
   * Second-opinion check for a proposed action. Called for High/Critical
   * actions after the policy engine has evaluated, before the approval gate.
   * A BLOCK is terminal — no approval overrides it.
   */
  verify(action: VerifierAction): Promise<VerifierResult>;
}

// ─── NullVerifier ─────────────────────────────────────────────────────────────

/** Approves everything. Use in tests that don't need verifier interference. */
export class NullVerifier implements Verifier {
  async verify(_action: VerifierAction): Promise<VerifierResult> {
    return {
      verdict: "APPROVE",
      reason: "null verifier — all approved",
      verifier_id: "null",
    };
  }
}

// ─── RuleBasedVerifier ────────────────────────────────────────────────────────

/**
 * Deterministic, model-free verifier.
 *
 * Applies the same hard-rule signal as the classifier independently — if the
 * classifier or policy engine somehow permitted a known-bad action, this layer
 * catches it. The verifier's independence comes from being a separate decision
 * point with its own rule evaluation, not from being a different code path for
 * every byte — sharing the constant lists is fine; the key is that the check
 * runs again, separately, inside the pipeline.
 *
 * Exit criterion (Prompt 9): tests prove this blocks a known-bad action.
 */
export class RuleBasedVerifier implements Verifier {
  async verify(action: VerifierAction): Promise<VerifierResult> {
    const id = "rule-based";

    // ── Destructive command/summary scan ─────────────────────────────────────
    const text = (action.command ?? action.summary).toLowerCase();
    for (const token of DESTRUCTIVE_TOKENS) {
      if (text.includes(token.toLowerCase())) {
        return {
          verdict: "BLOCK",
          reason: `verifier: destructive token "${token}" in action`,
          verifier_id: id,
        };
      }
    }

    // ── Protected / secret target ─────────────────────────────────────────────
    if (action.target) {
      const normalized = action.target.toLowerCase().replace(/\\/g, "/");
      for (const frag of PROTECTED_TARGET_FRAGMENTS) {
        const f = frag.toLowerCase();
        const dirPrefix = f.endsWith("/") ? f : f + "/";
        if (
          normalized === f ||
          normalized.startsWith(dirPrefix) ||
          normalized.includes("/" + f) ||
          (f.startsWith(".") && normalized.startsWith(f))
        ) {
          return {
            verdict: "BLOCK",
            reason: `verifier: target matches protected path fragment "${frag}"`,
            verifier_id: id,
          };
        }
      }
    }

    // ── Protected branch ──────────────────────────────────────────────────────
    if (action.git_branch) {
      const trimmed = action.git_branch.trim();
      for (const re of PROTECTED_BRANCH_PATTERNS) {
        if (re.test(trimmed)) {
          return {
            verdict: "BLOCK",
            reason: `verifier: git_branch "${action.git_branch}" is a protected branch`,
            verifier_id: id,
          };
        }
      }
    }

    return {
      verdict: "APPROVE",
      reason: "rule-based checks passed",
      verifier_id: id,
    };
  }
}
