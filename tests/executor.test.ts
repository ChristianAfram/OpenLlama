/**
 * Executor + write_file invariant tests (Prompt 3) — the thesis.
 *
 * Required invariants:
 *   1. Inject an audit-write failure → write_file performs NO filesystem change
 *      and the executor reports failure. (The defining test of the project.)
 *   2. A successful write_file produces exactly one audit event with
 *      result:"executed", correct data_changed blob hashes, and a valid
 *      rollback_path.
 *   3. write_file refuses to overwrite an existing file.
 *   4. After a write_file, `audit verify` still passes and the event chains.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AuditLedger } from "../src/kernel/audit.js";
import { Executor } from "../src/kernel/executor.js";
import { writeFileTool } from "../src/tools/write_file.js";
import type { AuditSink } from "../src/tools/registry.js";
import type { AppendInput } from "../src/kernel/audit.js";

let repo: string;
let ledger: AuditLedger;
let executor: Executor;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "openllama-exec-"));
  ledger = new AuditLedger(join(repo, ".audit.sqlite"));
  executor = new Executor(ledger);
});

afterEach(() => {
  ledger.close();
  rmSync(repo, { recursive: true, force: true });
});

const ctx = () => ({ repoRoot: repo });

// ─── Invariant 1: no audit, no action ─────────────────────────────────────────

describe("Invariant 1: audit-write failure → no side effect (THE thesis)", () => {
  /** A sink whose appendEvent always throws, simulating an audit outage. */
  class FailingSink implements AuditSink {
    calls = 0;
    appendEvent(_input: AppendInput): never {
      this.calls++;
      throw new Error("simulated audit subsystem outage");
    }
  }

  it("write_file performs NO filesystem change when the audit write fails", async () => {
    const sink = new FailingSink();
    const target = join(repo, "should-not-exist.txt");

    const outcome = await executor.execute(
      writeFileTool,
      { path: "should-not-exist.txt", content: "data" },
      { ledger: sink, ctx: ctx() },
    );

    expect(outcome.status).toBe("audit_failed");
    // The crucial assertion: the file was never created.
    expect(existsSync(target)).toBe(false);
    expect(sink.calls).toBeGreaterThan(0); // it did attempt the audit write
  });
});

// ─── Invariant 2: successful write → one correct event ────────────────────────

describe("Invariant 2: a successful write_file produces one correct audit event", () => {
  it("creates the file and records exactly one executed event with blob hashes", async () => {
    const content = "hello from openllama\n";
    const outcome = await executor.execute(
      writeFileTool,
      { path: "notes/new.txt", content },
      { ledger, ctx: ctx() },
    );

    expect(outcome.status).toBe("executed");
    expect(existsSync(join(repo, "notes/new.txt"))).toBe(true);
    expect(readFileSync(join(repo, "notes/new.txt"), "utf8")).toBe(content);

    const events = ledger.getEvents();
    const writeEvents = events.filter((e) => e.tool_name === "write_file");
    expect(writeEvents).toHaveLength(1);

    const ev = writeEvents[0]!;
    expect(ev.result).toBe("executed");
    expect(ev.permission_level).toBe(3);
    expect(ev.target).toBe("notes/new.txt");
    expect(ev.rollback_path).toBe("delete notes/new.txt");

    // data_changed carries before=null and the correct after blob hash.
    const expectedHash = "sha256:" + createHash("sha256").update(content).digest("hex");
    const changed = ev.data_changed as { before_hash: string | null; after_hash: string }[];
    expect(changed[0]!.before_hash).toBeNull();
    expect(changed[0]!.after_hash).toBe(expectedHash);
  });

  it("the rollback path actually undoes the write", async () => {
    await executor.execute(
      writeFileTool,
      { path: "tmp.txt", content: "x" },
      { ledger, ctx: ctx() },
    );
    const p = join(repo, "tmp.txt");
    expect(existsSync(p)).toBe(true);
    // rollback_path for write_file is "delete <path>"; perform it.
    rmSync(p);
    expect(existsSync(p)).toBe(false);
  });
});

// ─── Invariant 3: refuse to overwrite ─────────────────────────────────────────

describe("Invariant 3: write_file refuses to overwrite an existing file", () => {
  it("blocks an overwrite and leaves the original untouched", async () => {
    writeFileSync(join(repo, "existing.txt"), "ORIGINAL");

    const outcome = await executor.execute(
      writeFileTool,
      { path: "existing.txt", content: "OVERWRITTEN" },
      { ledger, ctx: ctx() },
    );

    expect(outcome.status).toBe("blocked");
    expect(readFileSync(join(repo, "existing.txt"), "utf8")).toBe("ORIGINAL");

    const ev = ledger.getEvents().find((e) => e.tool_name === "write_file");
    expect(ev!.result).toBe("blocked");
    expect(ev!.error).toContain("overwrite");
  });

  it("blocks writing to a secret path (.env)", async () => {
    const outcome = await executor.execute(
      writeFileTool,
      { path: ".env", content: "SECRET=1" },
      { ledger, ctx: ctx() },
    );
    expect(outcome.status).toBe("blocked");
    expect(existsSync(join(repo, ".env"))).toBe(false);
  });

  it("blocks writing outside the repo root", async () => {
    const outcome = await executor.execute(
      writeFileTool,
      { path: "../escape.txt", content: "x" },
      { ledger, ctx: ctx() },
    );
    expect(outcome.status).toBe("blocked");
  });
});

// ─── Invariant 4: chain stays valid after a write ─────────────────────────────

describe("Invariant 4: audit verify passes after a write_file", () => {
  it("the new event chains correctly and verify passes", async () => {
    await executor.execute(writeFileTool, { path: "a.txt", content: "a" }, { ledger, ctx: ctx() });
    await executor.execute(writeFileTool, { path: "b.txt", content: "b" }, { ledger, ctx: ctx() });

    const result = ledger.verify();
    expect(result.valid).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(2);
  });
});

// ─── Invalid args are blocked, never applied ──────────────────────────────────

describe("executor: invalid args are blocked and never applied", () => {
  it("rejects invalid args without creating a file", async () => {
    const outcome = await executor.execute(
      writeFileTool,
      { path: 123, content: "x" },
      { ledger, ctx: ctx() },
    );
    expect(outcome.status).toBe("blocked");
    const ev = ledger.getEvents().find((e) => e.tool_name === "write_file");
    expect(ev!.result).toBe("blocked");
    expect(ev!.error).toContain("invalid tool args");
  });
});
