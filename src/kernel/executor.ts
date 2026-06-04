/**
 * The tool executor — the ONLY component that touches the world.
 *
 * The defining invariant of OpenLlama lives here:
 *
 *     A mutating action runs only after its audit write is confirmed.
 *     If the audit write fails, NO side effect is performed.
 *
 * There is no flag, mode, or fast path around this. Every mutating tool is a
 * `MutatingTool` whose `plan()` computes the change (and its before/after blob
 * hashes) WITHOUT side effects; the executor then:
 *
 *   1. validates args (zod)            — invalid → logged "blocked", no effect
 *   2. plans the mutation              — refusal (e.g. overwrite) → "blocked"
 *   3. classifies it (stub; P4 full)
 *   4. APPENDS THE AUDIT EVENT         — if this throws, we stop here, no effect
 *   5. applies the side effect         — only now does the world change
 *   6. (on apply failure) logs "failed"
 *
 * Because step 4 is a hard gate before step 5, a crash or an audit-subsystem
 * outage can never produce an unlogged mutation.
 */

import { z } from "zod";
import type { AppendInput, RiskLevel, PermissionLevel } from "./audit.js";
import { getDefaultLedger } from "./audit.js";
import type { AuditSink, MutatingTool, ToolContext } from "../tools/registry.js";

export class ExecutorError extends Error {
  override name = "ExecutorError";
}

export type ExecuteOutcome =
  | { status: "executed"; event_id: string; summary: string; rollback_path: string }
  | { status: "blocked"; event_id: string; reason: string }
  | { status: "audit_failed"; reason: string }
  | { status: "apply_failed"; event_id: string; reason: string };

export interface ExecuteOptions {
  ledger?: AuditSink;
  ctx: ToolContext;
  session_id?: string;
  correlation_id?: string;
  model?: string;
  prompt_version?: string;
}

/** Minimal stub classifier — replaced by the deterministic classifier in Prompt 4. */
function classifyStub(tool: MutatingTool): { risk: RiskLevel; level: PermissionLevel } {
  return { risk: tool.descriptor.risk_level, level: tool.descriptor.permission_level };
}

export class Executor {
  constructor(private readonly defaultLedger?: AuditSink) {}

  private ledger(opts: ExecuteOptions): AuditSink {
    return opts.ledger ?? this.defaultLedger ?? getDefaultLedger();
  }

  /**
   * Execute a mutating tool under the no-audit-no-action invariant.
   */
  async execute(
    tool: MutatingTool,
    rawArgs: unknown,
    opts: ExecuteOptions,
  ): Promise<ExecuteOutcome> {
    const ledger = this.ledger(opts);
    const { risk, level } = classifyStub(tool);

    const base: AppendInput = {
      actor: "agent:openllama",
      service: "tool-executor",
      action: tool.descriptor.name,
      tool_name: tool.descriptor.name,
      risk_level: risk,
      permission_level: level,
      input_source: "user",
      ...(opts.session_id ? { session_id: opts.session_id } : {}),
      ...(opts.correlation_id ? { correlation_id: opts.correlation_id } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.prompt_version ? { prompt_version: opts.prompt_version } : {}),
    };

    // 1. Validate args. Invalid → logged blocked, never planned or applied.
    const parsed = tool.schema.safeParse(rawArgs);
    if (!parsed.success) {
      const reason = `invalid tool args: ${formatZodError(parsed.error)}`;
      const event_id = this.tryLogBlocked(ledger, base, reason);
      return { status: "blocked", event_id, reason };
    }

    // 2. Plan the mutation (NO side effect). A refusal throws here.
    let planned;
    try {
      planned = await tool.plan(parsed.data, opts.ctx);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const event_id = this.tryLogBlocked(ledger, base, reason);
      return { status: "blocked", event_id, reason };
    }

    // 3 + 4. Audit the (about-to-happen) mutation. THIS IS THE GATE.
    //
    // The event is recorded as "executed" because, once it is durably written,
    // the executor is committed to applying it. If appendEvent throws (the audit
    // subsystem is unavailable), we abort with NO side effect — the invariant.
    let event_id: string;
    try {
      ({ event_id } = ledger.appendEvent({
        ...base,
        target: planned.target,
        data_changed: planned.data_changed,
        rollback_path: planned.rollback_path,
        result: "executed",
      }));
    } catch (err) {
      const reason = `audit write failed; side effect NOT performed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      return { status: "audit_failed", reason };
    }

    // 5. Apply the side effect — only now does the world change.
    try {
      await planned.apply();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // 6. Best-effort compensating record of the post-audit failure.
      this.tryLogFailed(ledger, base, planned.target, reason);
      return { status: "apply_failed", event_id, reason };
    }

    return {
      status: "executed",
      event_id,
      summary: planned.summary,
      rollback_path: planned.rollback_path,
    };
  }

  private tryLogBlocked(ledger: AuditSink, base: AppendInput, reason: string): string {
    try {
      return ledger.appendEvent({ ...base, result: "blocked", error: reason }).event_id;
    } catch {
      return "";
    }
  }

  private tryLogFailed(
    ledger: AuditSink,
    base: AppendInput,
    target: string,
    reason: string,
  ): void {
    try {
      ledger.appendEvent({
        ...base,
        action: `${base.action}_apply_failed`,
        target,
        result: "failed",
        error: reason,
      });
    } catch {
      // The compensating log is best-effort; the mutation already occurred or not.
    }
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
