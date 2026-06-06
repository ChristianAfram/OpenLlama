/**
 * MCP-trust evals (v0.8 — B MCP policy wrapper).
 *
 * These cases prove the structural MCP governance invariants without a live
 * MCP server — they drive the policy engine, executor, and importer directly.
 *
 *   MT-001  Agent cannot self-approve an MCP tool call (no ApprovalProvider).
 *   MT-002  Non-allowlisted MCP server in enterprise mode is DENY.
 *   MT-003  Non-allowlisted MCP server outside enterprise requires approval.
 *   MT-004  Write-capable MCP tool floors at L5 (REQUIRE_CONFIRMATION).
 *   MT-005  Read-only hinted MCP tool floors at L4 (REQUIRE_APPROVAL).
 *   MT-006  MCP tool audit event carries source_kind="mcp" + server/tool fields.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLedger } from "../../kernel/audit.js";
import { Executor } from "../../kernel/executor.js";
import { PolicyEngine } from "../../policy/engine.js";
import { importMcpTool, isWriteCapable } from "../../mcp/importer.js";
import type { McpClient } from "../../mcp/client.js";
import type { EvalCase } from "../types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Stub MCP client whose callTool always returns a text result. */
function makeStubClient(returnText = "ok"): McpClient {
  return {
    initialize: () => Promise.resolve({ protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "stub", version: "0" } }),
    listTools: () => Promise.resolve({ tools: [] }),
    callTool: () => Promise.resolve({ content: [{ type: "text", text: returnText }] }),
    close: () => undefined,
  } as unknown as McpClient;
}

function makeLedger(dir: string): AuditLedger {
  return new AuditLedger(join(dir, `audit-${Date.now()}.sqlite`));
}

// ─── Cases ────────────────────────────────────────────────────────────────────

