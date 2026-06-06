/**
 * Governed session deletion (v0.7 — framework §41 Level 5).
 *
 * Proves the governance invariants of `deleteSessionGoverned`:
 *   - Deletion requires explicit confirmation; unconfirmed → no audit, no delete.
 *   - A confirmed delete writes a Level 5 audit event (permission_level 5,
 *     risk_level critical, REQUIRE_CONFIRMATION) BEFORE removing the transcript.
 *   - No-audit-no-action: if the audit write fails, the transcript is NOT removed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLedger, AuditWriteError } from "../src/kernel/audit.js";
import { SessionStore } from "../src/sessions/store.js";
import { deleteSessionGoverned, type DeleteDeps } from "../src/commands/session.js";

let dir: string;
let store: SessionStore;
let ledger: AuditLedger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencli-sessrm-"));
  store = new SessionStore(join(dir, "sessions.sqlite"));
  ledger = new AuditLedger(join(dir, "audit.sqlite"));
});

afterEach(() => {
  store.close();
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(id = "s1"): void {
  store.create({
    session_id: id,
    correlation_id: `corr-${id}`,
    cwd: "/repo",
    model: "test-model",
    prompt_version: "v1",
  });
  store.appendTurn(id, { role: "user", content: "hello" });
}

describe("deleteSessionGoverned", () => {
  it("requires confirmation: unconfirmed delete removes nothing and writes no audit event", () => {
    seed();
    const result = deleteSessionGoverned({ store, ledger }, "s1", false);
    expect(result).toEqual({ ok: false, reason: "confirmation_required" });
    // Session still present
    expect(store.get("s1")).not.toBeNull();
    // No audit event written
    expect(ledger.getEvents().filter((e) => e.action === "session_delete")).toHaveLength(0);
  });

  it("returns not_found for an unknown id (no audit, no delete)", () => {
    const result = deleteSessionGoverned({ store, ledger }, "ghost", true);
    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(ledger.getEvents().filter((e) => e.action === "session_delete")).toHaveLength(0);
  });

  it("confirmed delete writes Level 5 audit metadata, then removes the transcript", () => {
    seed();
    const result = deleteSessionGoverned({ store, ledger }, "s1", true);
    expect(result).toEqual({ ok: true });

    // Transcript removed
    expect(store.get("s1")).toBeNull();
    expect(store.getTurns("s1")).toHaveLength(0);

    // Exactly one Level 5 audit event with correct metadata
    const events = ledger.getEvents().filter((e) => e.action === "session_delete");
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.permission_level).toBe(5);
    expect(ev.risk_level).toBe("critical");
    expect(ev.policy_decision).toBe("REQUIRE_CONFIRMATION");
    expect(ev.target).toBe("session:s1");
    expect(ev.correlation_id).toBe("corr-s1");
    expect(ev.result).toBe("executed");
    expect(ev.policy_reason).toContain("Level 5");
  });

  it("no-audit-no-action: if the audit write fails, the transcript is NOT removed", () => {
    seed();
    // Ledger stub that always fails the audit write.
    const failingLedger: DeleteDeps["ledger"] = {
      appendEvent() {
        throw new AuditWriteError("simulated audit failure");
      },
    };
    const result = deleteSessionGoverned({ store, ledger: failingLedger }, "s1", true);
    expect(result).toEqual({ ok: false, reason: "audit_failed" });
    // Transcript MUST survive — the side effect never ran.
    expect(store.get("s1")).not.toBeNull();
    expect(store.turnCount("s1")).toBe(1);
  });
});
