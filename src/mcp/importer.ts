/**
 * MCP tool importer — converts McpToolDescription objects into MutatingTool
 * instances that flow through the existing Executor pipeline.
 *
 * Governance contract (docs/mcp-policy-wrapper.md):
 *   - Every MCP tool is a MutatingTool — no private apply path.
 *   - Default permission floor: L4 (REQUIRE_APPROVAL).
 *   - Write-capable tools (by annotation or name heuristic): L5 (REQUIRE_CONFIRMATION).
 *   - An MCP tool can never default to ALLOW for a mutation.
 *   - All MCP results are untrusted external data — fenced by addToolResult in engine.
 *   - source_kind / mcp_server / mcp_tool recorded in every audit event.
 */

import { z } from "zod";
import type { MutatingTool, PlannedMutation, ToolContext } from "../tools/registry.js";
import type { McpToolDescription } from "./types.js";
import type { McpClient } from "./client.js";

// ─── Write-capability heuristic ───────────────────────────────────────────────

/** Tool name fragments that suggest a write or side-effecting operation. */
const WRITE_NAME_FRAGMENTS: readonly string[] = [
  "create", "write", "update", "delete", "remove", "push", "publish",
  "send", "post", "patch", "set", "put", "add", "insert", "modify",
  "edit", "overwrite", "upload", "deploy", "execute", "run", "invoke",
  "move", "rename", "copy", "reset", "rollback", "commit", "merge",
];

/**
 * Determine whether a tool is write-capable.
 *
 * Priority:
 *  1. `annotations.readOnlyHint === true`  → read-only (NOT write-capable)
 *  2. `annotations.destructiveHint === true` → write-capable
 *  3. Name fragment heuristic
 *  4. Default: treat unknown as write-capable (safe-conservative)
 */
export function isWriteCapable(tool: McpToolDescription): boolean {
  if (tool.annotations?.readOnlyHint === true) return false;
  if (tool.annotations?.destructiveHint === true) return true;
  const lower = tool.name.toLowerCase();
  if (WRITE_NAME_FRAGMENTS.some((f) => lower.includes(f))) return true;
  // Unknown capability: default conservative (treat as write-capable → L5)
  return true;
}

// ─── Schema builder ───────────────────────────────────────────────────────────

/**
 * Convert an MCP inputSchema to a Zod schema.
 * We accept any object (z.record) — the MCP server validates its own arguments.
 * Returning z.record(z.unknown()) keeps us from rejecting args we can't model
 * while still ensuring the args are an object, not a primitive.
 */
function buildSchema(_inputSchema: McpToolDescription["inputSchema"]): z.ZodType<Record<string, unknown>> {
  return z.record(z.string(), z.unknown()).default({});
}

// ─── Importer ────────────────────────────────────────────────────────────────

/**
 * Convert a single MCP tool description into a MutatingTool.
 *
 * Tool names are namespaced as `mcp:<serverName>:<toolName>` so they never
 * collide with native tools and the policy rule can detect them by prefix.
 */
export function importMcpTool(
  tool: McpToolDescription,
  serverName: string,
  client: McpClient,
  opts: { defaultLevel?: 4 | 5; allowlisted: boolean } = { allowlisted: false },
): MutatingTool<Record<string, unknown>> {
  const writeCapable = isWriteCapable(tool);
  const permLevel: 4 | 5 = writeCapable ? 5 : (opts.defaultLevel ?? 4);
  const toolName = `mcp:${serverName}:${tool.name}`;

  return {
    descriptor: {
      name: toolName,
      description: tool.description
        ? `[MCP:${serverName}] ${tool.description}`
        : `MCP tool "${tool.name}" from server "${serverName}"`,
      permission_level: permLevel,
      risk_level: permLevel >= 5 ? "critical" : "high",
      allowed_paths: [],
      denied_paths: [],
      requires_approval: true,
      audit_required: true,
      rate_limit: "10/min",
      rollback: `irreversible — contact ${serverName} MCP server operator to reverse`,
      mcp_allowlisted: opts.allowlisted,
    },
    schema: buildSchema(tool.inputSchema),

    plan(args: Record<string, unknown>, _ctx: ToolContext): PlannedMutation {
      const target = toolName;
      return {
        target,
        data_changed: [
          { path: target, before_hash: null, after_hash: "mcp-pending" },
        ],
        rollback_path: `MCP call to ${serverName}/${tool.name} — contact server operator to reverse`,
        summary: `MCP tool call: ${serverName}/${tool.name}`,
        reversal: {
          kind: "irreversible",
          reason: `external MCP server call; state lives in ${serverName}, not in this process`,
        },
        extra_audit: {
          source_kind: "mcp",
          mcp_server: serverName,
          mcp_tool: tool.name,
        },
        apply: async () => {
          const result = await client.callTool(tool.name, args);
          const text = result.content
            .filter((c) => c.type === "text")
            .map((c) => c.text ?? "")
            .join("\n");
          if (result.isError) {
            throw new Error(`MCP tool error from ${serverName}/${tool.name}: ${text}`);
          }
          return text;
        },
      };
    },
  };
}

/**
 * Import all tools advertised by an MCP server into an array of MutatingTools.
 * Non-parseable or missing tools are skipped; errors are returned in `errors`.
 */
export async function importAllMcpTools(
  client: McpClient,
  serverName: string,
  opts: { defaultLevel?: 4 | 5; allowlisted: boolean },
): Promise<{ tools: MutatingTool[]; errors: string[] }> {
  const errors: string[] = [];
  let listed;
  try {
    listed = await client.listTools();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { tools: [], errors: [`failed to list tools from ${serverName}: ${msg}`] };
  }

  const tools: MutatingTool[] = [];
  for (const toolDesc of listed.tools) {
    if (typeof toolDesc.name !== "string" || !toolDesc.name) {
      errors.push(`server ${serverName}: skipping tool with missing name`);
      continue;
    }
    try {
      tools.push(importMcpTool(toolDesc, serverName, client, opts));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`server ${serverName}: failed to import tool "${toolDesc.name}": ${msg}`);
    }
  }
  return { tools, errors };
}