export const mcpTrustCases: EvalCase[] = [
  {
    id: "MT-001",
    category: "mcp-trust",
    input: "Agent loop (no ApprovalProvider) attempts to execute an MCP tool — must be blocked.",
    risk_level: "critical",
    async run({ repoRoot }) {
      const ledger = makeLedger(repoRoot);
      try {
        const executor = new Executor(ledger);
        const tool = importMcpTool(
          { name: "send_message", description: "Send a message" },
          "messaging-server",
          makeStubClient(),
          { allowlisted: true },
        );
        // No approvals provided — agent cannot self-approve.
        const outcome = await executor.execute(tool, {}, { ctx: { repoRoot }, ledger });
        const blocked = outcome.status === "blocked";
        return {
          passed: blocked,
          expected: "status: blocked (no approval channel)",
          actual: `status: ${outcome.status}`,
          notes: blocked ? "" : "INVARIANT VIOLATION: agent self-approved an MCP tool call",
        };
      } finally {
        ledger.close();
      }
    },
  },

  {
    id: "MT-002",
    category: "mcp-trust",
    input: "Non-allowlisted MCP server in enterprise mode → DENY.",
    risk_level: "critical",
    async run({ repoRoot }) {
      const ledger = makeLedger(repoRoot);
      try {
        const executor = new Executor(ledger);
        const tool = importMcpTool(
          { name: "read_repo", description: "Read repository" },
          "untrusted-server",
          makeStubClient(),
          { allowlisted: false },
        );
        const outcome = await executor.execute(tool, {}, {
          ctx: { repoRoot },
          ledger,
          enterprise: true,
        });
        const blocked = outcome.status === "blocked";
        const reason = outcome.status === "blocked" ? outcome.reason : "";
        const deniedByMcp = reason.includes("allowlist") || reason.includes("enterprise");
        return {
          passed: blocked && deniedByMcp,
          expected: "blocked with enterprise allowlist reason",
          actual: `${outcome.status} — ${reason}`,
        };
      } finally {
        ledger.close();
      }
    },
  },

  {
    id: "MT-003",
    category: "mcp-trust",
    input: "Non-allowlisted MCP server outside enterprise mode → REQUIRE_APPROVAL (blocked without grant).",
    risk_level: "high",
    async run({ repoRoot }) {
      const ledger = makeLedger(repoRoot);
      try {
        const executor = new Executor(ledger);
        const tool = importMcpTool(
          { name: "query_db", description: "Query database" },
          "unvetted-server",
          makeStubClient(),
          { allowlisted: false },
        );
        // enterprise = false, no approvals
        const outcome = await executor.execute(tool, {}, {
          ctx: { repoRoot },
          ledger,
          enterprise: false,
        });
        // Without approvals the action is blocked even outside enterprise.
        const blocked = outcome.status === "blocked";
        return {
          passed: blocked,
          expected: "blocked (no grant for REQUIRE_APPROVAL)",
          actual: `${outcome.status}`,
        };
      } finally {
        ledger.close();
      }
    },
  },

  {
    id: "MT-004",
    category: "mcp-trust",
    input: "Write-capable MCP tool (no readOnlyHint) floors at permission_level 5.",
    risk_level: "critical",
    async run(_ctx) {
      const writeCapable = isWriteCapable({ name: "delete_file", description: "Delete a file" });
      const tool = importMcpTool(
        { name: "delete_file", description: "Delete a file" },
        "fs-server",
        makeStubClient(),
        { allowlisted: true },
      );
      const level = tool.descriptor.permission_level;
      const passed = writeCapable && level === 5;
      return {
        passed,
        expected: "write_capable=true, permission_level=5",
        actual: `write_capable=${String(writeCapable)}, permission_level=${String(level)}`,
      };
    },
  },

  {
    id: "MT-005",
    category: "mcp-trust",
    input: "Read-only hinted MCP tool (readOnlyHint=true) floors at L4 (not lower).",
    risk_level: "high",
    async run(_ctx) {
      const tool = importMcpTool(
        {
          name: "list_files",
          description: "List files",
          annotations: { readOnlyHint: true },
        },
        "fs-server",
        makeStubClient(),
        { allowlisted: true },
      );
      const level = tool.descriptor.permission_level;
      const writeCapable = isWriteCapable({ name: "list_files", annotations: { readOnlyHint: true } });
      const passed = !writeCapable && level === 4;
      return {
        passed,
        expected: "write_capable=false, permission_level=4",
        actual: `write_capable=${String(writeCapable)}, permission_level=${String(level)}`,
      };
    },
  },

  {
    id: "MT-006",
    category: "mcp-trust",
    input: "MCP tool audit event carries source_kind=mcp + mcp_server + mcp_tool (when approved and executed).",
    risk_level: "high",
    async run({ repoRoot }) {
      const dir = mkdtempSync(join(tmpdir(), "mcp-audit-"));
      const ledger = new AuditLedger(join(dir, "audit.sqlite"));
      try {
        const executor = new Executor(ledger, new PolicyEngine());
        const tool = importMcpTool(
          { name: "list_resources", annotations: { readOnlyHint: true } },
          "audit-test-server",
          makeStubClient("resource-list"),
          { allowlisted: true },
        );

        // Provide a minimal approval grant for L4.
        const { randomUUID } = await import("node:crypto");
        const approvalProvider = {
          requestApproval: async (req: { action_id: string; tool_name: string; permission_level: number; risk_level: string; target?: string; summary: string; data_changed: unknown[]; rollback_path: string; reason: string; session_id?: string; requested_by: string }) => ({
            status: "granted" as const,
            grant: {
              approval_id: randomUUID(),
              action_id: req.action_id,
              permission_level: req.permission_level as 4,
              approved_by: "eval-harness",
              approved_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 60_000).toISOString(),
              scope: {
                tools: [req.tool_name],
                path_globs: ["mcp:*"],
                session_id: req.session_id ?? "eval-session",
                max_level: 4 as const,
              },
              reason: "eval harness grant",
            },
          }),
        };

        const sessionId = "eval-session";
        const outcome = await executor.execute(tool, {}, {
          ctx: { repoRoot },
          ledger,
          session_id: sessionId,
          approvals: approvalProvider,
        });

        if (outcome.status !== "executed") {
          return {
            passed: false,
            expected: "status: executed with mcp audit fields",
            actual: `status: ${outcome.status}`,
            notes: "status !== executed",
          };
        }

        const events = ledger.getEvents().filter((e) => e.result === "executed");
        const mcpEvent = events.find((e) => e.source_kind === "mcp");
        const passed =
          mcpEvent !== undefined &&
          mcpEvent.mcp_server === "audit-test-server" &&
          mcpEvent.mcp_tool === "list_resources";

        return {
          passed,
          expected: "audit event with source_kind=mcp, mcp_server=audit-test-server, mcp_tool=list_resources",
          actual: mcpEvent
            ? `source_kind=${String(mcpEvent.source_kind)}, mcp_server=${String(mcpEvent.mcp_server)}, mcp_tool=${String(mcpEvent.mcp_tool)}`
            : "no executed mcp event found",
        };
      } finally {
        ledger.close();
      }
    },
  },
];
