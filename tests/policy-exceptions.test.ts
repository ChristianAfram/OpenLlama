/**
 * Exception lifecycle tests (Prompt 8, framework §25).
 *
 * Proves the policy CI gate fails on an expired or malformed exception, and
 * passes on a well-formed, unexpired one. The real catalog must be valid today.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExceptions, validateExceptions } from "../src/policy/exceptions.js";

function writeCatalog(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "exc-"));
  const path = join(dir, "exceptions.yml");
  writeFileSync(path, yaml, "utf8");
  return path;
}

describe("validateExceptions", () => {
  it("passes a well-formed, unexpired, active exception", () => {
    const records = [
      {
        exception_id: "EX-1",
        owner: "chris",
        expires_at: "2999-01-01",
        compensating_control: "manual approval",
        status: "active",
      },
    ];
    const v = validateExceptions(records, new Date("2026-06-05"));
    expect(v.ok).toBe(true);
    expect(v.active).toBe(1);
    expect(v.expired).toHaveLength(0);
  });

  it("flags an active exception past its expiry as a hard blocker", () => {
    const records = [
      {
        exception_id: "EX-OLD",
        owner: "chris",
        expires_at: "2025-01-01",
        compensating_control: "x",
        status: "active",
      },
    ];
    const v = validateExceptions(records, new Date("2026-06-05"));
    expect(v.ok).toBe(false);
    expect(v.expired.map((e) => e.exception_id)).toContain("EX-OLD");
  });

  it("does NOT flag an expired exception that is no longer active", () => {
    const records = [
      {
        exception_id: "EX-RESOLVED",
        owner: "chris",
        expires_at: "2025-01-01",
        compensating_control: "x",
        status: "resolved",
      },
    ];
    const v = validateExceptions(records, new Date("2026-06-05"));
    expect(v.expired).toHaveLength(0);
    expect(v.ok).toBe(true);
  });

  it("flags missing owner / expiry / compensating control", () => {
    const records = [{ exception_id: "EX-BAD", status: "active" }];
    const v = validateExceptions(records, new Date("2026-06-05"));
    expect(v.ok).toBe(false);
    const problems = v.malformed.map((m) => m.problem).join(" | ");
    expect(problems).toMatch(/missing owner/);
    expect(problems).toMatch(/missing expires_at/);
    expect(problems).toMatch(/missing compensating_control/);
  });

  it("flags an unparseable expiry date", () => {
    const records = [
      { exception_id: "EX-BADDATE", owner: "c", compensating_control: "x", expires_at: "not-a-date", status: "active" },
    ];
    const v = validateExceptions(records, new Date("2026-06-05"));
    expect(v.malformed.map((m) => m.problem).join(" ")).toMatch(/unparseable expires_at/);
  });
});

describe("loadExceptions + the real catalog", () => {
  it("parses a YAML list with folded scalars", () => {
    const path = writeCatalog(
      [
        "- exception_id: EX-Y",
        "  owner: chris",
        "  expires_at: 2999-01-01",
        "  compensating_control: >-",
        "    a folded",
        "    multi-line control",
        "  status: active",
      ].join("\n"),
    );
    try {
      const records = loadExceptions(path);
      expect(records).toHaveLength(1);
      expect(records[0]!.exception_id).toBe("EX-Y");
      expect(records[0]!.compensating_control).toContain("folded");
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("an empty catalog parses to an empty list", () => {
    const path = writeCatalog("# just a comment\n");
    try {
      expect(loadExceptions(path)).toEqual([]);
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("the committed catalog/exceptions.yml is valid and unexpired today", () => {
    const records = loadExceptions(join(process.cwd(), "catalog/exceptions.yml"));
    const v = validateExceptions(records);
    expect(v.ok, JSON.stringify({ expired: v.expired, malformed: v.malformed })).toBe(true);
  });
});
