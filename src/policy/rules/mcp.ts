/**
 * MCP server policy rule (v0.8 — B).
 *
 * Activates when `input.tool` starts with "mcp:" — i.e. for every tool
 * imported from an MCP server. Enforces two invariants:
 *
 *   1. Enterprise allowlist: in enterprise mode, a tool from a non-allowlisted
 *      server is DENY. Non-enterprise: REQUIRE_APPROVAL (still gated, never
 *      silently allowed).
 *
 *   2. MCP floor: MCP tools are never below REQUIRE_APPROVAL regardless of how
 *      the descriptor was constructed. This is defense-in-depth — the importer
 *      already sets L4/L5, but the policy rule makes the floor structural.
 *
 * These rules combine with agent_actions (which fires for all L4/L5) so a
 * write-capable MCP tool from an allowlisted server in enterprise mode still
 * gets REQUIRE_CONFIRMATION from agent_actions (L5), not just this rule.
 */

import type { PolicyRule, RuleVerdict } from "../types.js";

function isMcpTool(toolName: string): boolean {
  return toolName.startsWith("mcp:");
}

export const mcpRule: PolicyRule = {
  id: "mcp.server_policy",

  evaluate(input): RuleVerdict | null {
    if (!isMcpTool(input.tool)) return null;

    // Enterprise mode + non-allowlisted server = hard DENY.
    if (input.enterprise && input.mcp_server_allowlisted === false) {
      return {
        decision: "DENY",
        rule_id: "mcp.enterprise_not_allowlisted",
        reason: "enterprise mode: MCP server is not on the allowlist",
      };
    }

    // Non-enterprise but non-allowlisted: gate with approval (not silent allow).
    if (!input.enterprise && input.mcp_server_allowlisted === false) {
      return {
        decision: "REQUIRE_APPROVAL",
        rule_id: "mcp.non_allowlisted_requires_approval",
        reason: "MCP server is not on the allowlist; approval required",
      };
    }

    // Allowlisted server (or allowlist status unknown): enforce floor.
    // agent_actions already fires for L4/L5, so this is defense-in-depth only.
    return {
      decision: "REQUIRE_APPROVAL",
      rule_id: "mcp.tool_floor",
      reason: "MCP tools always require at least approval (external untrusted code)",
    };
  },
};
