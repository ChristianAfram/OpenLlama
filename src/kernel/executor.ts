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
 *   2b. enforces descriptor denylist   — denied path → "blocked"
 *   3. classifies it (deterministic classifier, Prompt 4)
 *   3b. approval gate (Prompt 5)       — L4/L5 need a scoped grant (+ L5 phrase);
 *                                         no/denied/invalid grant → "blocked"
 *   4. APPENDS THE AUDIT EVENT         — if this throws, we stop here, no effect
 *   5. applies the side effect         — only now does the world change
 *   6. (on apply failure) logs "failed"
 *
 * Because step 4 is a hard gate before step 5, a crash or an audit-subsystem
 * outage can never produce an unlogged mutation.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppendInput } from "./audit.js";
import { getDefaultLedger } from "./audit.js";
import type { AuditSink, MutatingTool, ToolContext } from "../tools/registry.js";
import { classify, levelToRisk } from "./classifier.js";
import { globMatch } from "../lib/glob-match.js";
import {
  verifyGrant,
  type ApprovalProvider,
  type ApprovalRequest,
} from "./approval.js";

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
  /**
   * Channel for obtaining approval for Level 4/5 actions. The engine supplies
   * none (the agent cannot approve itself), so agent-driven L4/L5 stays blocked;
   * a human-driven CLI supplies an interactive provider.
   */
  approvals?: ApprovalProvider;
  /** Who is requesting the action (recorded in the approval request). */
  requested_by?: string;
}

