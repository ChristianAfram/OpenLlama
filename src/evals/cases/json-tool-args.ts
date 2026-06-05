/**
 * JSON / tool-argument evals (Master Plan §11, framework §23).
 *
 * Malformed tool calls must be rejected by the zod schema and NEVER reach the
 * tool's side effect. The dispatcher/executor logs the rejection and returns a
 * repairable error; nothing is executed.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { AuditLedger } from "../../kernel/audit.js";
import { Executor } from "../../kernel/executor.js";
import { buildDefaultRegistry } from "../../tools/index.js";
import { dispatchTool } from "../../tools/registry.js";
import { writeFileTool } from "../../tools/write_file.js";
import type { EvalCase } from "../types.js";

export const jsonToolArgsCases: EvalCase[] = [
  {
    id: "JA-001",
    category: "json-tool-args",
    input: "read_file with a missing required field is rejected, not executed",
    risk_level: "low",
    async run({ repoRoot }) {
      const ledger = new AuditLedger(":memory:");
      try {
        const outcome = await dispatchTool(buildDefaultRegistry(), "read_file", {}, {
          ledger,
          ctx: { repoRoot },
        });
        return {
          passed: outcome.status === "invalid_args",
          expected: "invalid_args (schema rejection)",
          actual: `status=${outcome.status}`,
        };
      } finally {
        ledger.close();
      }
    },
  },
  {
    id: "JA-002",
    category: "json-tool-args",
    input: "read_file with a wrong-typed field is rejected, not executed",
    risk_level: "low",
    async run({ repoRoot }) {
      const ledger = new AuditLedger(":memory:");
      try {
        const outcome = await dispatchTool(
          buildDefaultRegistry(),
          "read_file",
          { path: 12345 },
          { ledger, ctx: { repoRoot } },
        );
        return {
          passed: outcome.status === "invalid_args",
          expected: "invalid_args (type mismatch)",
          actual: `status=${outcome.status}`,
        };
      } finally {
        ledger.close();
      }
    },
  },
  {
    id: "JA-003",
    category: "json-tool-args",
    input: "mutating write_file with invalid args is blocked before any side effect",
    risk_level: "medium",
    async run({ repoRoot }) {
      const ledger = new AuditLedger(":memory:");
      try {
        const outcome = await new Executor(ledger).execute(
          writeFileTool,
          { path: "x.txt" }, // missing 'content'
          { ctx: { repoRoot } },
        );
        const created = existsSync(join(repoRoot, "x.txt"));
        return {
          passed: outcome.status === "blocked" && !created,
          expected: "blocked (invalid args); no file created",
          actual: `status=${outcome.status}, created=${String(created)}`,
        };
      } finally {
        ledger.close();
      }
    },
  },
];
