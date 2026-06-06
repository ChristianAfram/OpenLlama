/**
 * Hook runner + config unit tests (v0.8 — B5).
 *
 * Proves:
 *   - config loader coerces / drops malformed entries; missing file → empty set.
 *   - matcher globbing: no matcher = all tools; matcher filters by tool name.
 *   - pre_tool: non-zero exit → block; JSON {decision:block} → block; exit 0 → allow.
 *   - tighten-only: first block wins; an "allow" hook never forces allow.
 *   - hook output is captured verbatim (caller fences it).
 *   - every run writes a hook_execution audit event; a block is recorded as DENY.
 *   - timeouts / spawn failures fail-closed for pre_tool (block).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLedger } from "../src/kernel/audit.js";
import { HookRunner } from "../src/hooks/runner.js";
import { loadHooksConfig } from "../src/hooks/config.js";
import type { HookDefinition, HookPayload } from "../src/hooks/types.js";

let dir: string;
let ledger: AuditLedger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencli-hooks-"));
  ledger = new AuditLedger(join(dir, "audit.sqlite"));
});

afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

const NODE = process.execPath;

function preTool(toolName: string): HookPayload {
  return {
    event: "pre_tool",
    session_id: "s1",
    correlation_id: "c1",
    tool_name: toolName,
    tool_args: {},
    cwd: dir,
  };
}

function exitHook(code: number, matcher?: string): HookDefinition {
  const def: HookDefinition = {
    event: "pre_tool",
    command: NODE,
    args: ["-e", `process.exit(${String(code)})`],
    name: `exit-${String(code)}`,
  };
  if (matcher) def.matcher = matcher;
  return def;
}

// ─── config loader ────────────────────────────────────────────────────────────

describe("loadHooksConfig", () => {
  it("returns empty set when no project dir / no file", () => {
    expect(loadHooksConfig(null).hooks).toHaveLength(0);
    expect(loadHooksConfig(dir).hooks).toHaveLength(0);
  });

  it("loads and coerces valid hooks, dropping malformed entries", () => {
    mkdirSync(join(dir, ".opencli"), { recursive: true });
    writeFileSync(
      join(dir, ".opencli", "hooks.json"),
      JSON.stringify({
        hooks: [
          { event: "pre_tool", command: "echo", args: ["hi"], matcher: "write_file" },
          { event: "bogus_event", command: "echo" }, // invalid event → dropped
          { event: "post_tool" }, // missing command → dropped
          { event: "session_start", command: "node", timeoutMs: -5 }, // bad timeout dropped, hook kept
        ],
      }),
    );
    const { hooks } = loadHooksConfig(dir);
    expect(hooks).toHaveLength(2);
    expect(hooks[0]!.matcher).toBe("write_file");
    expect(hooks[1]!.event).toBe("session_start");
    expect(hooks[1]!.timeoutMs).toBeUndefined();
  });

  it("malformed JSON degrades to empty set (never throws)", () => {
    mkdirSync(join(dir, ".opencli"), { recursive: true });
    writeFileSync(join(dir, ".opencli", "hooks.json"), "{ not valid json ::");
    expect(() => loadHooksConfig(dir)).not.toThrow();
    expect(loadHooksConfig(dir).hooks).toHaveLength(0);
  });
});

// ─── block protocol ────────────────────────────────────────────────────────────

describe("HookRunner — pre_tool block protocol", () => {
  it("non-zero exit → block", () => {
    const runner = new HookRunner([exitHook(1)], ledger);
    const outcome = runner.run("pre_tool", preTool("read_file"));
    expect(outcome.blocked).toBe(true);
    expect(outcome.blockedBy).toBe("exit-1");
  });

  it("exit 0 → allow (no objection)", () => {
    const runner = new HookRunner([exitHook(0)], ledger);
    const outcome = runner.run("pre_tool", preTool("read_file"));
    expect(outcome.blocked).toBe(false);
  });

  it("JSON {decision:block} on stdout with exit 0 → block", () => {
    const hook: HookDefinition = {
      event: "pre_tool",
      command: NODE,
      args: ["-e", "console.log(JSON.stringify({decision:'block',reason:'nope'}))"],
      name: "json-block",
    };
    const runner = new HookRunner([hook], ledger);
    const outcome = runner.run("pre_tool", preTool("write_file"));
    expect(outcome.blocked).toBe(true);
    expect(outcome.blockReason).toBe("nope");
  });

  it("JSON {decision:allow} on stdout → allow (cannot force-allow)", () => {
    const hook: HookDefinition = {
      event: "pre_tool",
      command: NODE,
      args: ["-e", "console.log(JSON.stringify({decision:'allow'}))"],
      name: "json-allow",
    };
    const runner = new HookRunner([hook], ledger);
    const outcome = runner.run("pre_tool", preTool("write_file"));
    expect(outcome.blocked).toBe(false);
  });
});

// ─── matcher ──────────────────────────────────────────────────────────────────

describe("HookRunner — matcher", () => {
  it("no matcher matches every tool", () => {
    const runner = new HookRunner([exitHook(1)], ledger);
    expect(runner.run("pre_tool", preTool("anything")).blocked).toBe(true);
  });

  it("matcher only fires for matching tool names", () => {
    const runner = new HookRunner([exitHook(1, "write_file")], ledger);
    expect(runner.run("pre_tool", preTool("read_file")).blocked).toBe(false);
    expect(runner.run("pre_tool", preTool("write_file")).blocked).toBe(true);
  });

  it("glob matcher matches mcp:* tools", () => {
    const runner = new HookRunner([exitHook(1, "mcp:*")], ledger);
    expect(runner.run("pre_tool", preTool("mcp:github:create_pr")).blocked).toBe(true);
    expect(runner.run("pre_tool", preTool("read_file")).blocked).toBe(false);
  });
});

// ─── tighten-only ──────────────────────────────────────────────────────────────

describe("HookRunner — tighten-only", () => {
  it("first block wins even if a later hook would allow", () => {
    const runner = new HookRunner([exitHook(1), exitHook(0)], ledger);
    const outcome = runner.run("pre_tool", preTool("read_file"));
    expect(outcome.blocked).toBe(true);
    expect(outcome.blockedBy).toBe("exit-1");
    expect(outcome.results).toHaveLength(2); // both still ran + audited
  });

  it("an allow hook before a block hook does not prevent the block", () => {
    const runner = new HookRunner([exitHook(0), exitHook(1)], ledger);
    expect(runner.run("pre_tool", preTool("read_file")).blocked).toBe(true);
  });
});

// ─── output capture + audit ─────────────────────────────────────────────────────

describe("HookRunner — output + audit", () => {
  it("captures stdout verbatim", () => {
    const hook: HookDefinition = {
      event: "post_tool",
      command: NODE,
      args: ["-e", "console.log('captured-output')"],
      name: "echo",
    };
    const runner = new HookRunner([hook], ledger);
    const outcome = runner.run("post_tool", {
      event: "post_tool",
      session_id: "s1",
      correlation_id: "c1",
      tool_name: "read_file",
      tool_result: "x",
      cwd: dir,
    });
    expect(outcome.results[0]!.output.trim()).toBe("captured-output");
  });

  it("writes a hook_execution audit event; a block is recorded as DENY", () => {
    const runner = new HookRunner([exitHook(1)], ledger);
    runner.run("pre_tool", preTool("read_file"));
    const events = ledger.getEvents().filter((e) => e.action === "hook_execution");
    expect(events).toHaveLength(1);
    expect(events[0]!.policy_decision).toBe("DENY");
    expect(events[0]!.target).toBe("tool:read_file");
    expect(events[0]!.input_source).toBe("external");
  });
});

// ─── fail-closed ────────────────────────────────────────────────────────────────

describe("HookRunner — fail-closed for pre_tool", () => {
  it("a hook command that does not exist blocks (pre_tool fail-closed)", () => {
    const hook: HookDefinition = {
      event: "pre_tool",
      command: "/nonexistent/definitely/not/here",
      name: "missing",
    };
    const runner = new HookRunner([hook], ledger);
    const outcome = runner.run("pre_tool", preTool("read_file"));
    expect(outcome.blocked).toBe(true);
    expect(outcome.results[0]!.errored).toBe(true);
  });

  it("a missing post_tool hook is a logged no-op (does not block anything)", () => {
    const hook: HookDefinition = {
      event: "post_tool",
      command: "/nonexistent/definitely/not/here",
      name: "missing",
    };
    const runner = new HookRunner([hook], ledger);
    const outcome = runner.run("post_tool", {
      event: "post_tool",
      session_id: "s1",
      correlation_id: "c1",
      tool_name: "read_file",
      tool_result: "x",
      cwd: dir,
    });
    expect(outcome.blocked).toBe(false);
    expect(outcome.results[0]!.errored).toBe(true);
  });
});

// ─── hasHooks ────────────────────────────────────────────────────────────────

describe("HookRunner.hasHooks", () => {
  it("reports presence per event", () => {
    const runner = new HookRunner([exitHook(0)], ledger);
    expect(runner.hasHooks("pre_tool")).toBe(true);
    expect(runner.hasHooks("post_tool")).toBe(false);
    expect(runner.hasHooks("session_start")).toBe(false);
  });
});
