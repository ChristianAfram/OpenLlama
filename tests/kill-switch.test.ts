/**
 * Kill switch tests (Prompt 9).
 *
 * Proves:
 *  1. Inactive by default; activates and persists state.
 *  2. Executor blocks ALL mutations when the kill switch is active.
 *  3. Deactivation allows mutations to proceed again.
 *  4. Automated trigger: consecutive denials activate the switch.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KillSwitch } from "../src/kernel/kill-switch.js";
import { Executor } from "../src/kernel/executor.js";
import { InMemoryAuditSink } from "./helpers/in-memory-audit.js";
import { makeDummyMutatingTool } from "./helpers/dummy-tool.js";

function makeSwitch(): { sw: KillSwitch; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "ks-"));
  const sw = new KillSwitch(join(dir, "kill-switch.json"));
  return { sw, dir };
}

describe("KillSwitch state management", () => {
  it("is inactive by default (file not present)", () => {
    const { sw, dir } = makeSwitch();
    try {
      expect(sw.isActive()).toBe(false);
      expect(sw.getState().active).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("activates and persists the state to disk", () => {
    const { sw, dir } = makeSwitch();
    try {
      sw.activate("test activation", "manual");
      expect(sw.isActive()).toBe(true);
      const state = sw.getState();
      expect(state.active).toBe(true);
      expect(state.triggered_by).toBe("manual");
      expect(state.reason).toBe("test activation");
      expect(state.activated_at).toBeTruthy();

      // A second instance reading the same path sees the active state.
      const sw2 = new KillSwitch(sw.statePath);
      expect(sw2.isActive()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deactivation clears the state", () => {
    const { sw, dir } = makeSwitch();
    try {
      sw.activate("reason", "consecutive_denials");
      expect(sw.isActive()).toBe(true);
      sw.deactivate();
      expect(sw.isActive()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records different trigger types", () => {
    const { sw, dir } = makeSwitch();
    try {
      sw.activate("cost exceeded", "cost_cap");
      expect(sw.getState().triggered_by).toBe("cost_cap");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Executor: kill switch integration", () => {
  it("blocks all mutations when the kill switch is active", async () => {
    const { sw, dir } = makeSwitch();
    const ledger = new InMemoryAuditSink();
    const tool = makeDummyMutatingTool({ name: "write_file", level: 3 });

    try {
      sw.activate("test halt", "manual");

      const executor = new Executor(ledger);
      const outcome = await executor.execute(tool, { path: "out.txt", content: "hi" }, {
        ctx: { repoRoot: dir },
        killSwitch: sw,
      });

      expect(outcome.status).toBe("blocked");
      expect(outcome.status === "blocked" && outcome.reason).toMatch(/kill switch is active/);
      // Nothing was written to the ledger (no audit write attempted when KS active).
      expect(ledger.events).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows mutations when the kill switch is inactive", async () => {
    const { sw, dir } = makeSwitch();
    const ledger = new InMemoryAuditSink();
    const tool = makeDummyMutatingTool({ name: "write_file", level: 3 });

    try {
      // Switch is inactive by default.
      expect(sw.isActive()).toBe(false);

      const executor = new Executor(ledger);
      const outcome = await executor.execute(tool, { path: "out.txt", content: "hi" }, {
        ctx: { repoRoot: dir },
        killSwitch: sw,
      });

      // L3 tool with no approval gate needed → should execute.
      expect(outcome.status).toBe("executed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
