/**
 * The reasoning engine: the agent loop.
 *
 * Sends context to the model, parses tool calls, dispatches them through the
 * tool dispatcher (which validates args + writes an audit event), feeds results
 * back, and repeats — up to a hard iteration cap. The engine produces
 * PROPOSALS only; it has no direct filesystem/shell/network access. All world
 * contact happens inside tools, behind the dispatcher (and, from Prompt 3, the
 * gating executor).
 *
 * Local-model robustness (Master Plan §22): when a tool call fails zod
 * validation, the schema error is fed back to the model and the step is retried
 * up to `repairAttempts` times before the engine gives up on that call. Invalid
 * args are never dispatched to a tool's execute().
 */

import { randomUUID } from "node:crypto";
import type { AuditLedger } from "../kernel/audit.js";
import { Executor } from "../kernel/executor.js";
import type { KillSwitch } from "../kernel/kill-switch.js";
import type { Verifier } from "../kernel/verifier.js";
import type { SnapshotStore } from "../kernel/snapshot.js";
import {
  dispatchTool,
  isMutatingTool,
  type MutatingTool,
  type ToolContext,
  type ToolRegistry,
} from "../tools/registry.js";
import type { ModelClient, ToolDefinition } from "./model-client.js";
import { ContextManager } from "./context-manager.js";
import { fenceUntrusted } from "./context.js";
import type { SessionStore } from "../sessions/store.js";
import { DEFAULT_CONTEXT_BUDGET } from "../lib/config-scopes.js";
import type { HookRunner } from "../hooks/runner.js";

export interface EngineOptions {
  registry: ToolRegistry;
  model: ModelClient;
  toolContext: ToolContext;
  ledger?: AuditLedger;
  /** Hard cap on reasoning iterations (default 25). */
  maxIterations?: number;
  /** Retries when a tool call fails zod validation (default 2). */
  repairAttempts?: number;
  /** Kill switch (Prompt 9). Passed to executor; also activated by triggers. */
  killSwitch?: KillSwitch;
  /** Independent verifier (Prompt 9). Passed to executor for H/C actions. */
  verifier?: Verifier;
  /**
   * Maximum consecutive mutations blocked (policy denied) before the kill
   * switch is activated automatically (default 5). Guards against a stuck or
   * compromised model flooding the pipeline with denied actions.
   */
  consecutiveDenialsLimit?: number;
  /**
   * Maximum total tokens across all model calls in a session. Activation of
   * the kill switch when breached guards against runaway cost.
   * (Token counts come from ModelTurn.usage when available.)
   */
  maxTotalTokens?: number;
  /** Model eval status — threaded to executor's PolicyInput. */
  model_eval_passed?: boolean;
  /**
   * Snapshot store (Prompt 10). When provided, the executor captures
   * before-content for reversible mutations so the rollback engine can undo them.
   */
  snapshots?: SnapshotStore;
  /**
   * Session store (v0.8). When provided, the run is persisted as a resumable
   * session: turns, token usage, and final status are recorded.
   */
  sessionStore?: SessionStore;
  /**
   * Resume an existing session: its transcript is rehydrated into the context
   * and the stored session_id + correlation_id are reused so the audit timeline
   * stays continuous. Requires `sessionStore`.
   */
  resumeSessionId?: string;
  /** Override the generated session id (used by resume + subagent orchestration). */
  sessionId?: string;
  /** Override the generated correlation id (shared across a subagent tree). */
  correlationId?: string;
  /**
   * Context token budget before compaction kicks in (v0.8 — A2).
   * Defaults to DEFAULT_CONTEXT_BUDGET (24 000 tokens ≈ 96 000 chars).
   */
  contextBudget?: number;
  /**
   * Compaction strategy when the budget is exceeded (v0.8 — A2).
   * "structural" (default): evict oldest fenced tool results.
   * "model": summarise the evicted span via a model call.
   */
  compaction?: "structural" | "model";
  /**
   * Lifecycle hook runner (v0.8 — B5). When provided, hooks fire at
   * session_start / pre_tool / post_tool / session_end. pre_tool hooks are
   * TIGHTEN-ONLY: they can block a tool but never permit one the kernel blocks.
   * Hook output is fenced as untrusted data before entering the context.
   */
  hooks?: HookRunner;
}

export interface EngineRunResult {
  answer: string;
  iterations: number;
  toolCalls: number;
  stopReason: "final_answer" | "iteration_cap" | "repair_exhausted" | "kill_switch";
}

