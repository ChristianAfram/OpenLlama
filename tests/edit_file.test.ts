/**
 * edit_file tests (Prompt 6).
 *
 * Exit criteria:
 *   - plan() refuses to edit a non-existent file.
 *   - plan() refuses when old_string is absent.
 *   - plan() refuses when old_string appears more than once (ambiguous).
 *   - plan() refuses paths outside the repo root (via resolveWithinRepo).
 *   - plan() computes correct before/after hashes without writing.
 *   - apply() writes the new content to disk.
 *   - apply() aborts if the file changed between plan and apply (TOCTOU guard).
 *   - executor integration: blocked without approval, executes with valid L4 grant.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { editFileTool } from "../src/tools/edit_file.js";
import { AuditLedger } from "../src/kernel/audit.js";
import { Executor } from "../src/kernel/executor.js";
import {
  type ApprovalDecision,
  type ApprovalProvider,
  type ApprovalRequest,
  type ApprovalGrant,
} from "../src/kernel/approval.js";

function sha256(s: string) {
  return "sha256:" + createHash("sha256").update(s).digest("hex");
}

let tmpDir: string;
let ledger: AuditLedger;
let executor: Executor;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "edit_file_test_"));
  ledger = new AuditLedger(":memory:");
  executor = new Executor(ledger);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  ledger.close();
});

const ctx = () => ({ repoRoot: tmpDir });

function writeFile(rel: string, content: string) {
  const abs = join(tmpDir, rel);
  mkdirSync(join(tmpDir, rel, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

// ─── plan() guards ────────────────────────────────────────────────────────────

describe("edit_file plan()", () => {
  it("throws when file does not exist", () => {
    expect(() =>
      editFileTool.plan({ path: "missing.txt", old_string: "x", new_string: "y" }, ctx()),
    ).toThrow("file does not exist");
  });

  it("throws when old_string is absent from file", () => {
    writeFile("notes.txt", "hello world\n");
    expect(() =>
      editFileTool.plan({ path: "notes.txt", old_string: "not_there", new_string: "y" }, ctx()),
    ).toThrow("old_string not found");
  });

  it("throws when old_string appears multiple times", () => {
    writeFile("dup.txt", "foo foo foo");
    expect(() =>
      editFileTool.plan({ path: "dup.txt", old_string: "foo", new_string: "bar" }, ctx()),
    ).toThrow("appears 3 times");
  });

  it("throws when path escapes repo root", () => {
    expect(() =>
      editFileTool.plan({ path: "../outside.txt", old_string: "x", new_string: "y" }, ctx()),
    ).toThrow("escapes");
  });

  it("computes correct hashes without writing", async () => {
    const original = "const x = 1;\n";
    writeFile("code.ts", original);
    const mutation = await editFileTool.plan(
      { path: "code.ts", old_string: "const x = 1;", new_string: "const x = 2;" },
      ctx(),
    );
    const expectedAfter = sha256("const x = 2;\n");
    expect(mutation.data_changed[0]!.before_hash).toBe(sha256(original));
    expect(mutation.data_changed[0]!.after_hash).toBe(expectedAfter);
    // File must not be modified by plan
    expect(readFileSync(join(tmpDir, "code.ts"), "utf8")).toBe(original);
  });

  it("sets target to the file path", async () => {
    writeFile("a.txt", "apple");
    const mutation = await editFileTool.plan(
      { path: "a.txt", old_string: "apple", new_string: "orange" },
      ctx(),
    );
    expect(mutation.target).toBe("a.txt");
  });
});

// ─── apply() ─────────────────────────────────────────────────────────────────

describe("edit_file apply()", () => {
  it("writes the new content to disk", async () => {
    writeFile("hello.txt", "Hello, world!\n");
    const mutation = await editFileTool.plan(
      { path: "hello.txt", old_string: "world", new_string: "OpenLlama" },
      ctx(),
    );
    await mutation.apply();
    expect(readFileSync(join(tmpDir, "hello.txt"), "utf8")).toBe("Hello, OpenLlama!\n");
  });

  it("TOCTOU guard: aborts if file changed between plan and apply", async () => {
    writeFile("race.txt", "before");
    const mutation = await editFileTool.plan(
      { path: "race.txt", old_string: "before", new_string: "after" },
      ctx(),
    );
    // Simulate concurrent modification
    writeFileSync(join(tmpDir, "race.txt"), "tampered", "utf8");
    await expect(Promise.resolve().then(() => mutation.apply())).rejects.toThrow("changed between plan and apply");
  });
});

// ─── Executor integration ─────────────────────────────────────────────────────

describe("edit_file executor integration", () => {
  it("is blocked without an approval channel", async () => {
    writeFile("src.ts", "const a = 1;\n");
    const outcome = await executor.execute(
      editFileTool,
      { path: "src.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
      { ctx: ctx() },
    );
    expect(outcome.status).toBe("blocked");
    expect(readFileSync(join(tmpDir, "src.ts"), "utf8")).toBe("const a = 1;\n");
  });

  it("executes and edits file with valid L4 grant", async () => {
    writeFile("src.ts", "const a = 1;\n");
    const sessionId = "test-session-edit";

    const approvals: ApprovalProvider = {
      requestApproval(req: ApprovalRequest): ApprovalDecision {
        const grant: ApprovalGrant = {
          approval_id: "ap-edit-001",
          action_id: req.action_id,
          permission_level: 4,
          approved_by: "human:test",
          approved_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          scope: {
            tools: ["edit_file"],
            path_globs: ["src.ts"],
            session_id: sessionId,
            max_level: 4,
          },
          reason: "test",
          rollback_path: "git checkout src.ts",
        };
        return { status: "granted", grant };
      },
    };

    const outcome = await executor.execute(
      editFileTool,
      { path: "src.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
      { ctx: ctx(), session_id: sessionId, approvals },
    );

    expect(outcome.status).toBe("executed");
    expect(readFileSync(join(tmpDir, "src.ts"), "utf8")).toBe("const a = 2;\n");
  });
});