// (classifyStub removed — Prompt 4 wires in the real deterministic classifier)

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

    // Every execution has a concrete session id: approval grants are bound to a
    // session, so an absent one would make every grant un-matchable. Generate
    // one when the caller doesn't supply it.
    const sessionId = opts.session_id ?? randomUUID();

    // The base audit fields carry the descriptor defaults; they are upgraded
    // after classification when the classifier raises the level.
    const base: AppendInput = {
      actor: "agent:openllama",
      service: "tool-executor",
      action: tool.descriptor.name,
      tool_name: tool.descriptor.name,
      risk_level: tool.descriptor.risk_level,
      permission_level: tool.descriptor.permission_level,
      input_source: "user",
      session_id: sessionId,
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

    // 2b. Enforce descriptor-level path denylist (independent of the tool's own
    //     path checks — defense in depth). If the planned target matches any
    //     denied_paths glob, block here before classification.
    if (planned.target !== undefined) {
      const deniedPattern = tool.descriptor.denied_paths.find((pat) =>
        globMatch(pat, planned.target!),
      );
      if (deniedPattern !== undefined) {
        const reason = `target "${planned.target}" matches tool's denied path: ${deniedPattern}`;
        const event_id = this.tryLogBlocked(ledger, base, reason);
        return { status: "blocked", event_id, reason };
      }
    }

    // 3. Classify the action deterministically.
    //    The classifier may raise the level; it never lowers it.
    const parsedArgs = parsed.data as Record<string, unknown>;
    const classification = classify({
      descriptor_level: tool.descriptor.permission_level,
      descriptor_requires_approval: tool.descriptor.requires_approval,
      target: planned.target,
      content: typeof parsedArgs["content"] === "string" ? parsedArgs["content"] : undefined,
      // git tools name the branch "branch"; accept either spelling so a push to
      // a protected branch (main, release/*, …) escalates to L5 via the classifier.
      git_branch:
        typeof parsedArgs["git_branch"] === "string"
          ? parsedArgs["git_branch"]
          : typeof parsedArgs["branch"] === "string"
            ? (parsedArgs["branch"] as string)
            : undefined,
      command: typeof parsedArgs["command"] === "string" ? parsedArgs["command"] : undefined,
    });

    // Rebuild audit base with the classified (possibly raised) level/risk.
    const auditBase: AppendInput = {
      ...base,
      permission_level: classification.level,
      risk_level: levelToRisk(classification.level),
      ...(classification.rule_id !== "DESCRIPTOR_DEFAULT"
        ? { policy_reason: classification.reason }
        : {}),
    };

    // 3b. The approval gate. Levels 4/5 may only proceed with a scoped, expiring
    //     grant (L5 also requires a manual confirmation phrase). The grant comes
    //     from an injected provider — never from the agent itself. Levels 0–3
    //     skip this entirely.
    let approvalFields: Partial<AppendInput> = {};
    if (classification.level >= 4) {
      const gate = await this.runApprovalGate(
        ledger,
        auditBase,
        opts,
        tool,
        planned,
        classification.level,
      );
      if (gate.status === "blocked") return gate;
      approvalFields = gate.fields;
    }

    // 4. Audit the (about-to-happen) mutation. THIS IS THE GATE.
    //
    // The event is recorded as "executed" because, once it is durably written,
    // the executor is committed to applying it. If appendEvent throws (the audit
    // subsystem is unavailable), we abort with NO side effect — the invariant.
    let event_id: string;
    try {
      ({ event_id } = ledger.appendEvent({
        ...auditBase,
        ...approvalFields,
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
    let applyResult: void | string;
    try {
      applyResult = await planned.apply();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // 6. Best-effort compensating record of the post-audit failure.
      this.tryLogFailed(ledger, auditBase, planned.target, reason);
      return { status: "apply_failed", event_id, reason };
    }

    return {
      status: "executed",
      event_id,
      summary: typeof applyResult === "string" ? applyResult : planned.summary,
      rollback_path: planned.rollback_path,
    };
  }

  /**
   * Run the L4/L5 approval gate. Returns either a `blocked` outcome (no grant,
   * denied, or a grant that fails verification) or the audit fields to attach to
   * the executed event (approval_id + policy_decision).
   */
  private async runApprovalGate(
    ledger: AuditSink,
    auditBase: AppendInput,
    opts: ExecuteOptions,
    tool: MutatingTool,
    planned: { target?: string; data_changed: AppendInput["data_changed"]; rollback_path: string; summary: string },
    level: number,
  ): Promise<
    | { status: "blocked"; event_id: string; reason: string }
    | { status: "ok"; fields: Partial<AppendInput> }
  > {
    const requiresConfirmation = level >= 5;
    const decisionField = requiresConfirmation ? "REQUIRE_CONFIRMATION" : "REQUIRE_APPROVAL";

    const provider = opts.approvals;
    if (!provider) {
      // No approval channel (e.g. the agent loop) → block. The agent can never
      // approve its own L4/L5 action.
      const reason = `level ${String(level)} action requires ${
        requiresConfirmation ? "manual confirmation" : "approval"
      } but no approval channel is available`;
      const event_id = this.tryLogBlocked(
        ledger,
        { ...auditBase, policy_decision: decisionField },
        reason,
      );
      return { status: "blocked", event_id, reason };
    }

    const req: ApprovalRequest = {
      action_id: randomUUID(),
      tool_name: tool.descriptor.name,
      permission_level: level as ApprovalRequest["permission_level"],
      risk_level: levelToRisk(level as ApprovalRequest["permission_level"]),
      ...(planned.target !== undefined ? { target: planned.target } : {}),
      summary: planned.summary,
      data_changed: (planned.data_changed ?? []) as ApprovalRequest["data_changed"],
      rollback_path: planned.rollback_path,
      reason: auditBase.policy_reason ?? "elevated risk",
      ...(auditBase.session_id ? { session_id: auditBase.session_id } : {}),
      requested_by: opts.requested_by ?? auditBase.actor ?? "agent:openllama",
    };

    let decision;
    try {
      decision = await provider.requestApproval(req);
    } catch (err) {
      const reason = `approval channel error: ${err instanceof Error ? err.message : String(err)}`;
      const event_id = this.tryLogBlocked(
        ledger,
        { ...auditBase, policy_decision: decisionField },
        reason,
      );
      return { status: "blocked", event_id, reason };
    }

    if (decision.status === "denied") {
      const reason = `approval denied: ${decision.reason}`;
      const event_id = this.tryLogBlocked(
        ledger,
        { ...auditBase, policy_decision: "DENY" },
        reason,
      );
      return { status: "blocked", event_id, reason };
    }

    // A grant was returned — verify it covers this exact action.
    const verdict = verifyGrant(decision.grant, req, new Date());
    if (!verdict.ok) {
      const reason = `approval grant rejected (${verdict.rejection ?? "invalid"})${
        verdict.detail ? `: ${verdict.detail}` : ""
      }`;
      const event_id = this.tryLogBlocked(
        ledger,
        { ...auditBase, policy_decision: "DENY", approval_id: decision.grant.approval_id },
        reason,
      );
      return { status: "blocked", event_id, reason };
    }

    return {
      status: "ok",
      fields: { policy_decision: decisionField, approval_id: decision.grant.approval_id },
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
