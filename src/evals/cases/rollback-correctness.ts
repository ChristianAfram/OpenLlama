/**
 * Rollback-correctness evals (Prompt 10 / Master Plan §11, framework §19, §49).
 *
 * Exit criterion: "rollback works for each mutation type."
 *
 * Each case:
 *   1. Runs the real executor + snapshot store against a temp repo.
 *   2. Confirms the mutation was applied.
 *   3. Calls the rollback engine.
 *   4. Confirms the reversal was correct.
 *
 * All I/O through the real kernel; no model involved.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuditLedger } from "../../kernel/audit.js";
import { Executor } from "../../kernel/executor.js";
import { RollbackEngine } from "../../kernel/rollback.js";
import { SnapshotStore } from "../../kernel/snapshot.js";
import { writeFileTool } from "../../tools/write_file.js";
import { editFileTool } from "../../tools/edit_file.js";
import type { EvalCase, EvalContext } from "../types.js";
import type {
  ApprovalDecision,
  ApprovalProvider,
  ApprovalRequest,
} from "../../kernel/approval.js";

function faithfulProvider(sessionId: string, pathGlob = "**"): ApprovalProvider {
  return {
    requestApproval(req: ApprovalRequest): ApprovalDecision {
      return {
        status: "granted",
        grant: {
          approval_id: `ap-eval-${Math.random().toString(36).slice(2)}`,
          action_id: req.action_id,
          permission_level: 4,
          approved_by: "human:eval",
          approved_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          scope: {
            tools: [req.tool_name],
            path_globs: [pathGlob],
            session_id: sessionId,
            max_level: 4,
          },
          reason: "eval approval",
          rollback_path: "n/a",
        },
      };
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeKernel(repoRoot: string): {
  ledger: AuditLedger;
  snapshots: SnapshotStore;
  executor: Executor;
  engine: RollbackEngine;
} {
  const ledger = new AuditLedger(":memory:");
  const snapshotDir = join(repoRoot, ".openllama-snapshots");
  mkdirSync(snapshotDir, { recursive: true });
  const snapshots = new SnapshotStore(snapshotDir);
  const executor = new Executor(ledger);
  const engine = new RollbackEngine(ledger, snapshots, repoRoot);
  return { ledger, snapshots, executor, engine };
}

// ─── Cases ────────────────────────────────────────────────────────────────────

export const rollbackCorrectnessCases: EvalCase[] = [
  // RC-001: write_file rollback deletes the created file.
  {
    id: "RC-001",
    category: "rollback-correctness",
    input: "write_file creates a file; rollback deletes it",
    risk_level: "medium",
    async run(ctx: EvalContext) {
      const { executor, engine } = makeKernel(ctx.repoRoot);

      const outcome = await executor.execute(
        writeFileTool,
        { path: "rc001.txt", content: "hello\n" },
        { ctx: { repoRoot: ctx.repoRoot } },
      );

      if (outcome.status !== "executed") {
        return {
          passed: false,
          expected: "write_file executed",
          actual: `status=${outcome.status}`,
        };
      }

      const fileBefore = existsSync(join(ctx.repoRoot, "rc001.txt"));
      if (!fileBefore) {
        return {
          passed: false,
          expected: "file exists after write",
          actual: "file not found after write_file",
        };
      }

      const result = await engine.rollback(outcome.event_id);
      const fileAfter = existsSync(join(ctx.repoRoot, "rc001.txt"));

      const passed = result.status === "rolled_back" && !fileAfter;
      return {
        passed,
        expected: "status=rolled_back and file deleted",
        actual: `status=${result.status}, fileExists=${String(fileAfter)}`,
        notes: result.description,
      };
    },
  },

  // RC-002: edit_file rollback restores prior content.
  {
    id: "RC-002",
    category: "rollback-correctness",
    input: "edit_file modifies a file; rollback restores the original content",
    risk_level: "high",
    async run(ctx: EvalContext) {
      const { executor, snapshots, engine } = makeKernel(ctx.repoRoot);

      const originalContent = "original content\n";
      const path = "rc002.txt";
      const abs = join(ctx.repoRoot, path);
      writeFileSync(abs, originalContent, "utf8");

      const sessionId = "eval-rc002";
      const outcome = await executor.execute(
        editFileTool,
        { path, old_string: "original content", new_string: "modified content" },
        {
          ctx: { repoRoot: ctx.repoRoot },
          snapshots,
          session_id: sessionId,
          approvals: faithfulProvider(sessionId, path),
        },
      );

      if (outcome.status !== "executed") {
        return {
          passed: false,
          expected: "edit_file executed",
          actual: `status=${outcome.status}`,
        };
      }

      const afterContent = readFileSync(abs, "utf8");
      if (!afterContent.includes("modified content")) {
        return {
          passed: false,
          expected: "file contains modified content after edit",
          actual: afterContent,
        };
      }

      const result = await engine.rollback(outcome.event_id);
      const restoredContent = readFileSync(abs, "utf8");

      const passed = result.status === "rolled_back" && restoredContent === originalContent;
      return {
        passed,
        expected: "status=rolled_back and content restored to original",
        actual: `status=${result.status}, content=${JSON.stringify(restoredContent.trim())}`,
        notes: result.description,
      };
    },
  },

  // RC-003: edit_file rollback refuses when no snapshot is present (no snapshots store passed).
  {
    id: "RC-003",
    category: "rollback-correctness",
    input: "edit_file without snapshot store → rollback returns precondition_failed",
    risk_level: "medium",
    async run(ctx: EvalContext) {
      const { executor, engine } = makeKernel(ctx.repoRoot);

      const path = "rc003.txt";
      const abs = join(ctx.repoRoot, path);
      writeFileSync(abs, "original\n", "utf8");

      // Execute WITHOUT snapshots: the before_content is never captured.
      const sessionId = "eval-rc003";
      const outcome = await executor.execute(
        editFileTool,
        { path, old_string: "original", new_string: "changed" },
        {
          ctx: { repoRoot: ctx.repoRoot },
          session_id: sessionId,
          approvals: faithfulProvider(sessionId, path),
          // Note: no `snapshots` option — snapshot not captured
        },
      );

      if (outcome.status !== "executed") {
        return {
          passed: false,
          expected: "edit_file executed (no snapshot)",
          actual: `status=${outcome.status}`,
        };
      }

      const result = await engine.rollback(outcome.event_id);

      const passed = result.status === "precondition_failed";
      return {
        passed,
        expected: "status=precondition_failed (snapshot missing)",
        actual: `status=${result.status}: ${result.description}`,
      };
    },
  },

  // RC-004: rollback of a non-existent event_id returns not_found.
  {
    id: "RC-004",
    category: "rollback-correctness",
    input: "rollback of unknown event_id returns not_found",
    risk_level: "low",
    async run(ctx: EvalContext) {
      const { engine } = makeKernel(ctx.repoRoot);
      const result = await engine.rollback("00000000-0000-0000-0000-000000000000");
      const passed = result.status === "not_found";
      return {
        passed,
        expected: "status=not_found",
        actual: `status=${result.status}`,
      };
    },
  },

  // RC-005: run_shell rollback returns irrecoverable (shell side effects cannot be reversed).
  {
    id: "RC-005",
    category: "rollback-correctness",
    input: "run_shell cannot be automatically reversed → irrecoverable",
    risk_level: "high",
    async run(ctx: EvalContext) {
      // run_shell is L4 and needs approval — but without an approval channel the
      // executor will block it before the audit write. We reach the rollback engine
      // via a different path: inject a fake "executed" run_shell event directly
      // into the ledger (the ledger's execute check is the gating path, but the
      // rollback engine only needs the event to be present and result=executed).
      const { ledger } = makeKernel(ctx.repoRoot);
      const { event_id } = ledger.appendEvent({
        actor: "agent:opencli",
        service: "tool-executor",
        action: "run_shell",
        tool_name: "run_shell",
        permission_level: 4,
        risk_level: "high",
        target: "run_shell",
        result: "executed",
        rollback_path: "n/a",
      });

      const engineForFakeEvent = new RollbackEngine(ledger, new SnapshotStore(join(ctx.repoRoot, ".snapshots")), ctx.repoRoot);
      const result = await engineForFakeEvent.rollback(event_id);

      const passed = result.status === "irrecoverable";
      return {
        passed,
        expected: "status=irrecoverable",
        actual: `status=${result.status}: ${result.description}`,
        notes: result.instructions ?? "",
      };
    },
  },

  // RC-006: double rollback returns already_reversed.
  {
    id: "RC-006",
    category: "rollback-correctness",
    input: "rolling back the same write_file event twice returns already_reversed",
    risk_level: "low",
    async run(ctx: EvalContext) {
      const { executor, engine } = makeKernel(ctx.repoRoot);

      const outcome = await executor.execute(
        writeFileTool,
        { path: "rc006.txt", content: "x\n" },
        { ctx: { repoRoot: ctx.repoRoot } },
      );

      if (outcome.status !== "executed") {
        return {
          passed: false,
          expected: "write_file executed",
          actual: `status=${outcome.status}`,
        };
      }

      // First rollback — should succeed.
      const first = await engine.rollback(outcome.event_id);
      if (first.status !== "rolled_back") {
        return {
          passed: false,
          expected: "first rollback → rolled_back",
          actual: `first=${first.status}`,
        };
      }

      // Second rollback of the same event — must return already_reversed.
      const second = await engine.rollback(outcome.event_id);
      const passed = second.status === "already_reversed";
      return {
        passed,
        expected: "second rollback → already_reversed",
        actual: `status=${second.status}`,
        notes: second.description,
      };
    },
  },
];
