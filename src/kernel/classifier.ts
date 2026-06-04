/**
 * Deterministic risk classifier — Prompt 4.
 *
 * Maps every proposed action to a PermissionLevel (0–5). Hard rules are
 * deterministic and evaluated against every input field; the final level is the
 * maximum across all firing rules (never lower than the descriptor default).
 * An optional model opinion may only RAISE the level further — never lower it.
 *
 * Design invariants (framework §5, §41, §42, §58):
 *   - Unknown / unclassified action → descriptor default (at least L3 for mutations).
 *   - Destructive command tokens in content or command → always L5.
 *   - Protected branch target (main, master, release/*, …) → always L5.
 *   - Protected / secret target path → always L5.
 *   - Descriptor declares requires_approval → at least L4.
 *   - Model opinion, if supplied, can only raise (call raiseLevel()).
 */

import type { PermissionLevel, RiskLevel } from "./audit.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ClassifyInput {
  /** Floor: the permission level declared in the tool descriptor. */
  descriptor_level: PermissionLevel;
  /** Whether the descriptor declares the action requires explicit approval. */
  descriptor_requires_approval: boolean;
  /** Planned target resource (repo-relative path, branch name, URL, …). */
  target?: string;
  /**
   * String content being written (file body, command string, …).
   * The classifier scans this for dangerous tokens.
   */
  content?: string;
  /** For git tools: the branch being written to. */
  git_branch?: string;
  /** For shell tools: the command string being executed. */
  command?: string;
}

export interface ClassifyResult {
  /** The final permission level — always ≥ descriptor_level. */
  level: PermissionLevel;
  /** Human-readable reason. "descriptor default" if no hard rule fired. */
  reason: string;
  /** Stable identifier for the rule that set the level. */
  rule_id: string;
}

// ─── Main entry points ────────────────────────────────────────────────────────

/**
 * Classify an action. The returned level is always ≥ input.descriptor_level.
 *
 * If you have a model opinion, apply it afterwards with `raiseLevel()`.
 */
export function classify(input: ClassifyInput): ClassifyResult {
  let best: ClassifyResult = {
    level: input.descriptor_level,
    reason: "descriptor default",
    rule_id: "DESCRIPTOR_DEFAULT",
  };

  // Use >= so that hard rules override the DESCRIPTOR_DEFAULT even when the
  // classified level equals the descriptor floor (e.g. requires_approval at L4).
  function consider(candidate: ClassifyResult): void {
    if (candidate.level >= best.level) best = candidate;
  }

  // ── R1: Destructive command tokens ────────────────────────────────────────
  // Scans both the written content and any explicit command string.
  const textToScan = [input.content, input.command].filter(Boolean).join("\n");
  const destructiveToken = findDestructiveToken(textToScan);
  if (destructiveToken !== null) {
    consider({
      level: 5,
      rule_id: "DESTRUCTIVE_COMMAND",
      reason: `content contains destructive token: "${destructiveToken}"`,
    });
  }

  // ── R2: Protected / secret target path ───────────────────────────────────
  // Belt-and-suspenders: paths.ts already blocks these at the tool level.
  if (input.target !== undefined && isProtectedTarget(input.target)) {
    consider({
      level: 5,
      rule_id: "PROTECTED_TARGET",
      reason: `target is a protected path: "${input.target}"`,
    });
  }

  // ── R3: Protected branch (git push / create) ──────────────────────────────
  if (input.git_branch !== undefined && isProtectedBranch(input.git_branch)) {
    consider({
      level: 5,
      rule_id: "PROTECTED_BRANCH",
      reason: `target branch is protected: "${input.git_branch}"`,
    });
  }

  // ── R4: Descriptor-declared approval requirement ──────────────────────────
  if (input.descriptor_requires_approval) {
    consider({
      level: 4,
      rule_id: "REQUIRES_APPROVAL",
      reason: "tool descriptor declares requires_approval = true",
    });
  }

  return best;
}

/**
 * Apply an external opinion (e.g., from a model) to a classification result.
 * The opinion may only RAISE the level — it can never lower it.
 * Returns a new result; does not mutate the original.
 */
export function raiseLevel(
  result: ClassifyResult,
  opinion: PermissionLevel,
  source = "model_opinion",
): ClassifyResult {
  if (opinion <= result.level) return result;
  return {
    level: opinion,
    rule_id: source.toUpperCase().replace(/\s+/g, "_"),
    reason: `raised to level ${String(opinion)} by ${source}`,
  };
}

/**
 * Map a PermissionLevel to the coarser RiskLevel used in audit events.
 */
export function levelToRisk(level: PermissionLevel): RiskLevel {
  if (level >= 5) return "critical";
  if (level >= 4) return "high";
  if (level >= 2) return "medium";
  return "low";
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Tokens whose presence in written content (file body or command string)
 * indicates a destructive action that requires manual confirmation (L5).
 *
 * All comparisons are case-insensitive. Entries with trailing spaces prevent
 * matching within longer identifiers (e.g. "truncated" ≠ "truncate ").
 */
const DESTRUCTIVE_TOKENS: readonly string[] = [
  "rm -rf",
  "rm -r ",
  "rm -fr",
  "dd if=",
  "mkfs",
  ":(){ :|:& };:",
  ":(){:|:&};:",
  "git push --force",
  "git push -f ",
  "git push -f\t",
  "drop table",
  "drop database",
  "drop schema",
  "truncate table",
  "truncate ",
  "format c:",
  "deltree ",
  "> /dev/sda",
  "shred ",
  "git reset --hard",
  "git clean -fd",
  "git clean -f ",
];

function findDestructiveToken(text: string): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const token of DESTRUCTIVE_TOKENS) {
    if (lower.includes(token.toLowerCase())) {
      return token;
    }
  }
  return null;
}

/** Path fragments that identify protected/secret targets (case-insensitive). */
const PROTECTED_TARGET_FRAGMENTS: readonly string[] = [
  ".env",
  ".git/config",
  ".git/hooks",
  ".git/packed-refs",
  ".github/workflows",
  "secrets/",
  ".npmrc",
  ".netrc",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "credentials",
  "service-account",
  "auth.json",
];

function isProtectedTarget(target: string): boolean {
  const normalized = target.toLowerCase().replace(/\\/g, "/").replace(/^\/+/, "");
  return PROTECTED_TARGET_FRAGMENTS.some((frag) => {
    const f = frag.toLowerCase();
    // Exact match
    if (normalized === f) return true;
    // File is UNDER a protected directory (e.g. "secrets/key.txt" vs "secrets/")
    const dirPrefix = f.endsWith("/") ? f : f + "/";
    if (normalized.startsWith(dirPrefix)) return true;
    // Protected path appears as a sub-path (e.g. "src/secrets/key.txt")
    if (normalized.includes("/" + f)) return true;
    // Handle dotfile variants: ".env.local", ".env.production", ".envrc", etc.
    // `f` starts with "." and the target starts with f (no separator required).
    if (f.startsWith(".") && normalized.startsWith(f)) return true;
    return false;
  });
}

/** Branch name patterns that are always protected — pushes require L5. */
const PROTECTED_BRANCH_PATTERNS: readonly RegExp[] = [
  /^main$/i,
  /^master$/i,
  /^production$/i,
  /^prod$/i,
  /^release\/.+/i,
  /^hotfix\/.+/i,
];

function isProtectedBranch(branch: string): boolean {
  const trimmed = branch.trim();
  return PROTECTED_BRANCH_PATTERNS.some((re) => re.test(trimmed));
}