export class ReasoningEngine {
  private readonly registry: ToolRegistry;
  private readonly model: ModelClient;
  private readonly toolContext: ToolContext;
  private readonly ledger?: AuditLedger;
  private readonly maxIterations: number;
  private readonly repairAttempts: number;
  private readonly toolDefs: ToolDefinition[];
  private readonly executor: Executor;
  private readonly defaultSessionId: string;
  private readonly killSwitch?: KillSwitch;
  private readonly verifier?: Verifier;
  private readonly consecutiveDenialsLimit: number;
  private readonly maxTotalTokens: number | undefined;
  private readonly modelEvalPassed: boolean | undefined;
  private readonly snapshots: SnapshotStore | undefined;
  private readonly sessionStore: SessionStore | undefined;
  private readonly resumeSessionId: string | undefined;
  private readonly overrideCorrelationId: string | undefined;
  private readonly contextBudget: number;
  private readonly compaction: "structural" | "model";
  private readonly hooks: HookRunner | undefined;

  constructor(opts: EngineOptions) {
    this.registry = opts.registry;
    this.model = opts.model;
    this.toolContext = opts.toolContext;
    this.ledger = opts.ledger;
    this.maxIterations = opts.maxIterations ?? 25;
    this.repairAttempts = opts.repairAttempts ?? 2;
    this.killSwitch = opts.killSwitch;
    this.verifier = opts.verifier;
    this.consecutiveDenialsLimit = opts.consecutiveDenialsLimit ?? 5;
    this.maxTotalTokens = opts.maxTotalTokens;
    this.modelEvalPassed = opts.model_eval_passed;
    this.snapshots = opts.snapshots;
    this.sessionStore = opts.sessionStore;
    this.resumeSessionId = opts.resumeSessionId;
    this.defaultSessionId = opts.sessionId ?? randomUUID();
    this.overrideCorrelationId = opts.correlationId;
    this.contextBudget = opts.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
    this.compaction = opts.compaction ?? "structural";
    this.hooks = opts.hooks;
    this.executor = new Executor(opts.ledger);
    this.toolDefs = this.registry
      .list()
      .map((t) => ({ descriptor: t.descriptor, schema: t.schema }));
  }

