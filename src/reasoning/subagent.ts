/**
 * Subagent runner (v0.8 — B7 Extensibility).
 *
 * Runs a focused child agent under the SAME kernel as its parent. The governance
 * stance is "reach, never privilege":
 *
 *   - A subagent runs the full executor / policy / audit / kill-switch pipeline,
 *     so every child action is gated exactly as if the parent performed it.
 *   - Like the parent agent loop, a subagent has NO ApprovalProvider, so it can
 *     never execute an L4/L5 action — its ceiling is exactly the parent's.
 *   - The child shares the parent's correlation_id (one audit timeline) but gets
 *     a fresh session_id, so its events are attributable yet linked.
 *   - The kill switch is shared: a trip halts the whole tree.
 *   - Depth is capped (maxDepth) to bound recursion and cost.
 *   - The child's answer returns to the parent through the normal tool-result
 *     path and is therefore fenced as untrusted data.
 */

import { randomUUID } from "node:crypto";
import { ReasoningEngine, type EngineRunResult } from "./engine.js";
import type { ModelClient } from "./model-client.js";
import type { AuditLedger } from "../kernel/audit.js";
import type { KillSwitch } from "../kernel/kill-switch.js";
import type { Verifier } from "../kernel/verifier.js";
import type { SnapshotStore } from "../kernel/snapshot.js";
import type { ToolContext, ToolRegistry } from "../tools/registry.js";

export interface SubagentDeps {
  /** Builds the registry the child gets (typically the same tools incl. delegate). */
  registryFactory: () => ToolRegistry;
  model: ModelClient;
  toolContext: ToolContext;
  ledger?: AuditLedger;
  killSwitch?: KillSwitch;
  verifier?: Verifier;
  snapshots?: SnapshotStore;
  contextBudget?: number;
  compaction?: "structural" | "model";
  /** Per-subagent iteration cap (default 12 — subagents are focused). */
  maxIterations?: number;
  /** Maximum nesting depth. A child at depth == maxDepth cannot delegate further. */
  maxDepth: number;
}

export interface SubagentRunResult extends EngineRunResult {
  sessionId: string;
}

export class SubagentRunner {
  constructor(private readonly deps: SubagentDeps) {}

  get maxDepth(): number {
    return this.deps.maxDepth;
  }

  /**
   * Run a child agent for `task` at nesting `depth`, sharing `correlationId`.
   * Returns the child's run result plus its fresh session id.
   */
  async run(task: string, depth: number, correlationId: string): Promise<SubagentRunResult> {
    const sessionId = randomUUID();
    const engine = new ReasoningEngine({
      registry: this.deps.registryFactory(),
      model: this.deps.model,
      toolContext: this.deps.toolContext,
      ...(this.deps.ledger ? { ledger: this.deps.ledger } : {}),
      ...(this.deps.killSwitch ? { killSwitch: this.deps.killSwitch } : {}),
      ...(this.deps.verifier ? { verifier: this.deps.verifier } : {}),
      ...(this.deps.snapshots ? { snapshots: this.deps.snapshots } : {}),
      ...(this.deps.contextBudget !== undefined ? { contextBudget: this.deps.contextBudget } : {}),
      ...(this.deps.compaction ? { compaction: this.deps.compaction } : {}),
      maxIterations: this.deps.maxIterations ?? 12,
      // Shared timeline, fresh session, and the child's nesting depth.
      correlationId,
      sessionId,
      subagentDepth: depth,
      // NOTE: no sessionStore (subagents are not top-level resumable sessions)
      // and no approvals (a subagent can never self-approve an L4/L5 action).
    });
    const result = await engine.run(task);
    return { ...result, sessionId };
  }
}
