/**
 * Rollback engine tests (Prompt 10).
 *
 * Proves:
 *  1. write_file rollback deletes the created file and records an audit event.
 *  2. write_file rollback refuses if the file was modified after creation.
 *  3. edit_file rollback restores prior content.
 *  4. edit_file rollback refuses if the file was modified again after the edit.
 *  5. edit_file rollback returns precondition_failed when snapshot is missing.
 *  6. Rollback of unknown event_id returns not_found.
 *  7. Double rollback returns already_reversed.
 *  8. irrecoverable tool returns irrecoverable status with instructions.
 */

import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLedger } from "../src/kernel/audit.js";
import { Executor } from "../src/kernel/executor.js";
import { RollbackEngine } from "../src/kernel/rollback.js";
import { SnapshotStore } from "../src/kernel/snapshot.js";
import { writeFileTool } from "../src/tools/write_file.js";
import { editFileTool } from "../src/tools/edit_file.js";
import { faithfulProvider } from "./helpers/faithful-approval.js";

function makeKernel(repoRoot: string): {
  ledger: AuditLedger;
  snapshots: SnapshotStore;
  executor: Executor;
  engine: RollbackEngine;
} {
  const ledger = new AuditLedger(":memory:");
  const snapshotDir = join(repoRoot, ".snapshots");
  mkdirSync(snapshotDir, { recursive: true });
  const snapshots = new SnapshotStore(snapshotDir);
  const executor = new Executor(ledger);
  const engine = new RollbackEngine(ledger, snapshots, repoRoot);
  return { ledger, snapshots, executor, engine };
}