  /** Run the loop for a single user instruction. */
  async run(instruction: string): Promise<EngineRunResult> {
    // Kill switch pre-check: don't start a loop if the switch is already active.
    if (this.killSwitch?.isActive()) {
      const ks = this.killSwitch.getState();
      return {
        answer: `Aborted: kill switch is active (triggered_by: ${ks.triggered_by}): ${ks.reason}`,
        iterations: 0,
        toolCalls: 0,
        stopReason: "kill_switch",
      };
    }

    // Resolve the session identity. On resume we reuse the stored ids so the
    // audit timeline stays continuous; otherwise we mint a fresh correlation id.
    const store = this.sessionStore;
    const resumeMeta =
      this.resumeSessionId && store ? store.get(this.resumeSessionId) : null;
    const sessionId = resumeMeta?.session_id ?? this.defaultSessionId;
    const correlationId =
      resumeMeta?.correlation_id ?? this.overrideCorrelationId ?? randomUUID();

    // Build the context manager: rehydrate a resumed transcript, else start fresh.
    const cmOpts = {
      tokenBudget: this.contextBudget,
      compaction: this.compaction,
      ledger: this.ledger,
      modelClient: this.model,
    };
    let ctx: ContextManager;
    if (resumeMeta && store) {
      ctx = ContextManager.hydrate(store.getTurns(resumeMeta.session_id), cmOpts);
    } else {
      ctx = new ContextManager(cmOpts);
      // Register a new session row before recording any turns.
      store?.create({
        session_id: sessionId,
        correlation_id: correlationId,
        cwd: this.toolContext.repoRoot,
        model: this.model.model,
        prompt_version: ctx.promptVersion,
      });
    }
    ctx.addUser(instruction);
    store?.appendTurn(sessionId, { role: "user", content: instruction });

    // Fire session_start hooks (informational; cannot block a session).
    this.hooks?.run("session_start", {
      event: "session_start",
      session_id: sessionId,
      correlation_id: correlationId,
      cwd: this.toolContext.repoRoot,
    });

    let iterations = 0;
    let toolCalls = 0;
    // Consecutive invalid-argument failures. Reset on any valid dispatch. When
    // it exceeds repairAttempts, the model has failed to self-correct and we
    // abort rather than burn the full iteration budget.
    let consecutiveInvalidArgs = 0;
    // Consecutive mutations blocked by policy — triggers the kill switch when
    // it exceeds consecutiveDenialsLimit.
    let consecutiveDenials = 0;
    // Token usage across all model calls (from usage field when available).
    let inputTokens = 0;
    let outputTokens = 0;

    // Record final status to the session store, then return the result.
    const finalize = (result: EngineRunResult): EngineRunResult => {
      const status =
        result.stopReason === "final_answer"
          ? "completed"
          : result.stopReason === "kill_switch"
            ? "killed"
            : "aborted";
      store?.finish(sessionId, {
        status,
        stop_reason: result.stopReason,
        total_input_tokens: inputTokens,
        total_output_tokens: outputTokens,
      });
      // Fire session_end hooks (informational; the run is already complete).
      this.hooks?.run("session_end", {
        event: "session_end",
        session_id: sessionId,
        correlation_id: correlationId,
        cwd: this.toolContext.repoRoot,
      });
      return result;
    };

    while (iterations < this.maxIterations) {
      iterations++;
      await ctx.maybeCompact(sessionId, correlationId);
      const turn = await this.model.generate(ctx.toMessages(), this.toolDefs);

      // Track token usage for cost controls.
      if (turn.usage) {
        inputTokens += turn.usage.input_tokens ?? 0;
        outputTokens += turn.usage.output_tokens ?? 0;
        const totalTokens = inputTokens + outputTokens;
        if (this.maxTotalTokens !== undefined && totalTokens > this.maxTotalTokens) {
          const reason = `token cap exceeded: ${String(totalTokens)} > ${String(this.maxTotalTokens)}`;
          this.killSwitch?.activate(reason, "cost_cap");
          return finalize({
            answer: `Aborted: ${reason}. Kill switch activated.`,
            iterations,
            toolCalls,
            stopReason: "kill_switch",
          });
        }
      }

      if (turn.content) {
        ctx.addAssistant(turn.content);
        store?.appendTurn(sessionId, { role: "assistant", content: turn.content });
      }

      // No tool calls → the model is done.
      if (turn.tool_calls.length === 0) {
        return finalize({
          answer: turn.content,
          iterations,
          toolCalls,
          stopReason: "final_answer",
        });
      }

      // Dispatch each requested tool call.
      for (const call of turn.tool_calls) {
        toolCalls++;
        const { feedback, invalidArgs, policyDenied, auditEventId } = await this.dispatchOnce(
          call.name,
          call.arguments,
          sessionId,
          correlationId,
        );
        ctx.addToolResult(call.name, feedback);
        store?.appendTurn(sessionId, {
          role: "tool_result",
          source: `tool:${call.name}`,
          tool_name: call.name,
          content: feedback,
          audit_event_id: auditEventId ?? null,
        });

        if (invalidArgs) {
          consecutiveInvalidArgs++;
          if (consecutiveInvalidArgs > this.repairAttempts) {
            return finalize({
              answer:
                `Aborted: the model failed to produce valid arguments for ` +
                `"${call.name}" after ${String(this.repairAttempts)} repair attempt(s).`,
              iterations,
              toolCalls,
              stopReason: "repair_exhausted",
            });
          }
        } else {
          consecutiveInvalidArgs = 0;
        }

        // Consecutive-denials kill switch trigger.
        if (policyDenied) {
          consecutiveDenials++;
          if (consecutiveDenials >= this.consecutiveDenialsLimit) {
            const reason =
              `${String(consecutiveDenials)} consecutive mutations blocked by policy or verifier`;
            this.killSwitch?.activate(reason, "consecutive_denials");
            return finalize({
              answer: `Aborted: ${reason}. Kill switch activated to halt runaway action attempts.`,
              iterations,
              toolCalls,
              stopReason: "kill_switch",
            });
          }
        } else {
          consecutiveDenials = 0;
        }
      }
    }

    return finalize({
      answer: "Reached the reasoning iteration cap before producing a final answer.",
      iterations,
      toolCalls,
      stopReason: "iteration_cap",
    });
  }

  /**
   * Dispatch a single tool call. Returns the text to feed back to the model,
   * whether the failure was an invalid-args (repairable) failure, and whether
   * the call was denied by policy/verifier (triggers consecutive-denials counter).
   * Invalid args are never executed — the schema error is fed back so the model
   * can self-correct on the next turn.
   */
  private async dispatchOnce(
    name: string,
    args: unknown,
    sessionId: string,
    correlationId: string,
  ): Promise<{ feedback: string; invalidArgs: boolean; policyDenied: boolean; auditEventId?: string }> {
    // pre_tool hooks (TIGHTEN-ONLY): a hook may block a tool before it runs, but
    // can never permit one. A block short-circuits dispatch entirely — the tool
    // never executes, and the block is audited inside the hook runner.
    if (this.hooks?.hasHooks("pre_tool")) {
      const outcome = this.hooks.run("pre_tool", {
        event: "pre_tool",
        session_id: sessionId,
        correlation_id: correlationId,
        tool_name: name,
        tool_args: args,
        cwd: this.toolContext.repoRoot,
      });
      if (outcome.blocked) {
        return {
          feedback:
            `ERROR: "${name}" was blocked by hook "${outcome.blockedBy}" and NOT executed: ` +
            `${outcome.blockReason}\nThis is a policy gate; do not retry the same action.`,
          invalidArgs: false,
          policyDenied: true,
        };
      }
    }

    const result = await this.dispatchInner(name, args, sessionId, correlationId);

    // post_tool hooks are observational. Their output is UNTRUSTED and is fenced
    // before being appended to the feedback. They cannot un-block or alter the
    // tool's result — only add fenced commentary.
    if (this.hooks?.hasHooks("post_tool")) {
      const outcome = this.hooks.run("post_tool", {
        event: "post_tool",
        session_id: sessionId,
        correlation_id: correlationId,
        tool_name: name,
        tool_result: result.feedback,
        cwd: this.toolContext.repoRoot,
      });
      const notes = outcome.results
        .map((r) => r.output.trim())
        .filter((o) => o.length > 0)
        .join("\n");
      if (notes.length > 0) {
        return {
          ...result,
          feedback: `${result.feedback}\n${fenceUntrusted(`hook:post_tool:${name}`, notes)}`,
        };
      }
    }

    return result;
  }

