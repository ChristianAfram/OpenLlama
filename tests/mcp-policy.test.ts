/**
 * MCP policy rule unit tests.
 *
 * Proves:
 *   - Non-MCP tools are not affected by the MCP rule.
 *   - Non-allowlisted server in enterprise mode → DENY.
 *   - Non-allowlisted server outside enterprise → REQUIRE_APPROVAL (not silent ALLOW).
 *   - Allowlisted server → REQUIRE_APPROVAL (floor enforced).
 *   - Server allowlist status unknown (undefined) → REQUIRE_APPROVAL (safe default).
 *   - Full engine: enterprise + non-allowlisted MCP tool → DENY wins over everything.
 */

import { describe, it, expect } from "vitest";
import { mcpRule } from "../src/policy/rules/mcp.js";
import { PolicyEngine } from "../src/policy/engine.js";
import type { PolicyInput } from "../src/policy/types.js";

function mcpInput(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    tool: "mcp:test-server:do_something",
    permission_level: 4,
    risk_level: "high",
    ...overrides,
  };
}

describe("mcpRule — does not fire for native tools", () => {
  it("returns null for non-mcp tool names", () => {
    expect(mcpRule.evaluate({ tool: "write_file", permission_level: 3, risk_level: "low" })).toBeNull();
    expect(mcpRule.evaluate({ tool: "run_shell", permission_level: 3, risk_level: "low" })).toBeNull();
    expect(mcpRule.evaluate({ tool: "git", permission_level: 4, risk_level: "high" })).toBeNull();
  });
});

describe("mcpRule — enterprise mode", () => {
  it("non-allowlisted + enterprise → DENY", () => {
    const verdict = mcpRule.evaluate(mcpInput({ enterprise: true, mcp_server_allowlisted: false }));
    expect(verdict?.decision).toBe("DENY");
    expect(verdict?.rule_id).toBe("mcp.enterprise_not_allowlisted");
  });

  it("allowlisted + enterprise → REQUIRE_APPROVAL (not DENY)", () => {
    const verdict = mcpRule.evaluate(mcpInput({ enterprise: true, mcp_server_allowlisted: true }));
    expect(verdict?.decision).toBe("REQUIRE_APPROVAL");
    expect(verdict?.rule_id).not.toBe("mcp.enterprise_not_allowlisted");
  });
});

describe("mcpRule — non-enterprise mode", () => {
  it("non-allowlisted + !enterprise → REQUIRE_APPROVAL (not DENY)", () => {
    const verdict = mcpRule.evaluate(mcpInput({ enterprise: false, mcp_server_allowlisted: false }));
    expect(verdict?.decision).toBe("REQUIRE_APPROVAL");
    expect(verdict?.rule_id).toBe("mcp.non_allowlisted_requires_approval");
  });

  it("allowlisted + !enterprise → REQUIRE_APPROVAL (floor)", () => {
    const verdict = mcpRule.evaluate(mcpInput({ enterprise: false, mcp_server_allowlisted: true }));
    expect(verdict?.decision).toBe("REQUIRE_APPROVAL");
  });

  it("allowlist unknown (undefined) + !enterprise → REQUIRE_APPROVAL (safe default)", () => {
    const verdict = mcpRule.evaluate(mcpInput({ enterprise: false, mcp_server_allowlisted: undefined }));
    expect(verdict?.decision).toBe("REQUIRE_APPROVAL");
  });
});

describe("PolicyEngine — full bundle with MCP rule", () => {
  const engine = new PolicyEngine();

  it("enterprise + non-allowlisted MCP tool → DENY (most restrictive wins)", () => {
    const result = engine.evaluate(mcpInput({ enterprise: true, mcp_server_allowlisted: false }));
    expect(result.decision).toBe("DENY");
    expect(result.contributing.some((v) => v.rule_id === "mcp.enterprise_not_allowlisted")).toBe(true);
  });

  it("allowlisted MCP write-capable tool (L5) → REQUIRE_CONFIRMATION", () => {
    const result = engine.evaluate(mcpInput({ permission_level: 5, risk_level: "critical", mcp_server_allowlisted: true }));
    expect(result.decision).toBe("REQUIRE_CONFIRMATION");
  });

  it("allowlisted MCP read-only tool (L4) → REQUIRE_APPROVAL", () => {
    const result = engine.evaluate(mcpInput({ permission_level: 4, risk_level: "high", mcp_server_allowlisted: true }));
    expect(result.decision).toBe("REQUIRE_APPROVAL");
  });
});
