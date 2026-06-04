/**
 * Prompt 4 classifier tests.
 *
 * Required invariants:
 *   1. Each hard rule classifies correctly (table-driven).
 *   2. Model opinion (raiseLevel) can only raise — never lower — the level.
 *   3. The level is always ≥ the descriptor's declared level.
 *   4. levelToRisk maps levels to the correct RiskLevel bucket.
 *
 * Executor integration invariants (Prompt 4 additions):
 *   5. write_file with destructive content → blocked, no file created.
 *   6. Descriptor denied_paths enforcement catches paths not caught by paths.ts.
 *   7. Normal write_file still executes (no regression).
 *   8. The audit event records the raised permission_level when a rule fires.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, raiseLevel, levelToRisk } from "../src/kernel/classifier.js";
import type { ClassifyInput, ClassifyResult } from "../src/kernel/classifier.js";
import { globMatch } from "../src/lib/glob-match.js";
import { AuditLedger } from "../src/kernel/audit.js";
import { Executor } from "../src/kernel/executor.js";
import { writeFileTool } from "../src/tools/write_file.js";
import type { MutatingTool, PlannedMutation, ToolDescriptor } from "../src/tools/registry.js";
import { z } from "zod";

// ─── Invariant 1: hard rules table ────────────────────────────────────────────

type RuleCase = [
  description: string,
  input: ClassifyInput,
  expected_level: number,
  expected_rule_id: string,
];

const BASE: Pick<ClassifyInput, "descriptor_level" | "descriptor_requires_approval"> = {
  descriptor_level: 3,
  descriptor_requires_approval: false,
};

const RULE_CASES: RuleCase[] = [
  // ── Baseline: no hard rule fires ──────────────────────────────────────────
  [
    "normal file write — stays at descriptor level",
    { ...BASE, target: "notes.txt", content: "hello world\n" },
    3,
    "DESCRIPTOR_DEFAULT",
  ],
  [
    "empty content — stays at descriptor level",
    { ...BASE, target: "readme.txt", content: "" },
    3,
    "DESCRIPTOR_DEFAULT",
  ],
  [
    "descriptor L0 — stays at L0",
    { descriptor_level: 0, descriptor_requires_approval: false, target: "read.txt" },
    0,
    "DESCRIPTOR_DEFAULT",
  ],

  // ── R1: Destructive command tokens ────────────────────────────────────────
  [
    "rm -rf in content → L5",
    { ...BASE, content: "#!/bin/bash\nrm -rf /tmp/dir" },
    5,
    "DESTRUCTIVE_COMMAND",
  ],
  [
    "dd if= in content → L5",
    { ...BASE, content: "dd if=/dev/zero of=/dev/sda bs=1M" },
    5,
    "DESTRUCTIVE_COMMAND",
  ],
  [
    "mkfs in content → L5",
    { ...BASE, content: "mkfs.ext4 /dev/sdb1" },
    5,
    "DESTRUCTIVE_COMMAND",
  ],
  [
    "git push --force in content → L5",
    { ...BASE, content: "git push --force origin main" },
    5,
    "DESTRUCTIVE_COMMAND",
  ],
  [
    "git push -f in content → L5",
    { ...BASE, content: "git push -f origin main" },
    5,
    "DESTRUCTIVE_COMMAND",
  ],
  [
    "DROP TABLE in content → L5 (case-insensitive)",
    { ...BASE, content: "DROP TABLE users;" },
    5,
    "DESTRUCTIVE_COMMAND",
  ],
  [
    "drop database in content → L5",
    { ...BASE, content: "drop database myapp;" },
    5,
    "DESTRUCTIVE_COMMAND",
  ],
  [
    "TRUNCATE TABLE in content → L5",
    { ...BASE, content: "TRUNCATE TABLE audit_log;" },
    5,
    "DESTRUCTIVE_COMMAND",
  ],
  [
    "truncate command (with space) in content → L5",
    { ...BASE, content: "truncate -s 0 logfile.log" },
    5,
    "DESTRUCTIVE_COMMAND",
  ],
  [
    "git reset --hard in content → L5",
    { ...BASE, content: "git reset --hard HEAD~1" },
    5,
    "DESTRUCTIVE_COMMAND",
  ],
  [
    "fork bomb in content → L5",
    { ...BASE, content: ":(){ :|:& };:" },
    5,
    "DESTRUCTIVE_COMMAND",
  ],
  [
    "shred in content → L5",
    { ...BASE, content: "shred -u secret.txt" },
    5,
    "DESTRUCTIVE_COMMAND",
  ],
  [
    "destructive token in command field → L5",
    { ...BASE, command: "rm -rf /var/log" },
    5,
    "DESTRUCTIVE_COMMAND",
  ],
  [
    "destructive token mixed case → L5",
    { ...BASE, content: "RM -RF /home/user" },
    5,
    "DESTRUCTIVE_COMMAND",
  ],
  [
    "content with 'truncated' (word boundary OK) — stays at L3",
    { ...BASE, content: "const truncated = str.slice(0, 100);" },
    3,
    "DESCRIPTOR_DEFAULT",
  ],

  // ── R2: Protected target paths ─────────────────────────────────────────────
  [
    "target .env → L5",
    { ...BASE, target: ".env" },
    5,
    "PROTECTED_TARGET",
  ],
  [
    "target .env.local → L5",
    { ...BASE, target: ".env.local" },
    5,
    "PROTECTED_TARGET",
  ],
  [
    "target subdir/.env → L5",
    { ...BASE, target: "subdir/.env" },
    5,
    "PROTECTED_TARGET",
  ],
  [
    "target .git/config → L5",
    { ...BASE, target: ".git/config" },
    5,
    "PROTECTED_TARGET",
  ],
  [
    "target .github/workflows/ci.yml → L5",
    { ...BASE, target: ".github/workflows/ci.yml" },
    5,
    "PROTECTED_TARGET",
  ],
  [
    "target secrets/api-key.json → L5",
    { ...BASE, target: "secrets/api-key.json" },
    5,
    "PROTECTED_TARGET",
  ],
  [
    "target id_rsa → L5",
    { ...BASE, target: "id_rsa" },
    5,
    "PROTECTED_TARGET",
  ],
  [
    "target regular source file — stays at L3",
    { ...BASE, target: "src/index.ts" },
    3,
    "DESCRIPTOR_DEFAULT",
  ],

  // ── R3: Protected branches ─────────────────────────────────────────────────
  [
    "git_branch main → L5",
    { ...BASE, git_branch: "main" },
    5,
    "PROTECTED_BRANCH",
  ],
  [
    "git_branch master → L5",
    { ...BASE, git_branch: "master" },
    5,
    "PROTECTED_BRANCH",
  ],
  [
    "git_branch MAIN (uppercase) → L5",
    { ...BASE, git_branch: "MAIN" },
    5,
    "PROTECTED_BRANCH",
  ],
  [
    "git_branch production → L5",
    { ...BASE, git_branch: "production" },
    5,
    "PROTECTED_BRANCH",
  ],
  [
    "git_branch release/v2.0 → L5",
    { ...BASE, git_branch: "release/v2.0" },
    5,
    "PROTECTED_BRANCH",
  ],
  [
    "git_branch hotfix/CVE-2025-001 → L5",
    { ...BASE, git_branch: "hotfix/CVE-2025-001" },
    5,
    "PROTECTED_BRANCH",
  ],
  [
    "git_branch feature/my-feature — stays at L3",
    { ...BASE, git_branch: "feature/my-feature" },
    3,
    "DESCRIPTOR_DEFAULT",
  ],
  [
    "git_branch dev — stays at L3",
    { ...BASE, git_branch: "dev" },
    3,
    "DESCRIPTOR_DEFAULT",
  ],

  // ── R4: requires_approval flag ─────────────────────────────────────────────
  [
    "descriptor requires_approval → at least L4",
    { descriptor_level: 3, descriptor_requires_approval: true },
    4,
    "REQUIRES_APPROVAL",
  ],
  [
    "descriptor requires_approval with higher descriptor level → keeps descriptor level",
    { descriptor_level: 4, descriptor_requires_approval: true },
    4,
    "REQUIRES_APPROVAL",
  ],
];

describe("classifier: hard rule table", () => {
  it.each(RULE_CASES)("%s", (_desc, input, expectedLevel, expectedRuleId) => {
    const result = classify(input);
    expect(result.level).toBe(expectedLevel);
    expect(result.rule_id).toBe(expectedRuleId);
    expect(result.reason).toBeTruthy();
  });
});

// ─── Invariant 2 & 3: raiseLevel and floor guarantees ─────────────────────────

describe("raiseLevel: model opinion can only raise — never lower", () => {
  it("does not lower an L5 result to L2", () => {
    const r: ClassifyResult = { level: 5, rule_id: "DESTRUCTIVE_COMMAND", reason: "rm -rf" };
    expect(raiseLevel(r, 2)).toStrictEqual(r);
  });

  it("does not lower an L5 result to L5 (no-op)", () => {
    const r: ClassifyResult = { level: 5, rule_id: "DESTRUCTIVE_COMMAND", reason: "rm -rf" };
    expect(raiseLevel(r, 5)).toStrictEqual(r);
  });

  it("raises an L3 result to L4", () => {
    const r: ClassifyResult = { level: 3, rule_id: "DESCRIPTOR_DEFAULT", reason: "default" };
    const raised = raiseLevel(r, 4, "external_reviewer");
    expect(raised.level).toBe(4);
    expect(raised.rule_id).toBe("EXTERNAL_REVIEWER");
  });

  it("raises an L3 result to L5", () => {
    const r: ClassifyResult = { level: 3, rule_id: "DESCRIPTOR_DEFAULT", reason: "default" };
    const raised = raiseLevel(r, 5);
    expect(raised.level).toBe(5);
  });

  it("preserves original result when opinion equals current level", () => {
    const r: ClassifyResult = { level: 3, rule_id: "DESCRIPTOR_DEFAULT", reason: "default" };
    expect(raiseLevel(r, 3)).toStrictEqual(r);
  });
});

describe("classify: level always ≥ descriptor_level", () => {
  it("never returns a level below the descriptor floor", () => {
    const inputs: ClassifyInput[] = [
      { descriptor_level: 4, descriptor_requires_approval: false },
      { descriptor_level: 5, descriptor_requires_approval: false },
      { descriptor_level: 5, descriptor_requires_approval: false, git_branch: "feature/x" },
    ];
    for (const input of inputs) {
      const result = classify(input);
      expect(result.level).toBeGreaterThanOrEqual(input.descriptor_level);
    }
  });
});

// ─── Invariant 4: levelToRisk ──────────────────────────────────────────────────

describe("levelToRisk", () => {
  const cases: [number, string][] = [
    [0, "low"],
    [1, "low"],
    [2, "medium"],
    [3, "medium"],
    [4, "high"],
    [5, "critical"],
  ];
  it.each(cases)("level %i → %s", (level, expected) => {
    expect(levelToRisk(level as 0 | 1 | 2 | 3 | 4 | 5)).toBe(expected);
  });
});

// ─── globMatch unit tests ──────────────────────────────────────────────────────

describe("globMatch", () => {
  it.each([
    // **/ prefix — zero or more leading path segments
    ["**/.env*", ".env", true],
    ["**/.env*", ".env.local", true],
    ["**/.env*", "subdir/.env", true],
    ["**/.env*", "a/b/c/.env.production", true],
    ["**/.env*", "env", false],
    ["**/.env*", "myenv", false],
    // **/.git/** — git internals
    ["**/.git/**", ".git/config", true],
    ["**/.git/**", ".git/hooks/pre-commit", true],
    // **/secrets/** — secrets dir anywhere
    ["**/secrets/**", "secrets/api-key.json", true],
    ["**/secrets/**", "src/secrets/db.json", true],
    ["**/secrets/**", "secret.txt", false],
    // **/.github/workflows/**
    ["**/.github/workflows/**", ".github/workflows/ci.yml", true],
    ["**/.github/workflows/**", ".github/dependabot.yml", false],
    // Single * — within segment
    ["*.txt", "file.txt", true],
    ["*.txt", "dir/file.txt", false],
    // Exact match
    ["package.json", "package.json", true],
    ["package.json", "sub/package.json", false],
  ])("globMatch(%s, %s) → %s", (pattern, path, expected) => {
    expect(globMatch(pattern, path)).toBe(expected);
  });
});

