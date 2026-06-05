/**
 * In-memory AuditSink for tests — records events without touching disk.
 */

import { randomUUID } from "node:crypto";
import type { AuditSink } from "../../src/tools/registry.js";
import type { AppendInput } from "../../src/kernel/audit.js";

export interface StoredEvent {
  event_id: string;
  input: AppendInput;
}

export class InMemoryAuditSink implements AuditSink {
  readonly events: StoredEvent[] = [];
  private seq = 0;

  appendEvent(input: AppendInput): { event_id: string; seq: number; hash: string } {
    const event_id = randomUUID();
    this.seq++;
    this.events.push({ event_id, input });
    return { event_id, seq: this.seq, hash: `hash-${String(this.seq)}` };
  }
}
