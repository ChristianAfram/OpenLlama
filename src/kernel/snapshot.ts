/**
 * Snapshot store — content-addressed before-state for reversible mutations.
 *
 * The audit ledger records only *hashes* of changed content, never the content
 * itself (secrets must never be written in the clear — Master Plan §9, §17). So
 * to reverse a content mutation (e.g. `edit_file`) the executor must capture the
 * file's prior bytes somewhere recoverable. That is this store.
 *
 * It is a plain content-addressed blob store: a blob is written under a filename
 * equal to its SHA-256, so the key is exactly the `before_hash` already recorded
 * in the audit event's `data_changed`. The rollback engine reads the blob back
 * by that hash. The store lives alongside the ledger on the operator's machine
 * and is NEVER part of the SIEM/OTel export.
 *
 * Note on secrets: secret paths (.env, secrets/, …) are denied at the tool layer
 * and never reach a reversible mutation, so snapshots only ever hold ordinary
 * source content. The store is still treated as local-only and non-exported.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HASH_PREFIX = "sha256:";

export class SnapshotStore {
  constructor(private readonly dir: string) {}

  /** Resolve a `sha256:<hex>` (or bare hex) ref to its on-disk path. */
  private file(ref: string): string {
    const hex = ref.startsWith(HASH_PREFIX) ? ref.slice(HASH_PREFIX.length) : ref;
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      throw new Error(`invalid snapshot ref: ${ref}`);
    }
    return join(this.dir, hex);
  }

  /**
   * Store a blob and return its `sha256:<hex>` ref. Content-addressed and
   * idempotent: an identical blob is written at most once.
   */
  put(content: string | Buffer): string {
    const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const hex = createHash("sha256").update(buf).digest("hex");
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, hex);
    if (!existsSync(path)) {
      writeFileSync(path, buf);
    }
    return `${HASH_PREFIX}${hex}`;
  }

  /** Whether a blob for this ref exists. */
  has(ref: string): boolean {
    try {
      return existsSync(this.file(ref));
    } catch {
      return false;
    }
  }

  /** Read a blob back; throws if it is not present. */
  read(ref: string): Buffer {
    const path = this.file(ref);
    if (!existsSync(path)) {
      throw new Error(`snapshot not found for ref: ${ref}`);
    }
    return readFileSync(path);
  }
}

// ─── Default store ──────────────────────────────────────────────────────────────

export function defaultSnapshotDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(base, "openllama", "snapshots");
}

let _default: SnapshotStore | undefined;

export function getDefaultSnapshotStore(
  env: NodeJS.ProcessEnv = process.env,
): SnapshotStore {
  if (!_default) {
    _default = new SnapshotStore(defaultSnapshotDir(env));
  }
  return _default;
}

/** Reset the module-level singleton — test helper only. */
export function _resetDefaultSnapshotStore(): void {
  _default = undefined;
}
