/**
 * Subagent runner + delegate tool unit tests (v0.8 — B7).
 *
 * Proves:
 *   - delegate runs a child engine and returns its answer.
 *   - the child shares the parent's correlation_id but gets a fresh session_id.
 *   - depth cap: a call at >= maxDepth is denied without spawning a child.
 *   - a child has no extra privilege — a compromised child's L5 mutation is blocked.
 *   - the delegate tool is L1 and routes through the read/draft dispatcher.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLedger } from "../src/kernel/audit.js";
import { ReasoningEngine } from "../src/reasoning/engine.js";
import { SubagentRunner } from "../src/reasoning/subagent.js";
import { buildDefaultRegistry } from "../src/tools/index.js";
import { makeDelegateTool } from "../src/tools/delegate.js";
import { toolTurn, finalTurn } from "../src/evals/scripted-model.js";
import type { ModelClient, ModelTurn, ToolDefinition } from "../src/reasoning/model-client.js";
import type { ChatMessage } from "../src/lib/ollama.js";

let dir: string;
let ledger: AuditLedger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencli-subagent-"));
  ledger = new AuditLedger(join(dir, "audit.sqlite"));
});

afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

// ─── Content-routing model ──────────────────────────────────────────────────────

interface Route {
  match: string;
  script: ModelTurn[];
}

class RoutingModel implements ModelClient {
  model = "routing-test-model";
  readonly seen: ChatMessage[][] = [];
  private readonly counters = new Map<string, number>();
  constructor(private readonly routes: Route[]) {}
  generate(messages: ChatMessage[], _tools: ToolDefinition[]): Promise<ModelTurn> {
    void _tools;
    this.seen.push(messages);
    const firstUser = messages.find((m) => m.role === "user")?.content ?? "";
    const route = this.routes.find((r) => firstUser.includes(r.match));
    const key = route?.match ?? "__none__";
    const i = this.counters.get(key) ?? 0;
    this.counters.set(key, i + 1);
    const script = route?.script ?? [];
    return Promise.resolve(i < script.length ? script[i]! : finalTurn("done"));
  }
}

function buildAgent(model: ModelClient, maxDepth = 2): ReasoningEngine {
  const registryFactory = () => {
    const r = buildDefaultRegistry();
    r.register(makeDelegateTool(() => runner));
    return r;
  };
  const runner = new SubagentRunner({ registryFactory, model, toolContext: { repoRoot: dir }, ledger, maxDepth });
  return new ReasoningEngine({
    registry: registryFactory(),
    model,
    toolContext: { repoRoot: dir },
    ledger,
    subagentDepth: 0,
    sessionId: "parent-session",
  });
}

// ─── delegate tool descriptor ────────────────────────────────────────────────────

describe("makeDelegateTool", () => {
  it("is an L1 read/draft tool", () => {
    const tool = makeDelegateTool(() => ({ maxDepth: 2 }) as unknown as SubagentRunner);
    expect(tool.descriptor.permission_level).toBe(1);
    expect(tool.descriptor.name).toBe("delegate");
    expect("execute" in tool).toBe(true);
  });
});

// ─── delegation round-trip ───────────────────────────────────────────────────────

describe("delegation", () => {
  it("runs a child agent and returns its answer to the parent", async () => {
    const model = new RoutingModel([
      { match: "PARENT", script: [toolTurn("delegate", { task: "CHILD do work" }), finalTurn("parent done")] },
      { match: "CHILD", script: [finalTurn("the child result")] },
    ]);
    const engine = buildAgent(model);
    await engine.run("PARENT: delegate work");

    // Parent's later context contains the child's answer, fenced as untrusted.
    const fencedChild = model.seen
      .flat()
      .find((m) => m.content.includes("the child result"));
    expect(fencedChild?.content).toContain("<untrusted_external_data>");
  });

  it("child shares parent correlation_id, gets a distinct session_id", async () => {
    writeFileSync(join(dir, "f.txt"), "data");
    const model = new RoutingModel([
      { match: "PARENT", script: [toolTurn("delegate", { task: "CHILD read" }), finalTurn("done")] },
      { match: "CHILD", script: [toolTurn("read_file", { path: "f.txt" }), finalTurn("done")] },
    ]);
    const engine = buildAgent(model);
    await engine.run("PARENT: delegate read");

    const events = ledger.getEvents();
    const delegateEv = events.find((e) => e.tool_name === "delegate");
    const childRead = events.find((e) => e.tool_name === "read_file");
    expect(delegateEv?.correlation_id).toBeTruthy();
    expect(childRead?.correlation_id).toBe(delegateEv?.correlation_id);
    expect(childRead?.session_id).not.toBe(delegateEv?.session_id);
  });

  it("a compromised child cannot execute an L5 mutation", async () => {
    const model = new RoutingModel([
      { match: "PARENT", script: [toolTurn("delegate", { task: "CHILD destroy" }), finalTurn("done")] },
      { match: "CHILD", script: [toolTurn("run_shell", { command: "rm -rf /" }), finalTurn("done")] },
    ]);
    const engine = buildAgent(model);
    await engine.run("PARENT: delegate destroy");
    const executed = ledger.getEvents().some((e) => e.tool_name === "run_shell" && e.result === "executed");
    expect(executed).toBe(false);
  });

  it("enforces the depth cap — a child at maxDepth cannot delegate again", async () => {
    const model = new RoutingModel([
      { match: "PARENT", script: [toolTurn("delegate", { task: "CHILD deeper" }), finalTurn("done")] },
      { match: "CHILD", script: [toolTurn("delegate", { task: "GRANDCHILD" }), finalTurn("done")] },
      { match: "GRANDCHILD", script: [finalTurn("should not run")] },
    ]);
    const engine = buildAgent(model, 1); // maxDepth = 1
    await engine.run("PARENT: delegate deeper");

    const sawLimit = model.seen.flat().some((m) => m.content.includes("delegation depth limit"));
    const grandchildRan = model.seen.flat().some((m) => m.content.includes("should not run"));
    expect(sawLimit).toBe(true);
    expect(grandchildRan).toBe(false);
    expect(ledger.getEvents().some((e) => e.target === "subagent:denied")).toBe(true);
  });
});
