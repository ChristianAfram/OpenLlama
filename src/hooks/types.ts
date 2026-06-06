/**
 * Hook system types (v0.8 — B5 Extensibility).
 *
 * Hooks are user/project-declared subprocesses that fire at lifecycle points.
 * The governance model is TIGHTEN-ONLY: a hook can BLOCK a tool the kernel
 * would otherwise allow, but it can NEVER permit a tool the kernel blocks,
 * approve an action, or modify an audit record. Hook stdout is UNTRUSTED
 * external content — it is fenced before ever entering the model context and
 * is never interpreted as an instruction.
 *
 * This mirrors the config-scopes rule: external/project-supplied configuration
 * may only add restrictions, never remove them.
 */

/** Lifecycle points at which hooks fire. */
export type HookEvent = "session_start" | "pre_tool" | "post_tool" | "session_end";

/** A hook's decision. Only "block" has force; "allow" is a no-op (no objection). */
export type HookDecision = "allow" | "block";

/** A single hook declaration from config. */
export interface HookDefinition {
  /** Which lifecycle event this hook fires on. */
  event: HookEvent;
  /** Executable to run (no shell — args are passed as an array). */
  command: string;
  /** Fixed arguments passed to the command. */
  args?: string[];
  /**
   * For pre_tool / post_tool hooks: a glob matched against the tool name.
   * Absent matcher = matches every tool. e.g. "write_file", "mcp:*", "git".
   */
  matcher?: string;
  /** Per-hook timeout in milliseconds (default 5000). */
  timeoutMs?: number;
  /** Human-readable name for audit/logs. Defaults to the command. */
  name?: string;
}

/** The payload handed to a hook on stdin (as JSON). */
export interface HookPayload {
  event: HookEvent;
  session_id: string;
  correlation_id: string;
  /** For pre_tool / post_tool: the tool being called. */
  tool_name?: string;
  /** For pre_tool: the (schema-unvalidated) arguments the model proposed. */
  tool_args?: unknown;
  /** For post_tool: the tool's feedback string (already produced). */
  tool_result?: string;
  cwd: string;
}

/** The result of running a single hook. */
export interface HookResult {
  hook_name: string;
  event: HookEvent;
  decision: HookDecision;
  /** Reason for a block (from stdout JSON or stderr). Empty when allowed. */
  reason: string;
  /** Raw stdout — UNTRUSTED. Callers MUST fence this before context entry. */
  output: string;
  exit_code: number | null;
  /** True if the hook timed out or failed to spawn. */
  errored: boolean;
}

/** Aggregate decision across all hooks that fired for an event. */
export interface HookRunOutcome {
  /** True if ANY pre_tool hook blocked (tighten-only: one block = blocked). */
  blocked: boolean;
  /** Reason from the first blocking hook. */
  blockReason: string;
  /** Name of the first blocking hook. */
  blockedBy: string;
  /** All individual hook results, in run order. */
  results: HookResult[];
}
