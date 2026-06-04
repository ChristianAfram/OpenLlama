import { describe, it, expect } from "vitest";
import { unifiedDiff } from "./diff.js";

describe("unifiedDiff", () => {
  it("returns empty string for identical inputs", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n")).toBe("");
  });

  it("emits a hunk for a single-line change", () => {
    const d = unifiedDiff("a\nb\nc\n", "a\nB\nc\n", "a/f", "b/f");
    expect(d).toContain("--- a/f");
    expect(d).toContain("+++ b/f");
    expect(d).toContain("@@");
    expect(d).toContain("-b");
    expect(d).toContain("+B");
    expect(d).toContain(" a");
    expect(d).toContain(" c");
  });

  it("handles additions", () => {
    const d = unifiedDiff("a\n", "a\nb\n");
    expect(d).toContain("+b");
  });

  it("handles deletions", () => {
    const d = unifiedDiff("a\nb\n", "a\n");
    expect(d).toContain("-b");
  });

  it("handles creating from empty (new file)", () => {
    const d = unifiedDiff("", "x\ny\n", "/dev/null", "b/new");
    expect(d).toContain("+x");
    expect(d).toContain("+y");
  });
});
