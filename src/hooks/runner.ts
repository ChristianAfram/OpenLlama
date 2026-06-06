/**
 * Hook runner — executes lifecycle hooks as subprocesses.
 *
 * Governance invariants (TIGHTEN-ONLY):
 *   1. A pre_tool hook can only BLOCK. A hook returning "allow" (or no objection)
 *      never grants permission — the kernel's own gates still apply in full.
 *   2. Hook stdout is UNTRUSTED. This module returns it verbatim; the engine
 *      fences it via fenceUntrusted before it can enter the model context.
 *   3. Every hook execution is audited (action="hook_execution"). A hook that
 *      blocks a tool is recorded with the tool it blocked and the reason.
 *   4. Hooks run with no shell (args array), a hard timeout, and the lifecycle
 *      payload on stdin as JSON. A timeout or spawn failure is treated as a
 *      blocking error for pre_tool (fail-closed) and a logged no-op otherwise.
 *
 * Block protocol (pre_tool):
 *   - exit code != 0  → block (reason = stdout JSON reason, else stderr/stdout)
 *   - exit code == 0 + stdout JSON {"decision":"block","reason":"..."} → block
 *   - otherwise → allow (no objection)
 */

import { spawnSync } from "node:child_process";
import type { AuditSink } from "../tools/registry.js";
import { globMatch } from "../lib/glob-match.js";
import type {
  HookDefinition,
  HookEvent,
  HookPayload,
  HookResult,
  HookRunOutcome,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_OUTPUT_CHARS = 10_000;

export class HookRunner {
  constructor(
    private readonly hooks: HookDefinition[],
    private readonly ledger?: AuditSink,
  ) {}

  /** True if any hook is registered for the given event (lets the engine skip work). */
  hasHooks(event: HookEvent): boolean {
    return this.hooks.some((h) => h.event === event);
  }

  /**
   * Run all hooks matching an event (and, for tool events, the tool name).
   * Returns the aggregate outcome. For pre_tool, a single block → blocked=true.
   */
  run(event: HookEvent, payload: HookPayload): HookRunOutcome {
    const matching = this.hooks.filter(
      (h) => h.event === event && this.matches(h, payload.tool_name),
    );

    const results: HookResult[] = [];
    let blocked = false;
    let blockReason = "";
    let blockedBy = "";

    for (const hook of matching) {
      const result = this.runOne(hook, payload);
      results.push(result);
      this.audit(result, payload);

      // Tighten-only: only pre_tool blocks have force, and the first block wins.
      if (event === "pre_tool" && result.decision === "block" && !blocked) {
        blocked = true;
        blockReason = result.reason || `blocked by hook "${result.hook_name}"`;
        blockedBy = result.hook_name;
      }
    }

    return { blocked, blockReason, blockedBy, results };
  }

  private matches(hook: HookDefinition, toolName?: string): boolean {
    // Lifecycle (non-tool) events ignore the matcher.
    if (hook.event === "session_start" || hook.event === "session_end") return true;
    if (!hook.matcher) return true; // no matcher = matches every tool
    if (!toolName) return false;
    return globMatch(hook.matcher, toolName);
  }

  private runOne(hook: HookDefinition, payload: HookPayload): HookResult {
    const name = hook.name ?? hook.command;
    const timeout = hook.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let proc;
    try {
      proc = spawnSync(hook.command, hook.args ?? [], {
        input: JSON.stringify(payload),
        timeout,
        encoding: "utf-8",
        shell: false,
        maxBuffer: 1024 * 1024,
      });
    } catch (err) {
      // Spawn failure: fail-closed for pre_tool (block), logged no-op otherwise.
      return {
        hook_name: name,
        event: hook.event,
        decision: hook.event === "pre_tool" ? "block" : "allow",
        reason: `hook failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
        output: "",
        exit_code: null,
        errored: true,
      };
    }

    // Timeout (proc.error set, signal SIGTERM) → fail-closed for pre_tool.
    if (proc.error) {
      return {
        hook_name: name,
        event: hook.event,
        decision: hook.event === "pre_tool" ? "block" : "allow",
        reason: `hook error: ${proc.error.message}`,
        output: "",
        exit_code: null,
        errored: true,
      };
    }

    const stdout = truncate(proc.stdout ?? "", MAX_OUTPUT_CHARS);
    const stderr = truncate(proc.stderr ?? "", MAX_OUTPUT_CHARS);
    const exitCode = proc.status;

    // Determine decision per the block protocol.
    let decision: "allow" | "block" = "allow";
    let reason = "";

    const parsed = tryParseDecision(stdout);
    if (exitCode !== 0) {
      decision = "block";
      reason = parsed?.reason || stderr || stdout || `hook exited with code ${String(exitCode)}`;
    } else if (parsed?.decision === "block") {
      decision = "block";
      reason = parsed.reason || "hook requested block";
    }

    return {
      hook_name: name,
      event: hook.event,
      decision,
      reason,
      output: stdout,
      exit_code: exitCode,
      errored: false,
    };
  }

  private audit(result: HookResult, payload: HookPayload): void {
    if (!this.ledger) return;
    try {
      this.ledger.appendEvent({
        actor: "hook-runner",
        service: "hook-runner",
        action: "hook_execution",
        risk_level: result.decision === "block" ? "medium" : "low",
        permission_level: 0,
        input_source: "external",
        target: payload.tool_name ? `tool:${payload.tool_name}` : `event:${result.event}`,
        session_id: payload.session_id,
        correlation_id: payload.correlation_id,
        result: result.errored ? "failed" : "executed",
        ...(result.decision === "block"
          ? { policy_decision: "DENY" as const, policy_reason: `hook "${result.hook_name}": ${result.reason}` }
          : {}),
        ...(result.errored ? { error: result.reason } : {}),
      });
    } catch {
      // Audit of a hook run is best-effort; a hook never bypasses the kernel's
      // own no-audit-no-action gate (that gate lives in the executor, not here).
    }
  }
}

interface ParsedDecision {
  decision?: "allow" | "block";
  reason?: string;
}

function tryParseDecision(stdout: string): ParsedDecision | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const out: ParsedDecision = {};
    if (obj.decision === "allow" || obj.decision === "block") out.decision = obj.decision;
    if (typeof obj.reason === "string") out.reason = obj.reason;
    return out;
  } catch {
    return null;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…[truncated]" : s;
}
