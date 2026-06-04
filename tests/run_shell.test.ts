/**
 * run_shell tests (Prompt 6).
 *
 * Exit criteria:
 *   - plan() refuses commands containing destructive tokens.
 *   - apply() returns stdout as summary (string return from apply).
 *   - apply() throws on non-zero exit.
 *   - executor integration: blocked without approval, executes with valid L4 grant.
 *   - Audit event records the command as the target.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShellTool } from "../src/tools/run_shell.js";
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

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "run_shell_test_"));
  ledger = new AuditLedger(":memory:");
  executor = new Executor(ledger);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  ledger.close();
});

const ctx = () => ({ repoRoot: tmpDir });

// ─── plan() destructive token guard ───────────────────────────────────────────

describe("run_shell plan() destructive token denylist", () => {
  const destructive = [
    "rm -rf /",
    "rm -fr /tmp",
    "dd if=/dev/zero of=/dev/sda",
    "mkfs.ext4 /dev/sda",
    ":(){:|:&};:",
    "shred /dev/sda",
    "git clean -f .",
    "git reset --hard HEAD~1",
  ];

  for (const cmd of destructive) {
    it(`refuses: ${cmd.slice(0, 40)}`, () => {
      expect(() => runShellTool.plan({ command: cmd, timeout_ms: 5000 }, ctx())).toThrow(
        /destructive token/i,
      );
    });
  }

  it("allows safe commands through plan()", () => {
    expect(() =>
      runShellTool.plan({ command: "echo hello", timeout_ms: 5000 }, ctx()),
    ).not.toThrow();
  });
});

// ─── apply() stdout return ────────────────────────────────────────────────────

describe("run_shell apply() stdout", () => {
  it("returns stdout trimmed as summary", async () => {
    const mutation = await runShellTool.plan({ command: "echo hello", timeout_ms: 5000 }, ctx());
    const result = await mutation.apply();
    expect(result).toBe("hello");
  });

  it("returns (no output) when command produces nothing", async () => {
    const mutation = await runShellTool.plan({ command: "true", timeout_ms: 5000 }, ctx());
    const result = await mutation.apply();
    expect(result).toBe("(no output)");
  });

  it("target is shell:<command>", async () => {
    const mutation = await runShellTool.plan({ command: "echo hi", timeout_ms: 5000 }, ctx());
    expect(mutation.target).toBe("shell:echo hi");
  });

  it("apply throws when command fails (non-zero exit)", async () => {
    const mutation = await runShellTool.plan({ command: "exit 1", timeout_ms: 5000 }, ctx());
    await expect(Promise.resolve().then(() => mutation.apply())).rejects.toThrow();
  });
});

// ─── Executor integration ─────────────────────────────────────────────────────

describe("run_shell executor integration", () => {
  it("is blocked without an approval channel", async () => {
    const outcome = await executor.execute(
      runShellTool,
      { command: "echo hello" },
      { ctx: ctx() },
    );
    expect(outcome.status).toBe("blocked");
  });

  it("executes with valid L4 grant and returns stdout as summary", async () => {
    const sessionId = "test-session-shell";

    const approvals: ApprovalProvider = {
      requestApproval(req: ApprovalRequest): ApprovalDecision {
        const grant: ApprovalGrant = {
          approval_id: "ap-shell-001",
          action_id: req.action_id,
          permission_level: 4,
          approved_by: "human:test",
          approved_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          scope: {
            tools: ["run_shell"],
            path_globs: ["shell:*"],
            session_id: sessionId,
            max_level: 4,
          },
          reason: "test",
          rollback_path: "manual_inspection_required",
        };
        return { status: "granted", grant };
      },
    };

    const outcome = await executor.execute(
      runShellTool,
      { command: "echo hello_openllama" },
      { ctx: ctx(), session_id: sessionId, approvals },
    );

    expect(outcome.status).toBe("executed");
    if (outcome.status === "executed") {
      expect(outcome.summary).toBe("hello_openllama");
    }
  });

  it("records the command in the audit event target", async () => {
    const sessionId = "test-session-shell-audit";

    const approvals: ApprovalProvider = {
      requestApproval(req: ApprovalRequest): ApprovalDecision {
        const grant: ApprovalGrant = {
          approval_id: "ap-shell-002",
          action_id: req.action_id,
          permission_level: 4,
          approved_by: "human:test",
          approved_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          scope: {
            tools: ["run_shell"],
            path_globs: ["shell:*"],
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
      runShellTool,
      { command: "echo audit_check" },
      { ctx: ctx(), session_id: sessionId, approvals },
    );

    expect(outcome.status).toBe("executed");
    if (outcome.status === "executed") {
      const events = ledger.getEvents(100, 0);
      const execEvent = events.find((e) => e.action === "run_shell" && e.result === "executed");
      expect(execEvent?.target).toBe("shell:echo audit_check");
    }
  });
});
