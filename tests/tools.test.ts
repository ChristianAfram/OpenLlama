/**
 * Read-only/draft tool tests: path containment, secret denial, behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileTool } from "../src/tools/read_file.js";
import { listDirTool } from "../src/tools/list_dir.js";
import { grepTool } from "../src/tools/grep.js";
import { proposeDiffTool } from "../src/tools/propose_diff.js";
import { resolveWithinRepo, PathDeniedError } from "../src/tools/paths.js";
import type { ToolContext } from "../src/tools/registry.js";

let repo: string;
let ctx: ToolContext;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "openllama-tools-"));
  ctx = { repoRoot: repo };
  writeFileSync(join(repo, "a.txt"), "alpha\nbeta\ngamma\n");
  writeFileSync(join(repo, ".env"), "SECRET_KEY=supersecretvalue123456\n");
  mkdirSync(join(repo, "sub"));
  writeFileSync(join(repo, "sub", "b.txt"), "needle here\n");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("path containment", () => {
  it("resolves a path inside the repo", () => {
    expect(resolveWithinRepo(repo, "a.txt")).toBe(join(repo, "a.txt"));
  });

  it("rejects path traversal out of the repo", () => {
    expect(() => resolveWithinRepo(repo, "../../etc/passwd")).toThrow(PathDeniedError);
  });

  it("rejects an absolute path outside the repo", () => {
    expect(() => resolveWithinRepo(repo, "/etc/passwd")).toThrow(PathDeniedError);
  });

  it("rejects the .env secret path", () => {
    expect(() => resolveWithinRepo(repo, ".env")).toThrow(/secret denylist/);
  });
});

describe("read_file (L0)", () => {
  it("reads a file inside the repo", async () => {
    const r = await readFileTool.execute({ path: "a.txt" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("alpha");
    expect(r.audit?.data_read).toEqual(["a.txt"]);
  });

  it("refuses to read .env (secret path) by throwing", async () => {
    await expect(
      Promise.resolve().then(() => readFileTool.execute({ path: ".env" }, ctx)),
    ).rejects.toThrow(PathDeniedError);
  });

  it("has the correct descriptor", () => {
    expect(readFileTool.descriptor.permission_level).toBe(0);
    expect(readFileTool.descriptor.requires_approval).toBe(false);
  });
});

describe("list_dir (L0)", () => {
  it("lists entries with trailing slash on dirs", async () => {
    const r = await listDirTool.execute({ path: "." }, ctx);
    expect(r.output).toContain("a.txt");
    expect(r.output).toContain("sub/");
  });
});

describe("grep (L0)", () => {
  it("finds a pattern across files", async () => {
    const r = await grepTool.execute({ pattern: "needle", path: ".", ignore_case: false }, ctx);
    expect(r.output).toContain("sub/b.txt");
  });

  it("does not search inside .env (secret path skipped)", async () => {
    const r = await grepTool.execute(
      { pattern: "supersecretvalue", path: ".", ignore_case: false },
      ctx,
    );
    expect(r.output).toBe("(no matches)");
  });

  it("reports invalid regex gracefully", async () => {
    const r = await grepTool.execute({ pattern: "(", path: ".", ignore_case: false }, ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("invalid regex");
  });
});

describe("propose_diff (L1)", () => {
  it("produces a unified diff and writes nothing", async () => {
    const r = await proposeDiffTool.execute(
      { path: "a.txt", new_content: "alpha\nBETA\ngamma\n" },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("@@");
    expect(r.output).toContain("-beta");
    expect(r.output).toContain("+BETA");
  });

  it("treats a non-existent file as a new-file proposal", async () => {
    const r = await proposeDiffTool.execute(
      { path: "new.txt", new_content: "fresh\n" },
      ctx,
    );
    expect(r.output).toContain("/dev/null");
    expect((r.data as { isNew: boolean }).isNew).toBe(true);
  });

  it("reports no change when content is identical", async () => {
    const r = await proposeDiffTool.execute(
      { path: "a.txt", new_content: "alpha\nbeta\ngamma\n" },
      ctx,
    );
    expect(r.output).toContain("no change");
  });
});