describe("RollbackEngine — write_file", () => {
  it("deletes the created file and records a rollback audit event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rb-"));
    try {
      const { executor, ledger, engine } = makeKernel(dir);

      const outcome = await executor.execute(
        writeFileTool,
        { path: "created.txt", content: "hello\n" },
        { ctx: { repoRoot: dir } },
      );
      expect(outcome.status).toBe("executed");
      expect(existsSync(join(dir, "created.txt"))).toBe(true);

      const result = await engine.rollback(outcome.status === "executed" ? outcome.event_id : "");
      expect(result.status).toBe("rolled_back");
      expect(existsSync(join(dir, "created.txt"))).toBe(false);

      // A rollback audit event must exist.
      const events = ledger.getEvents(100, 0);
      const rollbackEvent = events.find(
        (e) => e.action === "write_file_rollback" && e.result === "executed",
      );
      expect(rollbackEvent).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns precondition_failed if the file was modified after creation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rb-"));
    try {
      const { executor, engine } = makeKernel(dir);

      const outcome = await executor.execute(
        writeFileTool,
        { path: "modified.txt", content: "original\n" },
        { ctx: { repoRoot: dir } },
      );
      expect(outcome.status).toBe("executed");

      // Tamper with the file after creation.
      writeFileSync(join(dir, "modified.txt"), "tampered\n", "utf8");

      const event_id = outcome.status === "executed" ? outcome.event_id : "";
      const result = await engine.rollback(event_id);
      expect(result.status).toBe("precondition_failed");
      expect(result.description).toMatch(/modified since/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("RollbackEngine — edit_file", () => {
  it("restores the file to its pre-edit state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rb-"));
    try {
      const { executor, snapshots, engine } = makeKernel(dir);

      const originalContent = "line one\nline two\n";
      writeFileSync(join(dir, "edited.txt"), originalContent, "utf8");

      const sessionId = "test-session-rc002";
      const outcome = await executor.execute(
        editFileTool,
        { path: "edited.txt", old_string: "line one", new_string: "LINE ONE" },
        {
          ctx: { repoRoot: dir },
          snapshots,
          session_id: sessionId,
          approvals: faithfulProvider(sessionId, "edited.txt"),
        },
      );
      expect(outcome.status).toBe("executed");

      const afterEdit = readFileSync(join(dir, "edited.txt"), "utf8");
      expect(afterEdit).toContain("LINE ONE");

      const event_id = outcome.status === "executed" ? outcome.event_id : "";
      const result = await engine.rollback(event_id);
      expect(result.status).toBe("rolled_back");

      const restored = readFileSync(join(dir, "edited.txt"), "utf8");
      expect(restored).toBe(originalContent);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns precondition_failed if the snapshot is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rb-"));
    try {
      const { executor, engine } = makeKernel(dir);

      writeFileSync(join(dir, "nosnap.txt"), "original\n", "utf8");

      // Execute WITHOUT passing snapshots — no snapshot captured.
      const sessionId = "test-session-rc003";
      const outcome = await executor.execute(
        editFileTool,
        { path: "nosnap.txt", old_string: "original", new_string: "changed" },
        {
          ctx: { repoRoot: dir },
          session_id: sessionId,
          approvals: faithfulProvider(sessionId, "nosnap.txt"),
        },
      );
      expect(outcome.status).toBe("executed");

      const event_id = outcome.status === "executed" ? outcome.event_id : "";
      const result = await engine.rollback(event_id);
      expect(result.status).toBe("precondition_failed");
      expect(result.description).toMatch(/snapshot not found/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns precondition_failed if the file was modified after the edit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rb-"));
    try {
      const { executor, snapshots, engine } = makeKernel(dir);

      writeFileSync(join(dir, "changed-twice.txt"), "original\n", "utf8");

      const sessionId = "test-session-rc004";
      const outcome = await executor.execute(
        editFileTool,
        { path: "changed-twice.txt", old_string: "original", new_string: "edited" },
        {
          ctx: { repoRoot: dir },
          snapshots,
          session_id: sessionId,
          approvals: faithfulProvider(sessionId, "changed-twice.txt"),
        },
      );
      expect(outcome.status).toBe("executed");

      // A second modification happens after the edit — rollback should refuse.
      writeFileSync(join(dir, "changed-twice.txt"), "further changed\n", "utf8");

      const event_id = outcome.status === "executed" ? outcome.event_id : "";
      const result = await engine.rollback(event_id);
      expect(result.status).toBe("precondition_failed");
      expect(result.description).toMatch(/modified since/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("RollbackEngine — edge cases", () => {
  it("returns not_found for an unknown event_id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rb-"));
    try {
      const { engine } = makeKernel(dir);
      const result = await engine.rollback("00000000-0000-0000-0000-000000000000");
      expect(result.status).toBe("not_found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns already_reversed on a second rollback of the same event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rb-"));
    try {
      const { executor, engine } = makeKernel(dir);

      const outcome = await executor.execute(
        writeFileTool,
        { path: "double.txt", content: "x\n" },
        { ctx: { repoRoot: dir } },
      );
      expect(outcome.status).toBe("executed");

      const event_id = outcome.status === "executed" ? outcome.event_id : "";
      const first = await engine.rollback(event_id);
      expect(first.status).toBe("rolled_back");

      const second = await engine.rollback(event_id);
      expect(second.status).toBe("already_reversed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns irrecoverable with instructions for shell-like tool_names", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rb-"));
    try {
      const { ledger } = makeKernel(dir);
      const snapshots = new SnapshotStore(join(dir, ".snaps"));
      const engine = new RollbackEngine(ledger, snapshots, dir);

      // Inject a fake run_shell executed event directly into the ledger.
      const { event_id } = ledger.appendEvent({
        actor: "agent:openllama",
        service: "tool-executor",
        action: "run_shell",
        tool_name: "run_shell",
        permission_level: 4,
        risk_level: "high",
        target: "run_shell",
        result: "executed",
        rollback_path: "n/a",
      });

      const result = await engine.rollback(event_id);
      expect(result.status).toBe("irrecoverable");
      expect(result.instructions).toBeDefined();
      expect(result.instructions).toMatch(/manually/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
