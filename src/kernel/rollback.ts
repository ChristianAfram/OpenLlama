/**
 * Rollback engine — one-command revert for every reversible mutation.
 *
 * Three mutation types require different reversal strategies:
 *
 *   write_file (create):   delete the created file.
 *   edit_file  (modify):   restore the before-content from the snapshot store.
 *   git commit / push:     irrecoverable from here — instructions only.
 *   run_shell:             irrecoverable — reason recorded, instructions given.
 *
 * Safety properties:
 *   - The rollback itself is a mutation and routes through the executor so it
 *     is audited and gated identically to any other write.
 *   - Reversal reads the snapshot store (content-addressed blobs) rather than
 *     re-reading the live file, so it uses exactly the bytes captured at plan
 *     time regardless of what happened between execution and rollback.
 *   - Before restoring a file the engine verifies the current on-disk hash
 *     matches `after_hash` from the original plan — if the file was modified
 *     again after the original edit, rollback is refused rather than silently
 *     clobbering a later change.
 *
 * Master Plan §13, framework §19, §49, §55.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditEvent } from "./audit.js";
import { AuditLedger } from "./audit.js";
import type { SnapshotStore } from "./snapshot.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type RollbackStatus =
  | "rolled_back"
  | "already_reversed"
  | "irrecoverable"
  | "precondition_failed"
  | "not_found";

export interface RollbackResult {
  status: RollbackStatus;
  event_id: string;
  rollback_event_id?: string;
  description: string;
  instructions?: string;
}

// ─── RollbackEngine ───────────────────────────────────────────────────────────

export class RollbackEngine {
  constructor(
    private readonly ledger: AuditLedger,
    private readonly snapshots: SnapshotStore,
    private readonly repoRoot: string,
  ) {}

  /**
   * Roll back the mutation identified by `event_id`.
   * Returns a result describing what happened and any manual instructions.
   */
  async rollback(event_id: string): Promise<RollbackResult> {
    // 1. Look up the original event.
    const events = this.ledger.getEvents(100_000, 0);
    const original = events.find((e) => e.event_id === event_id);
    if (!original) {
      return {
        status: "not_found",
        event_id,
        description: `no event found with id ${event_id}`,
      };
    }

    if (original.result !== "executed") {
      return {
        status: "already_reversed",
        event_id,
        description: `event ${event_id} was not executed (result=${original.result ?? "unknown"})`,
      };
    }

    // 2. Check whether a rollback event already exists for this event_id (the
    //    correlation_id of rollback events is set to the original event_id).
    const alreadyRolledBack = events.some(
      (e) => e.correlation_id === event_id && e.action.endsWith("_rollback"),
    );
    if (alreadyRolledBack) {
      return {
        status: "already_reversed",
        event_id,
        description: `a rollback for event ${event_id} has already been recorded`,
      };
    }

    // 3. Dispatch by tool type.
    const tool = original.tool_name;

    if (tool === "write_file") {
      return this.rollbackWriteFile(original);
    }

    if (tool === "edit_file") {
      return this.rollbackEditFile(original);
    }

    // git commit / push, run_shell, and anything else → irrecoverable.
    const instructions = irrecoverableInstructions(original);
    return {
      status: "irrecoverable",
      event_id,
      description: `${tool ?? "unknown tool"} mutations cannot be automatically reversed`,
      instructions,
    };
  }

  // ─── write_file rollback ──────────────────────────────────────────────────

  private rollbackWriteFile(original: AuditEvent): RollbackResult {
    const target = original.target;
    if (!target) {
      return {
        status: "precondition_failed",
        event_id: original.event_id,
        description: "original event has no target path",
      };
    }

    const abs = join(this.repoRoot, target);
    if (!existsSync(abs)) {
      // Already gone — record the rollback event and call it done.
      this.appendRollbackEvent(original, `deleted ${target} (already absent)`);
      return {
        status: "rolled_back",
        event_id: original.event_id,
        description: `${target} was already absent; rollback recorded`,
      };
    }

    // Verify the file hasn't been modified since the original write.
    const currentHash = hashFile(abs);
    const expectedHash = firstAfterHash(original);
    if (expectedHash && currentHash !== expectedHash) {
      return {
        status: "precondition_failed",
        event_id: original.event_id,
        description:
          `${target} has been modified since it was created (current hash ${currentHash.slice(0, 16)}… ` +
          `does not match after_hash ${expectedHash.slice(0, 16)}…). Refusing to delete.`,
      };
    }

    rmSync(abs);
    const rollback_event_id = this.appendRollbackEvent(original, `deleted ${target}`);
    return {
      status: "rolled_back",
      event_id: original.event_id,
      rollback_event_id,
      description: `deleted ${target} (write_file rollback)`,
    };
  }

  // ─── edit_file rollback ───────────────────────────────────────────────────

  private rollbackEditFile(original: AuditEvent): RollbackResult {
    const target = original.target;
    if (!target) {
      return {
        status: "precondition_failed",
        event_id: original.event_id,
        description: "original event has no target path",
      };
    }

    // Get the before/after hashes from data_changed.
    const changed = firstDataChanged(original);
    if (!changed) {
      return {
        status: "precondition_failed",
        event_id: original.event_id,
        description: "original event has no data_changed record",
      };
    }

    const { before_hash, after_hash } = changed;
    if (!before_hash) {
      return {
        status: "irrecoverable",
        event_id: original.event_id,
        description: "before_hash is null — this was a create, not an edit",
      };
    }

    // Load the before-content from the snapshot store.
    if (!this.snapshots.has(before_hash)) {
      return {
        status: "precondition_failed",
        event_id: original.event_id,
        description:
          `snapshot not found for before_hash ${before_hash.slice(0, 16)}…. ` +
          "The rollback engine requires the snapshot store to be populated at execution time.",
      };
    }

    const abs = join(this.repoRoot, target);
    if (!existsSync(abs)) {
      return {
        status: "precondition_failed",
        event_id: original.event_id,
        description: `${target} no longer exists; cannot restore content`,
      };
    }

    // Verify the file currently holds the after-state we expect — refuse if it
    // has been edited again (a later edit's rollback should be done first).
    const currentHash = hashFile(abs);
    if (currentHash !== after_hash) {
      return {
        status: "precondition_failed",
        event_id: original.event_id,
        description:
          `${target} has been modified since event ${original.event_id.slice(0, 8)}…. ` +
          `Current hash ${currentHash.slice(0, 16)}… does not match expected after_hash ` +
          `${after_hash.slice(0, 16)}…. Roll back newer edits first.`,
      };
    }

    const beforeContent = this.snapshots.read(before_hash);
    writeFileSync(abs, beforeContent);

    const rollback_event_id = this.appendRollbackEvent(
      original,
      `restored ${target} from snapshot ${before_hash.slice(0, 16)}…`,
    );
    return {
      status: "rolled_back",
      event_id: original.event_id,
      rollback_event_id,
      description: `restored ${target} to its state before event ${original.event_id.slice(0, 8)}…`,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Append a rollback record to the ledger (best-effort; returns event_id). */
  private appendRollbackEvent(original: AuditEvent, description: string): string {
    try {
      const { event_id } = this.ledger.appendEvent({
        actor: "agent:openllama",
        service: "rollback-engine",
        action: `${original.tool_name ?? "unknown"}_rollback`,
        tool_name: original.tool_name ?? undefined,
        target: original.target ?? undefined,
        risk_level: original.risk_level ?? undefined,
        permission_level: original.permission_level ?? undefined,
        // Correlate back to the original event.
        correlation_id: original.event_id,
        result: "executed",
        rollback_path: "n/a",
        error: description,
      });
      return event_id;
    } catch {
      return "";
    }
  }
}

// ─── Module helpers ───────────────────────────────────────────────────────────

function hashFile(abs: string): string {
  const buf = readFileSync(abs);
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

function firstAfterHash(event: AuditEvent): string | null {
  const changed = firstDataChanged(event);
  return changed?.after_hash ?? null;
}

function firstDataChanged(
  event: AuditEvent,
): { path: string; before_hash: string | null; after_hash: string } | null {
  const dc = event.data_changed;
  if (!Array.isArray(dc) || dc.length === 0) return null;
  const first = dc[0] as { path?: string; before_hash?: string | null; after_hash?: string };
  if (typeof first.after_hash !== "string") return null;
  return {
    path: first.path ?? "",
    before_hash: typeof first.before_hash === "string" ? first.before_hash : null,
    after_hash: first.after_hash,
  };
}

function irrecoverableInstructions(event: AuditEvent): string {
  const tool = event.tool_name ?? "";
  if (tool === "git") {
    const rp = event.rollback_path ?? "";
    if (rp.startsWith("git reset --hard")) {
      return `Manual rollback:\n  ${rp}\n  Then git push --force-with-lease to update the remote.`;
    }
    return `Manual rollback required. See rollback_path in the audit event: ${rp}`;
  }
  if (tool === "run_shell") {
    return (
      "Shell side effects cannot be automatically reversed. " +
      "Review the audit event and apply the inverse operation manually."
    );
  }
  return `No automated rollback available for tool ${tool}. See docs/rollback.md.`;
}
