/**
 * Tool registry: descriptors, the Tool interface, and the dispatcher.
 *
 * Each tool declares the full descriptor from Master Plan §7 / framework §14
 * (permission level, path allow/deny lists, approval + audit flags, rate limit,
 * rollback). In Prompt 2 only read-only (L0) and draft (L1) tools exist, so the
 * dispatcher does NOT gate execution — but it DOES validate args with zod and
 * write an audit event for every dispatch (L0/L1 actions are logged, not gated).
 * The gating executor for mutating tools arrives in Prompt 3.
 */

import type { ZodType } from "zod";
import { z } from "zod";
import type {
  AppendInput,
  PermissionLevel,
  RiskLevel,
} from "../kernel/audit.js";
import { getDefaultLedger, type AuditLedger } from "../kernel/audit.js";

// ─── Descriptor ───────────────────────────────────────────────────────────────

export interface ToolDescriptor {
  name: string;
  /** One-line description shown to the model. */
  description: string;
  permission_level: PermissionLevel;
  /** Risk used for the audit event (read/draft tools are low). */
  risk_level: RiskLevel;
  allowed_paths: string[];
  denied_paths: string[];
  requires_approval: boolean;
  audit_required: boolean;
  rate_limit: string;
  rollback: string;
}

// ─── Tool ─────────────────────────────────────────────────────────────────────

export interface ToolContext {
  /** Repository root all path-bound tools are confined to. */
  repoRoot: string;
}

export interface ToolResult {
  ok: boolean;
  /** Text fed back to the model (already safe to show — never raw secrets). */
  output: string;
  /** Optional structured payload for callers/tests. */
  data?: unknown;
  /** Audit fields the tool wants recorded (target, data_read, etc.). */
  audit?: Partial<AppendInput>;
}

