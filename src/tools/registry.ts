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

// ─── Registry ─────────────────────────────────────────────────────────────────

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.descriptor.name)) {
      throw new Error(`tool already registered: ${tool.descriptor.name}`);
    }
    this.tools.set(tool.descriptor.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
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