// ─── Executor integration: Prompt 4 additions ─────────────────────────────────

let repo: string;
let ledger: AuditLedger;
let executor: Executor;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "openllama-p4-"));
  ledger = new AuditLedger(join(repo, ".audit.sqlite"));
  executor = new Executor(ledger);
});

afterEach(() => {
  ledger.close();
  rmSync(repo, { recursive: true, force: true });
});

const ctx = () => ({ repoRoot: repo });

// ─── Invariant 5: destructive content → blocked, no file ──────────────────────

describe("Invariant 5: write_file with destructive content is blocked", () => {
  it("blocks content containing rm -rf and creates no file", async () => {
    const outcome = await executor.execute(
      writeFileTool,
      { path: "cleanup.sh", content: "#!/bin/bash\nrm -rf /tmp/data\n" },
      { ledger, ctx: ctx() },
    );

    expect(outcome.status).toBe("blocked");
    expect(existsSync(join(repo, "cleanup.sh"))).toBe(false);

    const ev = ledger.getEvents().find((e) => e.tool_name === "write_file");
    expect(ev).toBeDefined();
    expect(ev!.result).toBe("blocked");
    expect(ev!.permission_level).toBe(5);
  });

  it("blocks content with DROP TABLE and creates no file", async () => {
    const outcome = await executor.execute(
      writeFileTool,
      { path: "migrate.sql", content: "DROP TABLE users;\n" },
      { ledger, ctx: ctx() },
    );

    expect(outcome.status).toBe("blocked");
    expect(existsSync(join(repo, "migrate.sql"))).toBe(false);
  });

  it("blocks content with git push --force and creates no file", async () => {
    const outcome = await executor.execute(
      writeFileTool,
      { path: "deploy.sh", content: "git push --force origin main\n" },
      { ledger, ctx: ctx() },
    );

    expect(outcome.status).toBe("blocked");
    expect(existsSync(join(repo, "deploy.sh"))).toBe(false);
  });

  it("the blocked event records the raised permission_level (5) and rule", async () => {
    const outcome = await executor.execute(
      writeFileTool,
      { path: "wipe.sh", content: "mkfs.ext4 /dev/sdb" },
      { ledger, ctx: ctx() },
    );

    expect(outcome.status).toBe("blocked");
    const ev = ledger.getEvents().find((e) => e.tool_name === "write_file");
    expect(ev!.permission_level).toBe(5);
    expect(ev!.risk_level).toBe("critical");
    expect(ev!.policy_reason).toMatch(/destructive token/i);
  });
});

