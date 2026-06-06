/**
 * IDE bridge — event stream tests (v0.8 — C1).
 *
 * Proves:
 *   - serializeEvent / parseEvent round-trip; one line, no embedded newlines.
 *   - the engine emits a well-formed event sequence through an observer:
 *       run_start → (iteration, assistant?, tool_call*)* → run_end
 *   - tool_call status reflects ok / blocked / invalid_args.
 *   - the observer is read-only: it cannot change the run outcome.
 *   - run_end carries the same stop_reason/answer as the EngineRunResult.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLedger } from "../src/kernel/audit.js";
import { ReasoningEngine } from "../src/reasoning/engine.js";
import { buildDefaultRegistry } from "../src/tools/index.js";
import { serializeEvent, parseEvent, type AgentEvent } from "../src/ide/events.js";
import { ScriptedModelClient, toolTurn, finalTurn } from "../src/evals/scripted-model.js";

let dir: string;
let ledger: AuditLedger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencli-ide-"));
  ledger = new AuditLedger(join(dir, "audit.sqlite"));
});

afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

// ─── serializer ──────────────────────────────────────────────────────────────

describe("serializeEvent / parseEvent", () => {
  it("round-trips an event", () => {
    const e: AgentEvent = { type: "iteration", v: 1, n: 3 };
    expect(parseEvent(serializeEvent(e))).toEqual(e);
  });

  it("produces a single line with no embedded newlines", () => {
    const e: AgentEvent = {
      type: "assistant",
      v: 1,
      content: "line one\nline two\nline three",
    };
    const line = serializeEvent(e);
    expect(line.includes("\n")).toBe(false); // newlines are JSON-escaped
    expect(parseEvent(line)).toEqual(e);
  });

  it("parseEvent returns null on malformed / empty input", () => {
    expect(parseEvent("")).toBeNull();
    expect(parseEvent("not json")).toBeNull();
    expect(parseEvent("[1,2,3]")).toBeNull(); // array has no .type
  });
});

// ─── engine observer ─────────────────────────────────────────────────────────

function collect(): { observer: (e: AgentEvent) => void; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return { observer: (e) => events.push(e), events };
}

describe("engine observer", () => {
  it("emits run_start first and run_end last", async () => {
    const { observer, events } = collect();
    const engine = new ReasoningEngine({
      registry: buildDefaultRegistry(),
      model: new ScriptedModelClient([finalTurn("hello")]),
      toolContext: { repoRoot: dir },
      ledger,
      observer,
    });
    const result = await engine.run("say hi");

    expect(events[0]!.type).toBe("run_start");
    const last = events[events.length - 1]!;
    expect(last.type).toBe("run_end");
    if (last.type === "run_end") {
      expect(last.stop_reason).toBe(result.stopReason);
      expect(last.answer).toBe(result.answer);
    }
  });

  it("emits a tool_call event with status ok for a successful read", async () => {
    writeFileSync(join(dir, "f.txt"), "contents");
    const { observer, events } = collect();
    const engine = new ReasoningEngine({
      registry: buildDefaultRegistry(),
      model: new ScriptedModelClient([toolTurn("read_file", { path: "f.txt" }), finalTurn("done")]),
      toolContext: { repoRoot: dir },
      ledger,
      observer,
    });
    await engine.run("read it");
    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall).toBeDefined();
    if (toolCall?.type === "tool_call") {
      expect(toolCall.name).toBe("read_file");
      expect(toolCall.status).toBe("ok");
      expect(toolCall.audit_event_id).toBeTruthy();
    }
  });

  it("reports status=blocked for a destructive (L5) mutation with no approval", async () => {
    const { observer, events } = collect();
    const engine = new ReasoningEngine({
      registry: buildDefaultRegistry(),
      model: new ScriptedModelClient([toolTurn("run_shell", { command: "rm -rf /" }), finalTurn("done")]),
      toolContext: { repoRoot: dir },
      ledger,
      observer,
    });
    await engine.run("clean up");
    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall?.type === "tool_call" && toolCall.status).toBe("blocked");
  });

  it("reports status=invalid_args when the model sends bad arguments", async () => {
    const { observer, events } = collect();
    const engine = new ReasoningEngine({
      registry: buildDefaultRegistry(),
      // read_file requires a string path; send a number.
      model: new ScriptedModelClient([toolTurn("read_file", { path: 123 }), finalTurn("done")]),
      toolContext: { repoRoot: dir },
      ledger,
      observer,
    });
    await engine.run("bad call");
    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall?.type === "tool_call" && toolCall.status).toBe("invalid_args");
  });

  it("emits an iteration event per loop and an assistant event for content", async () => {
    const { observer, events } = collect();
    const engine = new ReasoningEngine({
      registry: buildDefaultRegistry(),
      model: new ScriptedModelClient([finalTurn("the answer")]),
      toolContext: { repoRoot: dir },
      ledger,
      observer,
    });
    await engine.run("q");
    expect(events.some((e) => e.type === "iteration")).toBe(true);
    const assistant = events.find((e) => e.type === "assistant");
    expect(assistant?.type === "assistant" && assistant.content).toBe("the answer");
  });

  it("the observer does not change the run result (read-only)", async () => {
    const model = new ScriptedModelClient([finalTurn("X")]);
    const withObs = await new ReasoningEngine({
      registry: buildDefaultRegistry(),
      model,
      toolContext: { repoRoot: dir },
      ledger,
      observer: () => { /* no-op sink */ },
    }).run("q");
    const model2 = new ScriptedModelClient([finalTurn("X")]);
    const without = await new ReasoningEngine({
      registry: buildDefaultRegistry(),
      model: model2,
      toolContext: { repoRoot: dir },
      ledger,
    }).run("q");
    expect(withObs.answer).toBe(without.answer);
    expect(withObs.stopReason).toBe(without.stopReason);
  });
});