  /** The pre/post-hook-free dispatch core (executor for mutations, dispatcher otherwise). */
  private async dispatchInner(
    name: string,
    args: unknown,
    sessionId: string,
    correlationId: string,
  ): Promise<{ feedback: string; invalidArgs: boolean; policyDenied: boolean; auditEventId?: string }> {
    // Mutating tools (L3+) go through the executor and the no-audit-no-action
    // gate. Read/draft tools (L0/L1) use the direct dispatcher.
    const tool = this.registry.get(name);
    if (tool && isMutatingTool(tool)) {
      return this.executeMutation(tool, args, sessionId, correlationId);
    }

    const outcome = await dispatchTool(this.registry, name, args, {
      ...(this.ledger ? { ledger: this.ledger } : {}),
      ctx: this.toolContext,
      session_id: sessionId,
      correlation_id: correlationId,
      model: this.model.model,
    });

    switch (outcome.status) {
      case "ok":
        return {
          feedback: outcome.result.output,
          invalidArgs: false,
          policyDenied: false,
          auditEventId: outcome.event_id,
        };
      case "invalid_args":
        return {
          feedback:
            `ERROR: your call to "${name}" had invalid arguments and was NOT executed.\n` +
            `Schema validation failed: ${outcome.error}\n` +
            `Correct the arguments to match the tool's schema and try again.`,
          invalidArgs: true,
          policyDenied: false,
          auditEventId: outcome.event_id,
        };
      case "unknown_tool":
        return {
          feedback: `ERROR: unknown tool "${name}". Use one of the provided tools.`,
          invalidArgs: false,
          policyDenied: false,
        };
      case "error":
        return {
          feedback: `ERROR: tool "${name}" failed: ${outcome.error}`,
          invalidArgs: false,
          policyDenied: false,
          auditEventId: outcome.event_id,
        };
    }
  }

  /** Route a mutating tool through the gating executor. */
  private async executeMutation(
    tool: MutatingTool,
    args: unknown,
    sessionId: string,
    correlationId: string,
  ): Promise<{ feedback: string; invalidArgs: boolean; policyDenied: boolean; auditEventId?: string }> {
    const outcome = await this.executor.execute(tool, args, {
      ...(this.ledger ? { ledger: this.ledger } : {}),
      ctx: this.toolContext,
      session_id: sessionId,
      correlation_id: correlationId,
      model: this.model.model,
      killSwitch: this.killSwitch,
      verifier: this.verifier,
      model_eval_passed: this.modelEvalPassed,
      ...(this.snapshots ? { snapshots: this.snapshots } : {}),
    });

    const eventId =
      "event_id" in outcome && outcome.event_id
        ? { auditEventId: outcome.event_id }
        : {};
    switch (outcome.status) {
      case "executed":
        return {
          feedback: `OK: ${outcome.summary}. Rollback: ${outcome.rollback_path}.`,
          invalidArgs: false,
          policyDenied: false,
          ...eventId,
        };
      case "blocked":
        return {
          feedback:
            `ERROR: "${tool.descriptor.name}" was blocked and NOT executed: ${outcome.reason}\n` +
            `Correct the request and try again.`,
          // A zod-validation block is repairable; surface it like invalid args.
          invalidArgs: outcome.reason.startsWith("invalid tool args"),
          // Policy/verifier/kill-switch blocks count toward the consecutive-denials trigger.
          policyDenied: !outcome.reason.startsWith("invalid tool args"),
          ...eventId,
        };
      case "audit_failed":
        return {
          feedback: `ERROR: "${tool.descriptor.name}" did not run: ${outcome.reason}`,
          invalidArgs: false,
          policyDenied: false,
          ...eventId,
        };
      case "apply_failed":
        return {
          feedback: `ERROR: "${tool.descriptor.name}" failed after audit: ${outcome.reason}`,
          invalidArgs: false,
          policyDenied: false,
          ...eventId,
        };
    }
  }
}

export { ReasoningEngine as Engine };
