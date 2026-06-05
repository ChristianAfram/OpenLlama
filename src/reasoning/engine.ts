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
import {
  dispatchTool,
  isMutatingTool,
  type MutatingTool,
  type ToolContext,
  type ToolRegistry,
} from "../tools/registry.js";
import { ConversationContext } from "./context.js";
import type { ModelClient, ToolDefinition } from "./model-client.js";

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
  private readonly sessionId = randomUUID();
  private readonly killSwitch?: KillSwitch;
  private readonly verifier?: Verifier;
  private readonly consecutiveDenialsLimit: number;
  private readonly maxTotalTokens: number | undefined;
  private readonly modelEvalPassed: boolean | undefined;

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

    const ctx = new ConversationContext();
    ctx.addUser(instruction);

    let iterations = 0;
    let toolCalls = 0;
    // Consecutive invalid-argument failures. Reset on any valid dispatch. When
    // it exceeds repairAttempts, the model has failed to self-correct and we
    // abort rather than burn the full iteration budget.
    let consecutiveInvalidArgs = 0;
    // Consecutive mutations blocked by policy — triggers the kill switch when
    // it exceeds consecutiveDenialsLimit.
    let consecutiveDenials = 0;
    // Total tokens consumed across all model calls (from usage field when available).
    let totalTokens = 0;
    const correlationId = randomUUID();

    while (iterations < this.maxIterations) {
      iterations++;
      const turn = await this.model.generate(ctx.toMessages(), this.toolDefs);

      // Track token usage for cost controls.
      if (turn.usage) {
        totalTokens += (turn.usage.input_tokens ?? 0) + (turn.usage.output_tokens ?? 0);
        if (this.maxTotalTokens !== undefined && totalTokens > this.maxTotalTokens) {
          const reason = `token cap exceeded: ${String(totalTokens)} > ${String(this.maxTotalTokens)}`;
          this.killSwitch?.activate(reason, "cost_cap");
          return {
            answer: `Aborted: ${reason}. Kill switch activated.`,
            iterations,
            toolCalls,
            stopReason: "kill_switch",
          };
        }
      }

      if (turn.content) ctx.addAssistant(turn.content);

      // No tool calls → the model is done.
      if (turn.tool_calls.length === 0) {
        return {
          answer: turn.content,
          iterations,
          toolCalls,
          stopReason: "final_answer",
        };
      }

      // Dispatch each requested tool call.
      for (const call of turn.tool_calls) {
        toolCalls++;
        const { feedback, invalidArgs, policyDenied } = await this.dispatchOnce(
          call.name,
          call.arguments,
          correlationId,
        );
        ctx.addToolResult(call.name, feedback);

        if (invalidArgs) {
          consecutiveInvalidArgs++;
          if (consecutiveInvalidArgs > this.repairAttempts) {
            return {
              answer:
                `Aborted: the model failed to produce valid arguments for ` +
                `"${call.name}" after ${String(this.repairAttempts)} repair attempt(s).`,
              iterations,
              toolCalls,
              stopReason: "repair_exhausted",
            };
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
            return {
              answer: `Aborted: ${reason}. Kill switch activated to halt runaway action attempts.`,
              iterations,
              toolCalls,
              stopReason: "kill_switch",
            };
          }
        } else {
          consecutiveDenials = 0;
        }
      }
    }

    return {
      answer: "Reached the reasoning iteration cap before producing a final answer.",
      iterations,
      toolCalls,
      stopReason: "iteration_cap",
    };
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
    correlationId: string,
  ): Promise<{ feedback: string; invalidArgs: boolean; policyDenied: boolean }> {
    // Mutating tools (L3+) go through the executor and the no-audit-no-action
    // gate. Read/draft tools (L0/L1) use the direct dispatcher.
    const tool = this.registry.get(name);
    if (tool && isMutatingTool(tool)) {
      return this.executeMutation(tool, args, correlationId);
    }

    const outcome = await dispatchTool(this.registry, name, args, {
      ...(this.ledger ? { ledger: this.ledger } : {}),
      ctx: this.toolContext,
      session_id: this.sessionId,
      correlation_id: correlationId,
      model: this.model.model,
    });

    switch (outcome.status) {
      case "ok":
        return { feedback: outcome.result.output, invalidArgs: false, policyDenied: false };
      case "invalid_args":
        return {
          feedback:
            `ERROR: your call to "${name}" had invalid arguments and was NOT executed.\n` +
            `Schema validation failed: ${outcome.error}\n` +
            `Correct the arguments to match the tool's schema and try again.`,
          invalidArgs: true,
          policyDenied: false,
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
        };
    }
  }

  /** Route a mutating tool through the gating executor. */
  private async executeMutation(
    tool: MutatingTool,
    args: unknown,
    correlationId: string,
  ): Promise<{ feedback: string; invalidArgs: boolean; policyDenied: boolean }> {
    const outcome = await this.executor.execute(tool, args, {
      ...(this.ledger ? { ledger: this.ledger } : {}),
      ctx: this.toolContext,
      session_id: this.sessionId,
      correlation_id: correlationId,
      model: this.model.model,
      killSwitch: this.killSwitch,
      verifier: this.verifier,
      model_eval_passed: this.modelEvalPassed,
    });

    switch (outcome.status) {
      case "executed":
        return {
          feedback: `OK: ${outcome.summary}. Rollback: ${outcome.rollback_path}.`,
          invalidArgs: false,
          policyDenied: false,
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
        };
      case "audit_failed":
        return {
          feedback: `ERROR: "${tool.descriptor.name}" did not run: ${outcome.reason}`,
          invalidArgs: false,
          policyDenied: false,
        };
      case "apply_failed":
        return {
          feedback: `ERROR: "${tool.descriptor.name}" failed after audit: ${outcome.reason}`,
          invalidArgs: false,
          policyDenied: false,
        };
    }
  }
}

export { ReasoningEngine as Engine };
