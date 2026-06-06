/**
 * MCP tool importer unit tests.
 *
 * Proves:
 *   - Write-capable detection (annotation priority, then name heuristic, then default).
 *   - Imported tool has correct permission_level (5 for write, 4 for read-only).
 *   - Imported tool is a MutatingTool (has plan(), not execute()).
 *   - plan() returns a PlannedMutation with irreversible reversal and extra_audit.
 *   - Tool name is namespaced: "mcp:<server>:<tool>".
 *   - importAllMcpTools: graceful handling of list-tools failure.
 *   - importAllMcpTools: imports multiple tools and returns errors for bad ones.
 */

import { describe, it, expect } from "vitest";
import { importMcpTool, importAllMcpTools, isWriteCapable } from "../src/mcp/importer.js";
import { isMutatingTool } from "../src/tools/registry.js";
import type { McpClient } from "../src/mcp/client.js";

// ─── Stub MCP client ──────────────────────────────────────────────────────────

function makeStubClient(tools: { name: string; description?: string }[] = [], returnText = "result"): McpClient {
  return {
    initialize: () => Promise.resolve({ protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "stub", version: "0" } }),
    listTools: () => Promise.resolve({ tools }),
    callTool: () => Promise.resolve({ content: [{ type: "text", text: returnText }] }),
    close: () => undefined,
  } as unknown as McpClient;
}

function makeFailingListClient(): McpClient {
  return {
    initialize: () => Promise.reject(new Error("no server")),
    listTools: () => Promise.reject(new Error("listTools failed")),
    callTool: () => Promise.reject(new Error("no server")),
    close: () => undefined,
  } as unknown as McpClient;
}

const CTX = { repoRoot: "/tmp" };

// ─── isWriteCapable ──────────────────────────────────────────────────────────

describe("isWriteCapable", () => {
  it("readOnlyHint=true → not write-capable", () => {
    expect(isWriteCapable({ name: "delete_everything", annotations: { readOnlyHint: true } })).toBe(false);
  });

  it("destructiveHint=true → write-capable (overrides name)", () => {
    expect(isWriteCapable({ name: "list_stuff", annotations: { destructiveHint: true } })).toBe(true);
  });

  it("write-y name → write-capable", () => {
    expect(isWriteCapable({ name: "create_issue" })).toBe(true);
    expect(isWriteCapable({ name: "delete_branch" })).toBe(true);
    expect(isWriteCapable({ name: "push_changes" })).toBe(true);
  });

  it("unknown name with no annotations → conservative (write-capable)", () => {
    expect(isWriteCapable({ name: "frobnicate" })).toBe(true);
  });
});

// ─── importMcpTool ───────────────────────────────────────────────────────────

describe("importMcpTool", () => {
  it("is a MutatingTool (has plan(), no execute())", () => {
    const tool = importMcpTool({ name: "send_message" }, "srv", makeStubClient(), { allowlisted: true });
    expect(isMutatingTool(tool)).toBe(true);
    expect(typeof tool.plan).toBe("function");
    expect("execute" in tool).toBe(false);
  });

  it("tool name is mcp:<server>:<tool>", () => {
    const tool = importMcpTool({ name: "my_tool" }, "my-server", makeStubClient(), { allowlisted: true });
    expect(tool.descriptor.name).toBe("mcp:my-server:my_tool");
  });

  it("write-capable tool has permission_level 5 and risk_level critical", () => {
    const tool = importMcpTool({ name: "delete_file" }, "fs", makeStubClient(), { allowlisted: true });
    expect(tool.descriptor.permission_level).toBe(5);
    expect(tool.descriptor.risk_level).toBe("critical");
    expect(tool.descriptor.requires_approval).toBe(true);
  });

  it("read-only hinted tool has permission_level 4 and risk_level high", () => {
    const tool = importMcpTool(
      { name: "list_files", annotations: { readOnlyHint: true } },
      "fs",
      makeStubClient(),
      { allowlisted: true },
    );
    expect(tool.descriptor.permission_level).toBe(4);
    expect(tool.descriptor.risk_level).toBe("high");
  });

  it("allowlisted flag is recorded on descriptor", () => {
    const allowlisted = importMcpTool({ name: "t" }, "s", makeStubClient(), { allowlisted: true });
    const notAllowlisted = importMcpTool({ name: "t" }, "s", makeStubClient(), { allowlisted: false });
    expect(allowlisted.descriptor.mcp_allowlisted).toBe(true);
    expect(notAllowlisted.descriptor.mcp_allowlisted).toBe(false);
  });

  it("plan() returns irreversible reversal and extra_audit with MCP metadata", async () => {
    const tool = importMcpTool({ name: "push_code" }, "vcs", makeStubClient(), { allowlisted: true });
    const mutation = await tool.plan({}, CTX);
    expect(mutation.reversal?.kind).toBe("irreversible");
    expect(mutation.extra_audit?.source_kind).toBe("mcp");
    expect(mutation.extra_audit?.mcp_server).toBe("vcs");
    expect(mutation.extra_audit?.mcp_tool).toBe("push_code");
  });

  it("plan() apply() returns the text content from the MCP response", async () => {
    const tool = importMcpTool({ name: "greet" }, "srv", makeStubClient([], "hello world"), { allowlisted: true });
    const mutation = await tool.plan({}, CTX);
    const result = await mutation.apply();
    expect(result).toBe("hello world");
  });

  it("plan() apply() throws when isError=true", async () => {
    const client: McpClient = {
      initialize: () => Promise.resolve({ protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "s", version: "0" } }),
      listTools: () => Promise.resolve({ tools: [] }),
      callTool: () => Promise.resolve({ content: [{ type: "text", text: "boom" }], isError: true }),
      close: () => undefined,
    } as unknown as McpClient;
    const tool = importMcpTool({ name: "fail_tool" }, "srv", client, { allowlisted: true });
    const mutation = await tool.plan({}, CTX);
    await expect(mutation.apply()).rejects.toThrow("MCP tool error");
  });
});

// ─── importAllMcpTools ────────────────────────────────────────────────────────

describe("importAllMcpTools", () => {
  it("returns empty tools and an error when listTools fails", async () => {
    const { tools, errors } = await importAllMcpTools(makeFailingListClient(), "bad-server", { allowlisted: true });
    expect(tools).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bad-server");
  });

  it("imports all valid tools and names them correctly", async () => {
    const client = makeStubClient([
      { name: "create_branch", description: "Create a branch" },
      { name: "list_prs", description: "List PRs" },
    ]);
    const { tools, errors } = await importAllMcpTools(client, "github", { allowlisted: true });
    expect(errors).toHaveLength(0);
    expect(tools).toHaveLength(2);
    expect(tools[0]!.descriptor.name).toBe("mcp:github:create_branch");
    expect(tools[1]!.descriptor.name).toBe("mcp:github:list_prs");
  });

  it("skips tools with missing names and records an error", async () => {
    const client = makeStubClient([{ name: "good_tool" }, { name: "" }]);
    const { tools, errors } = await importAllMcpTools(client, "srv", { allowlisted: true });
    expect(tools).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });
});
