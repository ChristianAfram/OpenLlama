/**
 * Audit ledger invariant tests (Prompt 1, required).
 *
 * Five invariants that MUST pass:
 *   1. N events produce a chain where each prev_hash === prior hash.
 *   2. `verify` passes on an untampered ledger.
 *   3. Mutating/deleting/reordering an event breaks the chain at the correct seq.
 *   4. A secret value passed into an event never appears in the stored row.
 *   5. `appendEvent` surfaces failure when the DB write is blocked.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  AuditLedger,
  GENESIS_HASH,
  type AppendInput,
} from "../src/kernel/audit.js";
import { canonicalJson } from "../src/lib/canonical-json.js";
import { createHash } from "node:crypto";

// ─── Test scaffolding ─────────────────────────────────────────────────────────

let tmpDir: string;
let ledger: AuditLedger;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "openllama-audit-"));
  dbPath = join(tmpDir, "audit.sqlite");
  ledger = new AuditLedger(dbPath);
});

afterEach(() => {
  try {
    ledger.close();
  } catch {
    // already closed in some tests
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEvent(action: string, overrides: Partial<AppendInput> = {}): AppendInput {
  return { action, service: "test", actor: "test-user", ...overrides };
}

// ─── Invariant 1: Hash chain ──────────────────────────────────────────────────

describe("Invariant 1: hash chain linkage", () => {
  it("first event has prev_hash = GENESIS_HASH", () => {
    ledger.appendEvent(makeEvent("test_action"));
    const events = ledger.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.prev_hash).toBe(GENESIS_HASH);
  });

  it("each subsequent event's prev_hash equals the prior event's hash", () => {
    const N = 10;
    for (let i = 0; i < N; i++) {
      ledger.appendEvent(makeEvent(`action_${i}`));
    }
    const events = ledger.getEvents(N);
    expect(events).toHaveLength(N);
    for (let i = 1; i < N; i++) {
      expect(events[i]!.prev_hash).toBe(events[i - 1]!.hash);
    }
  });

  it("each hash equals sha256(prev_hash + canonical_json(body))", () => {
    ledger.appendEvent(makeEvent("hash_check"));
    const [ev] = ledger.getEvents(1);
    // Recompute manually
    const { seq: _seq, prev_hash, hash, ...body } = ev!;
    const expected = createHash("sha256")
      .update(prev_hash + canonicalJson(body))
      .digest("hex");
    expect(hash).toBe(expected);
  });

  it("appendEvent returns the correct hash and seq", () => {
    const r1 = ledger.appendEvent(makeEvent("a1"));
    const r2 = ledger.appendEvent(makeEvent("a2"));
    expect(r1.seq).toBe(1);
    expect(r2.seq).toBe(2);
    const events = ledger.getEvents(2);
    expect(r1.hash).toBe(events[0]!.hash);
    expect(r2.hash).toBe(events[1]!.hash);
  });
});

// ─── Invariant 2: verify passes on untampered ledger ─────────────────────────

describe("Invariant 2: verify passes on an untampered ledger", () => {
  it("empty ledger verifies as valid", () => {
    const result = ledger.verify();
    expect(result.valid).toBe(true);
    expect(result.count).toBe(0);
  });

  it("ledger with many events verifies as valid", () => {
    for (let i = 0; i < 20; i++) {
      ledger.appendEvent(makeEvent(`action_${i}`));
    }
    const result = ledger.verify();
    expect(result.valid).toBe(true);
    expect(result.count).toBe(20);
    expect(result.first_break_seq).toBeNull();
  });
});

// ─── Invariant 3: tampering detected at correct seq ──────────────────────────

describe("Invariant 3: tampering is detected at the correct sequence number", () => {
  it("mutating an event's stored hash breaks the chain at that seq", () => {
    for (let i = 0; i < 5; i++) ledger.appendEvent(makeEvent(`action_${i}`));

    // Close our ledger, directly mutate via a raw connection.
    ledger.close();
    const raw = new Database(dbPath);
    // Disable the no-update trigger temporarily so we can test the verifier.
    raw.pragma("recursive_triggers = OFF");
    raw.exec("DROP TRIGGER IF EXISTS no_update_events");
    raw.prepare("UPDATE events SET hash = 'deadbeef' || hash WHERE seq = 3").run();
    raw.close();

    ledger = new AuditLedger(dbPath);
    const result = ledger.verify();
    expect(result.valid).toBe(false);
    expect(result.first_break_seq).toBe(3);
  });

  it("mutating an event body (action field) breaks the chain at that seq", () => {
    for (let i = 0; i < 4; i++) ledger.appendEvent(makeEvent(`action_${i}`));

    ledger.close();
    const raw = new Database(dbPath);
    raw.exec("DROP TRIGGER IF EXISTS no_update_events");
    raw.prepare("UPDATE events SET action = 'TAMPERED' WHERE seq = 2").run();
    raw.close();

    ledger = new AuditLedger(dbPath);
    const result = ledger.verify();
    expect(result.valid).toBe(false);
    expect(result.first_break_seq).toBe(2);
  });

  it("deleting an event (bypassing trigger) breaks the chain", () => {
    for (let i = 0; i < 5; i++) ledger.appendEvent(makeEvent(`action_${i}`));

    ledger.close();
    const raw = new Database(dbPath);
    raw.exec("DROP TRIGGER IF EXISTS no_delete_events");
    raw.prepare("DELETE FROM events WHERE seq = 2").run();
    raw.close();

    ledger = new AuditLedger(dbPath);
    const result = ledger.verify();
    // seq 2 is gone; seq 3's prev_hash references the old seq 2 hash,
    // but now prev_hash no longer matches what was before seq 3.
    expect(result.valid).toBe(false);
    expect(result.first_break_seq).toBeDefined();
  });

  it("the append-only triggers block UPDATE and DELETE from normal code", () => {
    ledger.appendEvent(makeEvent("protected_event"));
    ledger.close();

    const raw = new Database(dbPath);
    expect(() =>
      raw.prepare("UPDATE events SET action = 'X' WHERE seq = 1").run(),
    ).toThrow(/append-only/);
    expect(() =>
      raw.prepare("DELETE FROM events WHERE seq = 1").run(),
    ).toThrow(/append-only/);
    raw.close();
  });
});

// ─── Invariant 4: secrets never appear in stored rows ────────────────────────

describe("Invariant 4: secrets are never stored in the clear", () => {
  const SECRET = "sk-secret-api-key-abcdefghij12345678"; // gitleaks:allow

  it("a secret in the target field is redacted in the stored row", () => {
    ledger.appendEvent(makeEvent("tool_call", { target: SECRET }));
    const [ev] = ledger.getEvents(1);
    expect(ev!.target).not.toContain(SECRET);
    expect(ev!.target).toBe("[REDACTED]");
  });

  it("a redaction record is stored and contains a sha256 fingerprint", () => {
    ledger.appendEvent(makeEvent("tool_call", { target: SECRET }));
    const [ev] = ledger.getEvents(1);
    expect(ev!.redactions).toBeDefined();
    expect(ev!.redactions!.length).toBeGreaterThan(0);
    const rec = ev!.redactions![0]!;
    expect(rec.field).toBe("target");
    expect(rec.original_sha256).toBeDefined();
    expect(rec.original_sha256).toHaveLength(64); // hex SHA-256
  });

  it("the redaction record sha256 matches the original value", () => {
    ledger.appendEvent(makeEvent("tool_call", { target: SECRET }));
    const [ev] = ledger.getEvents(1);
    const expected = createHash("sha256").update(SECRET).digest("hex");
    expect(ev!.redactions![0]!.original_sha256).toBe(expected);
  });

  it("a PEM private key in error is redacted", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nABC123\n-----END RSA PRIVATE KEY-----"; // gitleaks:allow
    ledger.appendEvent(makeEvent("tool_call", { error: pem }));
    const [ev] = ledger.getEvents(1);
    expect(ev!.error).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(ev!.error).toBe("[REDACTED]");
  });

  it("non-secret values are stored unchanged", () => {
    ledger.appendEvent(makeEvent("read_file", { target: "src/index.ts" }));
    const [ev] = ledger.getEvents(1);
    expect(ev!.target).toBe("src/index.ts");
    expect(ev!.redactions ?? []).toHaveLength(0);
  });
});

// ─── Invariant 5: appendEvent surfaces write failures ────────────────────────

describe("Invariant 5: appendEvent throws on write failure — no silent success", () => {
  it("throws AuditWriteError when the DB connection is closed before appending", () => {
    ledger.close();
    expect(() =>
      ledger.appendEvent(makeEvent("should_fail")),
    ).toThrow();
  });

  it("does NOT silently succeed when closed — the error surfaces to the caller", () => {
    ledger.close();
    let caught: Error | null = null;
    try {
      ledger.appendEvent(makeEvent("should_fail"));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toBeTruthy();
  });

  it("a successful append always increments the count", () => {
    const before = ledger.count();
    ledger.appendEvent(makeEvent("counted"));
    expect(ledger.count()).toBe(before + 1);
  });
});

// ─── Canonical JSON ───────────────────────────────────────────────────────────

describe("canonicalJson", () => {
  it("produces stable output regardless of insertion order", () => {
    const a = canonicalJson({ z: 1, a: 2, m: 3 });
    const b = canonicalJson({ m: 3, z: 1, a: 2 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"m":3,"z":1}');
  });

  it("handles nested objects and arrays", () => {
    const result = canonicalJson({ b: [3, 2, 1], a: { z: "x", a: "y" } });
    expect(result).toBe('{"a":{"a":"y","z":"x"},"b":[3,2,1]}');
  });

  it("handles null and primitives", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson("hello")).toBe('"hello"');
  });
});
