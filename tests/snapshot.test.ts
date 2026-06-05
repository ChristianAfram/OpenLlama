/**
 * Snapshot store tests (Prompt 10).
 *
 * Proves:
 *  1. Content-addressed storage: same content → same ref.
 *  2. Round-trip: put/read returns identical bytes.
 *  3. has() reports correctly.
 *  4. read() throws on missing ref.
 *  5. Idempotent: double-put does not corrupt.
 *  6. Invalid ref rejects.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotStore } from "../src/kernel/snapshot.js";

function makeStore(): { store: SnapshotStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "snap-"));
  return { store: new SnapshotStore(join(dir, "snaps")), dir };
}

describe("SnapshotStore", () => {
  it("stores and retrieves content by hash", () => {
    const { store, dir } = makeStore();
    try {
      const ref = store.put("hello world\n");
      expect(ref).toMatch(/^sha256:[0-9a-f]{64}$/);
      const back = store.read(ref).toString("utf8");
      expect(back).toBe("hello world\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("same content produces the same ref (content-addressed)", () => {
    const { store, dir } = makeStore();
    try {
      const ref1 = store.put("same content");
      const ref2 = store.put("same content");
      expect(ref1).toBe(ref2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("different content produces different refs", () => {
    const { store, dir } = makeStore();
    try {
      const ref1 = store.put("content A");
      const ref2 = store.put("content B");
      expect(ref1).not.toBe(ref2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("has() returns true for stored content, false for absent", () => {
    const { store, dir } = makeStore();
    try {
      const ref = store.put("present");
      expect(store.has(ref)).toBe(true);
      const fakeRef = "sha256:" + "a".repeat(64);
      expect(store.has(fakeRef)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("read() throws on missing ref", () => {
    const { store, dir } = makeStore();
    try {
      const missingRef = "sha256:" + "b".repeat(64);
      expect(() => store.read(missingRef)).toThrow(/snapshot not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an invalid ref (not sha256 hex)", () => {
    const { store, dir } = makeStore();
    try {
      expect(() => store.read("not-a-hash")).toThrow(/invalid snapshot ref/);
      expect(store.has("garbage")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("double-put is idempotent", () => {
    const { store, dir } = makeStore();
    try {
      const ref1 = store.put("idempotent content");
      const ref2 = store.put("idempotent content");
      expect(ref1).toBe(ref2);
      const back = store.read(ref1).toString("utf8");
      expect(back).toBe("idempotent content");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles Buffer input", () => {
    const { store, dir } = makeStore();
    try {
      const buf = Buffer.from("buffer content", "utf8");
      const ref = store.put(buf);
      const back = store.read(ref);
      expect(back.equals(buf)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