// ─── Invariant 6: descriptor denied_paths enforcement ─────────────────────────

describe("Invariant 6: executor enforces descriptor denied_paths independently", () => {
  /**
   * A minimal tool with custom denied_paths — does not call resolveWithinRepo
   * itself, so the executor's descriptor-level check is the only guard.
   */
  function makeTool(deniedPaths: string[]): MutatingTool {
    const desc: ToolDescriptor = {
      name: "test_tool",
      description: "test",
      permission_level: 3,
      risk_level: "low",
      allowed_paths: ["${REPO_ROOT}/**"],
      denied_paths: deniedPaths,
      requires_approval: false,
      audit_required: true,
      rate_limit: "60/min",
      rollback: "none",
    };
    return {
      descriptor: desc,
      schema: z.object({ target: z.string() }),
      plan(args: { target: string }) {
        const planned: PlannedMutation = {
          target: args.target,
          data_changed: [],
          rollback_path: "none",
          summary: `wrote ${args.target}`,
          apply() {},
        };
        return planned;
      },
    } as MutatingTool;
  }

  it("blocks a target matching a custom denied path pattern", async () => {
    const tool = makeTool(["**/private/**"]);
    const outcome = await executor.execute(
      tool,
      { target: "private/notes.txt" },
      { ledger, ctx: ctx() },
    );
    expect(outcome.status).toBe("blocked");
    if (outcome.status === "blocked") {
      expect(outcome.reason).toContain("denied path");
    }
  });

  it("allows a target that does not match any denied path", async () => {
    const tool = makeTool(["**/private/**"]);
    const outcome = await executor.execute(
      tool,
      { target: "public/notes.txt" },
      { ledger, ctx: ctx() },
    );
    // Should execute (no other rules fire for this tool)
    expect(outcome.status).toBe("executed");
  });
});

