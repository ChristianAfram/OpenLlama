import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./store.js";

let dir: string;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencli-sessions-"));
  store = new SessionStore(join(dir, "sessions.sqlite"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(id: string, cwd = "/repo"): void {
  store.create({
    session_id: id,
    correlation_id: `corr-${id}`,
    cwd,
    model: "test-model",
    prompt_version: "v1",
  });
}

describe("SessionStore round-trip", () => {
  it("creates, appends turns, and reads them back in order", () => {
    seed("s1");
    store.appendTurn("s1", { role: "user", content: "do a thing" });
    store.appendTurn("s1", { role: "assistant", content: "thinking" });
    store.appendTurn("s1", {
      role: "tool_result",
      source: "tool:read_file",
      tool_name: "read_file",
      content: "file contents",
      audit_event_id: "evt-1",
    });

    const meta = store.get("s1");
    expect(meta?.status).toBe("active");
    expect(meta?.correlation_id).toBe("corr-s1");

    const turns = store.getTurns("s1");
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "tool_result"]);
    expect(turns[2]?.tool_name).toBe("read_file");
    expect(turns[2]?.audit_event_id).toBe("evt-1");
    expect(store.turnCount("s1")).toBe(3);
  });

  it("redacts secrets in turn content before persisting", () => {
    seed("s2");
    store.appendTurn("s2", {
      role: "tool_result",
      tool_name: "read_file",
      content: "here is the key sk-abcdefghijklmnopqrstuvwxyz0123456789",
    });
    const turns = store.getTurns("s2");
    expect(turns[0]?.content).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(turns[0]?.content).toContain("[REDACTED]");
  });

  it("finish records status, stop_reason, and token totals", () => {
    seed("s3");
    store.finish("s3", {
      status: "completed",
      stop_reason: "final_answer",
      total_input_tokens: 100,
      total_output_tokens: 42,
    });
    const meta = store.get("s3");
    expect(meta?.status).toBe("completed");
    expect(meta?.stop_reason).toBe("final_answer");
    expect(meta?.total_input_tokens).toBe(100);
    expect(meta?.total_output_tokens).toBe(42);
  });
});

describe("SessionStore listing + lookup", () => {
  it("lists sessions most-recently-updated first", () => {
    seed("a");
    seed("b");
    store.appendTurn("a", { role: "user", content: "later activity on a" });
    const list = store.list();
    expect(list[0]?.session_id).toBe("a"); // a updated most recently
  });

  it("latestForCwd returns the newest session for a directory", () => {
    seed("x", "/repo-1");
    seed("y", "/repo-2");
    seed("z", "/repo-1");
    store.appendTurn("z", { role: "user", content: "touch z" });
    expect(store.latestForCwd("/repo-1")?.session_id).toBe("z");
    expect(store.latestForCwd("/repo-2")?.session_id).toBe("y");
    expect(store.latestForCwd("/nope")).toBeNull();
  });
});

describe("SessionStore deletion", () => {
  it("removes a session and its turns", () => {
    seed("d");
    store.appendTurn("d", { role: "user", content: "x" });
    expect(store.remove("d")).toBe(true);
    expect(store.get("d")).toBeNull();
    expect(store.getTurns("d")).toHaveLength(0);
  });

  it("returns false when removing a nonexistent session", () => {
    expect(store.remove("ghost")).toBe(false);
  });
});
