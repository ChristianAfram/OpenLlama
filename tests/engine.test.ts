/**
 * Reasoning engine + tool dispatch tests (Prompt 2).
 *
 * Exit criteria proven here:
 *   - the agent reads files and proposes a diff with no file modified
 *   - every dispatch (incl. read-only) writes an audit event
 *   - invalid tool args are caught by zod and never reach the tool's execute()
 *   - the iteration cap is enforced
 *   - the repair budget terminates a model that keeps emitting invalid args
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLedger } from "../src/kernel/audit.js";
import { buildDefaultRegistry } from "../src/tools/index.js";
import { ReasoningEngine } from "../src/reasoning/engine.js";
import type {
  ModelClient,
  ModelTurn,
  ToolDefinition,
} from "../src/reasoning/model-client.js";
import type { ChatMessage } from "../src/lib/ollama.js";

// ─── Scripted model client ────────────────────────────────────────────────────

/** A ModelClient that replays a fixed script of turns, one per generate() call. */
class ScriptedModel implements ModelClient {
  model = "scripted-test-model";
  private i = 0;
  readonly seen: ChatMessage[][] = [];
  constructor(private readonly script: ModelTurn[]) {}
  generate(messages: ChatMessage[], _tools: ToolDefinition[]): Promise<ModelTurn> {
    this.seen.push(messages);
    const turn = this.script[Math.min(this.i, this.script.length - 1)]!;
    this.i++;
    return Promise.resolve(turn);
  }
}

function finalAnswer(content: string): ModelTurn {
  return { content, tool_calls: [] };
}

// ─── Scaffolding ──────────────────────────────────────────────────────────────

let repo: string;
let ledger: AuditLedger;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "openllama-engine-"));
  writeFileSync(join(repo, "hello.txt"), "line one\nline two\nline three\n");
  ledger = new AuditLedger(join(repo, ".audit.sqlite"));
});

afterEach(() => {
  ledger.close();
  rmSync(repo, { recursive: true, force: true });
});

function makeEngine(script: ModelTurn[], opts: { maxIterations?: number; repairAttempts?: number } = {}) {
  return new ReasoningEngine({
    registry: buildDefaultRegistry(),
    model: new ScriptedModel(script),
    toolContext: { repoRoot: repo },
    ledger,
    ...(opts.maxIterations !== undefined ? { maxIterations: opts.maxIterations } : {}),
    ...(opts.repairAttempts !== undefined ? { repairAttempts: opts.repairAttempts } : {}),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("reasoning engine: read + propose, no mutation", () => {
  it("reads a file then answers, logging every action", async () => {
    const engine = makeEngine([
      { content: "", tool_calls: [{ name: "read_file", arguments: { path: "hello.txt" } }] },
      finalAnswer("The file has three lines."),
    ]);

    const result = await engine.run("How many lines in hello.txt?");

    expect(result.stopReason).toBe("final_answer");
    expect(result.answer).toBe("The file has three lines.");
    expect(result.toolCalls).toBe(1);

    // The read_file dispatch produced an audit event.
    const events = ledger.getEvents();
    expect(events.some((e) => e.tool_name === "read_file" && e.result === "executed")).toBe(true);
  });

  it("propose_diff produces a diff and writes nothing", async () => {
    const before = readFileSync(join(repo, "hello.txt"), "utf8");
    const engine = makeEngine([
      {
        content: "",
        tool_calls: [
          {
            name: "propose_diff",
            arguments: { path: "hello.txt", new_content: "line one\nLINE TWO\nline three\n" },
          },
        ],
      },
      finalAnswer("Proposed a change to line two."),
    ]);

    await engine.run("Uppercase line two");

    // The file on disk is unchanged — propose_diff is draft-only.
    expect(readFileSync(join(repo, "hello.txt"), "utf8")).toBe(before);

    const ev = ledger.getEvents().find((e) => e.tool_name === "propose_diff");
    expect(ev).toBeDefined();
    expect(ev!.permission_level).toBe(1);
    expect(ev!.result).toBe("executed");
  });
});

describe("engine routes mutating tools through the executor", () => {
  it("the agent creates a new file end-to-end and it is audited as executed", async () => {
    const engine = makeEngine([
      {
        content: "",
        tool_calls: [{ name: "write_file", arguments: { path: "created.txt", content: "by agent\n" } }],
      },
      finalAnswer("Created the file."),
    ]);

    const result = await engine.run("create created.txt");
    expect(result.stopReason).toBe("final_answer");

    // The file exists on disk: the executor applied it after the audit write.
    expect(readFileSync(join(repo, "created.txt"), "utf8")).toBe("by agent\n");

    const ev = ledger.getEvents().find((e) => e.tool_name === "write_file");
    expect(ev).toBeDefined();
    expect(ev!.result).toBe("executed");
    expect(ev!.permission_level).toBe(3);
  });
});

describe("zod validation: invalid args never execute", () => {
  it("rejects an invalid read_file call and logs it as blocked, not executed", async () => {
    const engine = makeEngine([
      // path must be a non-empty string; pass a number.
      { content: "", tool_calls: [{ name: "read_file", arguments: { path: 123 } }] },
      finalAnswer("ok"),
    ]);

    await engine.run("read something");

    const ev = ledger.getEvents().find((e) => e.tool_name === "read_file");
    expect(ev).toBeDefined();
    expect(ev!.result).toBe("blocked");
    expect(ev!.error).toContain("invalid tool args");
  });

  it("a missing required field is caught and the tool is never run", async () => {
    const engine = makeEngine([
      { content: "", tool_calls: [{ name: "propose_diff", arguments: { path: "hello.txt" } }] },
      finalAnswer("ok"),
    ]);
    await engine.run("propose without content");
    const ev = ledger.getEvents().find((e) => e.tool_name === "propose_diff");
    expect(ev!.result).toBe("blocked");
  });
});

describe("iteration cap", () => {
  it("stops at the configured iteration cap", async () => {
    // A model that always calls a tool, never giving a final answer.
    const engine = makeEngine(
      [{ content: "", tool_calls: [{ name: "list_dir", arguments: { path: "." } }] }],
      { maxIterations: 4 },
    );
    const result = await engine.run("loop forever");
    expect(result.stopReason).toBe("iteration_cap");
    expect(result.iterations).toBe(4);
  });
});

describe("repair budget", () => {
  it("aborts after repairAttempts consecutive invalid-arg failures", async () => {
    const engine = makeEngine(
      [{ content: "", tool_calls: [{ name: "read_file", arguments: { path: 999 } }] }],
      { repairAttempts: 2, maxIterations: 25 },
    );
    const result = await engine.run("keep sending bad args");
    expect(result.stopReason).toBe("repair_exhausted");
    // 1 initial + 2 repairs = 3 dispatches before abort.
    expect(result.toolCalls).toBe(3);
  });

  it("a valid call resets the repair counter", async () => {
    const engine = makeEngine(
      [
        { content: "", tool_calls: [{ name: "read_file", arguments: { path: 1 } }] }, // invalid
        { content: "", tool_calls: [{ name: "list_dir", arguments: { path: "." } }] }, // valid → reset
        finalAnswer("done"),
      ],
      { repairAttempts: 1 },
    );
    const result = await engine.run("recover");
    expect(result.stopReason).toBe("final_answer");
  });
});
