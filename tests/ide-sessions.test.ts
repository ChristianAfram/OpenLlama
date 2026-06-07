/**
 * IDE session list model tests (v0.8 — C3).
 *
 * Proves:
 *   - buildSessionList maps store metadata to display summaries (order preserved).
 *   - total_tokens = input + output; is_subagent reflects parent_session_id.
 *   - end-to-end against a real SessionStore (turn counts wired correctly).
 *   - empty store → empty list.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type SessionMeta } from "../src/sessions/store.js";
import { buildSessionList } from "../src/ide/sessions.js";

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    session_id: "s1",
    correlation_id: "c1",
    created_at: "2026-06-06T00:00:00.000Z",
    updated_at: "2026-06-06T00:01:00.000Z",
    status: "completed",
    cwd: "/repo",
    model: "test-model",
    prompt_version: "v1",
    parent_session_id: null,
    total_input_tokens: 100,
    total_output_tokens: 50,
    stop_reason: "final_answer",
    ...overrides,
  };
}

describe("buildSessionList (pure)", () => {
  it("maps metadata to summaries, preserving input order", () => {
    const list = buildSessionList([
      { meta: meta({ session_id: "a" }), turns: 4 },
      { meta: meta({ session_id: "b" }), turns: 2 },
    ]);
    expect(list.count).toBe(2);
    expect(list.sessions.map((s) => s.session_id)).toEqual(["a", "b"]);
  });

  it("computes total_tokens and is_subagent", () => {
    const [parent, child] = buildSessionList([
      { meta: meta({ session_id: "p", total_input_tokens: 10, total_output_tokens: 5 }), turns: 1 },
      { meta: meta({ session_id: "c", parent_session_id: "p" }), turns: 1 },
    ]).sessions;
    expect(parent!.total_tokens).toBe(15);
    expect(parent!.is_subagent).toBe(false);
    expect(child!.is_subagent).toBe(true);
  });

  it("carries turns through from the supplied count", () => {
    const [s] = buildSessionList([{ meta: meta(), turns: 7 }]).sessions;
    expect(s!.turns).toBe(7);
  });

  it("empty input → empty list", () => {
    expect(buildSessionList([])).toEqual({ sessions: [], count: 0 });
  });
});

describe("buildSessionList (against a real SessionStore)", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "opencli-idesess-"));
    store = new SessionStore(join(dir, "sessions.sqlite"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reflects stored sessions and their turn counts", () => {
    store.create({ session_id: "x", correlation_id: "cx", cwd: "/r", model: "m", prompt_version: "v1" });
    store.appendTurn("x", { role: "user", content: "hi" });
    store.appendTurn("x", { role: "assistant", content: "yo" });

    const rows = store.list().map((m) => ({ meta: m, turns: store.turnCount(m.session_id) }));
    const list = buildSessionList(rows);
    expect(list.count).toBe(1);
    expect(list.sessions[0]!.session_id).toBe("x");
    expect(list.sessions[0]!.turns).toBe(2);
  });
});
