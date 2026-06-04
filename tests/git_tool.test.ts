/**
 * git tool tests (Prompt 6).
 *
 * Exit criteria:
 *   - plan() refuses force-push attempts (--force / -f in branch arg).
 *   - status operation returns git status output.
 *   - commit: plan() sets correct target/rollback; apply() stages and commits.
 *   - executor integration: blocked without approval, executes with valid L4 grant.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitTool } from "../src/tools/git.js";
import { AuditLedger } from "../src/kernel/audit.js";
import { Executor } from "../src/kernel/executor.js";
import {
  type ApprovalDecision,
  type ApprovalProvider,
  type ApprovalRequest,
  type ApprovalGrant,
} from "../src/kernel/approval.js";

let tmpDir: string;
let ledger: AuditLedger;
let executor: Executor;

function initRepo(dir: string) {
  execSync("git init -b main", { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  execSync("git config commit.gpgsign false", { cwd: dir });
  execSync("git config tag.gpgsign false", { cwd: dir });
  writeFileSync(join(dir, "readme.txt"), "initial\n");
  execSync("git add readme.txt", { cwd: dir });
  execSync('git commit -m "init"', { cwd: dir });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "git_tool_test_"));
  initRepo(tmpDir);
  ledger = new AuditLedger(":memory:");
  executor = new Executor(ledger);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  ledger.close();
});

const ctx = () => ({ repoRoot: tmpDir });

// ─── Force-push guard ─────────────────────────────────────────────────────────

describe("git plan() force-push guard", () => {
  it("refuses when branch arg contains --force", () => {
    expect(() =>
      gitTool.plan({ operation: "push", remote: "origin", branch: "main --force" }, ctx()),
    ).toThrow("force-push is never permitted");
  });

  it("refuses when branch arg contains -f", () => {
    expect(() =>
      gitTool.plan({ operation: "push", remote: "origin", branch: "main -f" }, ctx()),
    ).toThrow("force-push is never permitted");
  });
});

// ─── status ───────────────────────────────────────────────────────────────────

describe("git status", () => {
  it("returns clean status on fresh repo", async () => {
    const mutation = await gitTool.plan({ operation: "status" }, ctx());
    expect(mutation.target).toBe("git:status");
    const result = await mutation.apply();
    expect(typeof result).toBe("string");
  });

  it("shows untracked files", async () => {
    writeFileSync(join(tmpDir, "new.txt"), "data");
    const mutation = await gitTool.plan({ operation: "status" }, ctx());
    const result = await mutation.apply();
    expect(result).toContain("new.txt");
  });
});

// ─── commit ───────────────────────────────────────────────────────────────────

describe("git commit", () => {
  it("plan sets target to git:commit", async () => {
    writeFileSync(join(tmpDir, "change.txt"), "changed");
    const mutation = await gitTool.plan(
      { operation: "commit", message: "test commit", paths: ["change.txt"] },
      ctx(),
    );
    expect(mutation.target).toBe("git:commit");
  });

  it("apply stages specific paths and creates commit", async () => {
    writeFileSync(join(tmpDir, "staged.txt"), "staged content");
    const mutation = await gitTool.plan(
      { operation: "commit", message: "add staged.txt", paths: ["staged.txt"] },
      ctx(),
    );
    const result = await mutation.apply();
    expect(typeof result).toBe("string");

    const log = execSync("git log --oneline -1", { cwd: tmpDir, encoding: "utf8" });
    expect(log).toContain("add staged.txt");
  });

  it("apply stages all tracked changes when no paths given", async () => {
    writeFileSync(join(tmpDir, "readme.txt"), "updated\n");
    const mutation = await gitTool.plan(
      { operation: "commit", message: "update readme" },
      ctx(),
    );
    await mutation.apply();
    const log = execSync("git log --oneline -1", { cwd: tmpDir, encoding: "utf8" });
    expect(log).toContain("update readme");
  });

  it("rollback_path contains git reset --hard", async () => {
    writeFileSync(join(tmpDir, "readme.txt"), "changed");
    const mutation = await gitTool.plan(
      { operation: "commit", message: "test" },
      ctx(),
    );
    expect(mutation.rollback_path).toMatch(/git reset --hard/);
  });
});

// ─── Executor integration ─────────────────────────────────────────────────────

describe("git executor integration", () => {
  it("is blocked without an approval channel", async () => {
    const outcome = await executor.execute(
      gitTool,
      { operation: "status" },
      { ctx: ctx() },
    );
    expect(outcome.status).toBe("blocked");
  });

  it("executes status with valid L4 grant and returns stdout as summary", async () => {
    const sessionId = "test-session-git";

    const approvals: ApprovalProvider = {
      requestApproval(req: ApprovalRequest): ApprovalDecision {
        const grant: ApprovalGrant = {
          approval_id: "ap-git-001",
          action_id: req.action_id,
          permission_level: 4,
          approved_by: "human:test",
          approved_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          scope: {
            tools: ["git"],
            path_globs: ["git:*"],
            session_id: sessionId,
            max_level: 4,
          },
          reason: "test",
          rollback_path: "n/a",
        };
        return { status: "granted", grant };
      },
    };

    const outcome = await executor.execute(
      gitTool,
      { operation: "status" },
      { ctx: ctx(), session_id: sessionId, approvals },
    );

    expect(outcome.status).toBe("executed");
    if (outcome.status === "executed") {
      expect(typeof outcome.summary).toBe("string");
    }
  });

  it("executes commit with valid L4 grant", async () => {
    writeFileSync(join(tmpDir, "newfile.txt"), "hello\n");
    const sessionId = "test-session-git-commit";

    const approvals: ApprovalProvider = {
      requestApproval(req: ApprovalRequest): ApprovalDecision {
        const grant: ApprovalGrant = {
          approval_id: "ap-git-002",
          action_id: req.action_id,
          permission_level: 4,
          approved_by: "human:test",
          approved_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          scope: {
            tools: ["git"],
            path_globs: ["git:*"],
            session_id: sessionId,
            max_level: 4,
          },
          reason: "test",
          rollback_path: "n/a",
        };
        return { status: "granted", grant };
      },
    };

    const outcome = await executor.execute(
      gitTool,
      { operation: "commit", message: "add newfile", paths: ["newfile.txt"] },
      { ctx: ctx(), session_id: sessionId, approvals },
    );

    expect(outcome.status).toBe("executed");
    const log = execSync("git log --oneline -1", { cwd: tmpDir, encoding: "utf8" });
    expect(log).toContain("add newfile");
  });
});
