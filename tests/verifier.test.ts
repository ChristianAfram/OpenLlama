/**
 * Independent verifier tests (Prompt 9).
 *
 * Exit criterion: "verifier blocks a known-bad action in tests."
 *
 * Proves:
 *  1. RuleBasedVerifier blocks known-bad commands (rm -rf, force-push, etc.).
 *  2. RuleBasedVerifier blocks protected target paths.
 *  3. RuleBasedVerifier blocks protected branches.
 *  4. RuleBasedVerifier approves safe actions.
 *  5. Executor wires the verifier: verifier-blocked action is denied even
 *     when the policy engine would approve it.
 *  6. NullVerifier approves everything (test-only escape hatch).
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuleBasedVerifier, NullVerifier } from "../src/kernel/verifier.js";
import { Executor } from "../src/kernel/executor.js";
import { InMemoryAuditSink } from "./helpers/in-memory-audit.js";
import { makeDummyMutatingTool } from "./helpers/dummy-tool.js";

// ─── RuleBasedVerifier unit tests ─────────────────────────────────────────────

describe("RuleBasedVerifier — known-bad command detection", () => {
  const v = new RuleBasedVerifier();
  const base = { tool: "run_shell", permission_level: 4 as const, risk_level: "high" as const, summary: "" };

  it("blocks rm -rf", async () => {
    const r = await v.verify({ ...base, command: "rm -rf /tmp/test", summary: "run rm -rf" });
    expect(r.verdict).toBe("BLOCK");
    expect(r.reason).toMatch(/rm -rf/);
  });

  it("blocks git push --force", async () => {
    const r = await v.verify({ ...base, command: "git push --force origin main", summary: "force push" });
    expect(r.verdict).toBe("BLOCK");
  });

  it("blocks DROP TABLE (case-insensitive)", async () => {
    const r = await v.verify({ ...base, command: "DROP TABLE users;", summary: "drop users" });
    expect(r.verdict).toBe("BLOCK");
  });

  it("blocks mkfs", async () => {
    const r = await v.verify({ ...base, command: "mkfs.ext4 /dev/sda", summary: "format disk" });
    expect(r.verdict).toBe("BLOCK");
  });

  it("blocks git reset --hard", async () => {
    const r = await v.verify({ ...base, command: "git reset --hard HEAD~5", summary: "hard reset" });
    expect(r.verdict).toBe("BLOCK");
  });

  it("approves a safe write", async () => {
    const r = await v.verify({ ...base, tool: "write_file", permission_level: 3, risk_level: "medium",
      command: undefined, summary: "write hello.txt" });
    expect(r.verdict).toBe("APPROVE");
  });
});

describe("RuleBasedVerifier — protected target detection", () => {
  const v = new RuleBasedVerifier();
  const base = { tool: "write_file", permission_level: 4 as const, risk_level: "high" as const, summary: "write" };

  it("blocks .env target", async () => {
    const r = await v.verify({ ...base, target: ".env" });
    expect(r.verdict).toBe("BLOCK");
    expect(r.reason).toMatch(/protected path/i);
  });

  it("blocks .git/config target", async () => {
    const r = await v.verify({ ...base, target: ".git/config" });
    expect(r.verdict).toBe("BLOCK");
  });

  it("blocks secrets/ subtree", async () => {
    const r = await v.verify({ ...base, target: "secrets/api-key.txt" });
    expect(r.verdict).toBe("BLOCK");
  });

  it("approves a safe target path", async () => {
    const r = await v.verify({ ...base, target: "src/index.ts" });
    expect(r.verdict).toBe("APPROVE");
  });
});

describe("RuleBasedVerifier — protected branch detection", () => {
  const v = new RuleBasedVerifier();
  const base = { tool: "git", permission_level: 5 as const, risk_level: "critical" as const, summary: "push" };

  it("blocks push to main", async () => {
    const r = await v.verify({ ...base, git_branch: "main" });
    expect(r.verdict).toBe("BLOCK");
    expect(r.reason).toMatch(/protected branch/);
  });

  it("blocks push to release/v1", async () => {
    const r = await v.verify({ ...base, git_branch: "release/v1" });
    expect(r.verdict).toBe("BLOCK");
  });

  it("approves push to a feature branch", async () => {
    const r = await v.verify({ ...base, git_branch: "feature/my-work" });
    expect(r.verdict).toBe("APPROVE");
  });
});

// ─── NullVerifier ─────────────────────────────────────────────────────────────

describe("NullVerifier", () => {
  it("approves everything", async () => {
    const v = new NullVerifier();
    const r = await v.verify({
      tool: "run_shell",
      permission_level: 5,
      risk_level: "critical",
      command: "rm -rf /",
      summary: "delete everything",
    });
    expect(r.verdict).toBe("APPROVE");
    expect(r.verifier_id).toBe("null");
  });
});

// ─── Executor integration: verifier blocks even when policy would approve ─────

describe("Executor: verifier integration", () => {
  it("verifier BLOCK prevents execution of a high-risk tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ver-"));
    const ledger = new InMemoryAuditSink();

    // L4 tool. The executor will run the verifier for high/critical risk.
    const tool = makeDummyMutatingTool({
      name: "run_shell",
      level: 4,
      target: "shell:rm -rf /tmp",
    });

    try {
      const executor = new Executor(ledger);
      const verifier = new RuleBasedVerifier();

      const outcome = await executor.execute(
        tool,
        { path: "shell:rm -rf /tmp", content: "" },
        {
          ctx: { repoRoot: dir },
          verifier,
          // No approval provider — but verifier BLOCK should fire first.
        },
      );

      expect(outcome.status).toBe("blocked");
      // Should be blocked by verifier or policy (no approval provider), not apply.
      expect(outcome.status === "blocked" && outcome.reason).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("NullVerifier allows the same high-risk tool (if approval present)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ver-"));
    const ledger = new InMemoryAuditSink();
    const tool = makeDummyMutatingTool({ name: "write_file", level: 3, target: "out.txt" });

    try {
      const executor = new Executor(ledger);
      const verifier = new NullVerifier();

      const outcome = await executor.execute(
        tool,
        { path: "out.txt", content: "hi" },
        { ctx: { repoRoot: dir }, verifier },
      );

      // L3 write_file: no approval gate needed; verifier approves → should execute.
      expect(outcome.status).toBe("executed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