export interface Tool<TArgs = unknown> {
  descriptor: ToolDescriptor;
  schema: ZodType<TArgs>;
  execute(args: TArgs, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}

// ─── Mutating tools ─────────────────────────────────────────────────────────────

/**
 * How a mutation can be reversed (Prompt 10 / Master Plan §13, framework §49).
 *
 * `restore_file` carries the prior bytes so the executor can capture them in the
 * snapshot store before applying — making `edit_file` reversible. `irreversible`
 * names *why* (e.g. shell side effects, a remote push) so the rollback engine can
 * refuse honestly rather than pretend.
 */
export type ReversalPlan =
  | { kind: "delete_created_file"; path: string }
  | {
      kind: "restore_file";
      path: string;
      before_content: string;
      before_hash: string;
      after_hash: string;
    }
  | { kind: "irreversible"; reason: string };

/**
 * A planned mutation: everything needed to audit a mutation, computed WITHOUT
 * performing any side effect. The executor records this to the ledger first and
 * only then calls `apply()`.
 */
export interface PlannedMutation {
  /** The resource being changed (repo-relative path or similar). */
  target: string;
  /** Per-path before/after blob hashes (before = null for a newly created file). */
  data_changed: { path: string; before_hash: string | null; after_hash: string }[];
  /** How to undo this mutation. */
  rollback_path: string;
  /** Human-facing summary fed back to the model on success. */
  summary: string;
  /**
   * How this mutation can be reversed by the rollback engine. Optional for
   * backward compatibility; tools that omit it are treated as irreversible.
   */
  reversal?: ReversalPlan;
  /**
   * The actual side effect. Called by the executor ONLY after the audit write is
   * confirmed. If it returns a string, that string replaces `summary` in the
   * outcome — used by tools (run_shell, git) whose useful result is only known
   * after the side effect runs.
   */
  apply: () => void | string | Promise<void | string>;
}

/**
 * A mutating tool computes a PlannedMutation but never touches the world itself —
 * the executor performs the side effect, after the audit write succeeds. This is
 * the structural enforcement of the no-audit-no-action invariant.
 */
export interface MutatingTool<TArgs = unknown> {
  descriptor: ToolDescriptor;
  schema: ZodType<TArgs>;
  plan(args: TArgs, ctx: ToolContext): PlannedMutation | Promise<PlannedMutation>;
}

export type AnyTool = Tool | MutatingTool;

export function isMutatingTool(tool: AnyTool): tool is MutatingTool {
  return "plan" in tool;
}

/**
 * The narrow audit interface the executor depends on. AuditLedger satisfies it;
 * tests can substitute a sink whose appendEvent throws to prove the invariant.
 */
export interface AuditSink {
  appendEvent(input: AppendInput): { event_id: string; seq: number; hash: string };
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  register(tool: AnyTool): void {
    if (this.tools.has(tool.descriptor.name)) {
      throw new Error(`tool already registered: ${tool.descriptor.name}`);
    }
    this.tools.set(tool.descriptor.name, tool);
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  list(): AnyTool[] {
    return [...this.tools.values()];
  }
}

// ─── Dispatch result ──────────────────────────────────────────────────────────

export type DispatchOutcome =
  | { status: "ok"; result: ToolResult; event_id: string }
  | { status: "invalid_args"; error: string; event_id: string }
  | { status: "unknown_tool"; error: string }
  | { status: "error"; error: string; event_id: string };

export interface DispatchOptions {
  ledger?: AuditLedger;
  ctx: ToolContext;
  session_id?: string;
  correlation_id?: string;
  model?: string;
  prompt_version?: string;
}

/**
 * Validate args, write an audit event, and (for read/draft tools) execute.
 *
 * Invalid args are rejected and logged — never executed. Every dispatch
 * produces exactly one audit event. This is the Prompt 2 read/draft path; the
 * Prompt 3 executor will layer classification + gating on top for mutations.
 */
export async function dispatchTool(
  registry: ToolRegistry,
  name: string,
  rawArgs: unknown,
  opts: DispatchOptions,
): Promise<DispatchOutcome> {
  const tool = registry.get(name);
  if (!tool) {
    // Unknown tool: nothing to attribute an audit event to a descriptor, but
    // we still record the attempt so the timeline is complete.
    return { status: "unknown_tool", error: `unknown tool: ${name}` };
  }
  if (isMutatingTool(tool)) {
    // Mutating tools must go through the executor (no-audit-no-action gating),
    // never the read/draft dispatcher. The engine routes these; this is a guard.
    return {
      status: "error",
      error: `tool "${name}" is a mutating tool and must run through the executor`,
      event_id: "",
    };
  }

  const ledger = opts.ledger ?? getDefaultLedger();
  const base: AppendInput = {
    actor: "agent:openllama",
    service: "tool-dispatcher",
    action: name,
    tool_name: name,
    risk_level: tool.descriptor.risk_level,
    permission_level: tool.descriptor.permission_level,
    input_source: "user",
    ...(opts.session_id ? { session_id: opts.session_id } : {}),
    ...(opts.correlation_id ? { correlation_id: opts.correlation_id } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.prompt_version ? { prompt_version: opts.prompt_version } : {}),
  };

  // 1. Validate args.
  const parsed = tool.schema.safeParse(rawArgs);
  if (!parsed.success) {
    const error = formatZodError(parsed.error);
    const { event_id } = ledger.appendEvent({
      ...base,
      result: "blocked",
      error: `invalid tool args: ${error}`,
    });
    return { status: "invalid_args", error, event_id };
  }

  // 2. Execute (read/draft tools only at this milestone).
  try {
    const result = await tool.execute(parsed.data, opts.ctx);
    const { event_id } = ledger.appendEvent({
      ...base,
      ...result.audit,
      result: result.ok ? "executed" : "failed",
      ...(result.ok ? {} : { error: truncate(result.output, 500) }),
    });
    return { status: "ok", result, event_id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const { event_id } = ledger.appendEvent({
      ...base,
      result: "failed",
      error: truncate(message, 500),
    });
    return { status: "error", error: message, event_id };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
