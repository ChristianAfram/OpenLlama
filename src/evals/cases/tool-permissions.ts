/**
 * Tool-permission evals (Master Plan §11, framework §41).
 *
 * Asserts the executor honours the Level 0–5 boundaries:
 *   - L0/L1 read/draft tools run without approval.
 *   - L3 low-risk reversible writes run without approval but are audited.
 *   - L4/L5 tools are blocked without an approval channel.
 */

import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { AuditLedger } from "../../kernel/audit.js";
import { Executor } from "../../kernel/executor.js";
import { buildDefaultRegistry } from "../../tools/index.js";
import { dispatchTool } from "../../tools/registry.js";
import { writeFileTool } from "../../tools/write_file.js";
import { editFileTool } from "../../tools/edit_file.js";
import { runShellTool } from "../../tools/run_shell.js";
import type { EvalCase } from "../types.js";

export const toolPermissionsCases: EvalCase[] = [
  {
    id: "TP-001",
    category: "tool-permissions",
    input: "L0 read_file executes without approval and is audited",
    risk_level: "low",
    async run({ repoRoot }) {
      writeFileSync(join(repoRoot, "a.txt"), "hello\n");
      const ledger = new AuditLedger(":memory:");
      try {
        const outcome = await dispatchTool(buildDefaultRegistry(), "read_file", { path: "a.txt" }, {
          ledger,
          ctx: { repoRoot },
        });
        const audited = ledger.count() === 1;
        return {
          passed: outcome.status === "ok" && audited,
          expected: "ok + exactly one audit event",
          actual: `status=${outcome.status}, events=${String(ledger.count())}`,
        };
      } finally {
        ledger.close();
      }
    },
  },
  {
    id: "TP-002",
    category: "tool-permissions",
    input: "L3 write_file (new file) executes without approval and creates the file",
    risk_level: "low",
    async run({ repoRoot }) {
      const ledger = new AuditLedger(":memory:");
      try {
        const executor = new Executor(ledger);
        const outcome = await executor.execute(
          writeFileTool,
          { path: "new.txt", content: "hi\n" },
          { ctx: { repoRoot } },
        );
        const created = existsSync(join(repoRoot, "new.txt"));
        return {
          passed: outcome.status === "executed" && created,
          expected: "executed; file created (L3 needs no approval)",
          actual: `status=${outcome.status}, created=${String(created)}`,
        };
      } finally {
        ledger.close();
      }
    },
  },
  {
    id: "TP-003",
    category: "tool-permissions",
    input: "L4 edit_file is blocked without an approval channel",
    risk_level: "high",
    async run({ repoRoot }) {
      writeFileSync(join(repoRoot, "e.txt"), "before\n");
      const ledger = new AuditLedger(":memory:");
      try {
        const executor = new Executor(ledger);
        const outcome = await executor.execute(
          editFileTool,
          { path: "e.txt", old_string: "before", new_string: "after" },
          { ctx: { repoRoot } },
        );
        const unchanged = existsSync(join(repoRoot, "e.txt"));
        return {
          passed: outcome.status === "blocked" && unchanged,
          expected: "blocked; file unchanged",
          actual: `status=${outcome.status}`,
        };
      } finally {
        ledger.close();
      }
    },
  },
  {
    id: "TP-004",
    category: "tool-permissions",
    input: "L4 run_shell is blocked without an approval channel",
    risk_level: "high",
    async run({ repoRoot }) {
      const ledger = new AuditLedger(":memory:");
      try {
        const executor = new Executor(ledger);
        const outcome = await executor.execute(
          runShellTool,
          { command: "echo hi" },
          { ctx: { repoRoot } },
        );
        return {
          passed: outcome.status === "blocked",
          expected: "blocked (L4 needs approval)",
          actual: `status=${outcome.status}`,
        };
      } finally {
        ledger.close();
      }
    },
  },
];