// ─── Invariant 7: normal write_file still executes (no regression) ────────────

describe("Invariant 7: normal write_file still executes after Prompt 4 changes", () => {
  it("creates the file and returns executed", async () => {
    const outcome = await executor.execute(
      writeFileTool,
      { path: "hello.txt", content: "safe content\n" },
      { ledger, ctx: ctx() },
    );

    expect(outcome.status).toBe("executed");
    expect(existsSync(join(repo, "hello.txt"))).toBe(true);
  });
});

// ─── Invariant 8: audit event records raised level ────────────────────────────

describe("Invariant 8: audit event records classified permission_level", () => {
  it("records permission_level 3 (descriptor default) for a normal write", async () => {
    await executor.execute(
      writeFileTool,
      { path: "normal.txt", content: "just text" },
      { ledger, ctx: ctx() },
    );
    const ev = ledger.getEvents().find((e) => e.tool_name === "write_file")!;
    expect(ev.permission_level).toBe(3);
    expect(ev.risk_level).toBe("medium");
  });

  it("records permission_level 5 and risk_level critical for a destructive write", async () => {
    await executor.execute(
      writeFileTool,
      { path: "destroy.sh", content: "rm -rf /" },
      { ledger, ctx: ctx() },
    );
    const ev = ledger.getEvents().find((e) => e.tool_name === "write_file")!;
    expect(ev.permission_level).toBe(5);
    expect(ev.risk_level).toBe("critical");
  });
});
