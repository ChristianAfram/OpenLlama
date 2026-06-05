/**
 * Factory for minimal MutatingTool instances used in tests.
 */

import { z } from "zod";
import type { MutatingTool, PlannedMutation, ToolContext } from "../../src/tools/registry.js";
import type { PermissionLevel, RiskLevel } from "../../src/kernel/audit.js";

type PermLevel = 0 | 1 | 2 | 3 | 4 | 5;

function levelToRisk(level: PermLevel): RiskLevel {
  if (level <= 1) return "low";
  if (level <= 2) return "low";
  if (level <= 3) return "medium";
  if (level <= 4) return "high";
  return "critical";
}

export interface DummyToolOpts {
  name?: string;
  level?: PermLevel;
  target?: string;
  /** Override the apply() function (default: no-op). */
  apply?: () => void | string | Promise<void | string>;
  requiresApproval?: boolean;
}

const schema = z.object({
  path: z.string().default("dummy.txt"),
  content: z.string().default(""),
});

export function makeDummyMutatingTool(opts: DummyToolOpts = {}): MutatingTool {
  const level = (opts.level ?? 3) as PermLevel;
  const name = opts.name ?? "dummy_tool";
  const target = opts.target ?? "dummy.txt";
  const applyFn = opts.apply ?? (() => undefined);

  return {
    descriptor: {
      name,
      description: `Dummy mutating tool for tests (L${String(level)})`,
      permission_level: level as PermissionLevel,
      risk_level: levelToRisk(level),
      allowed_paths: ["**"],
      denied_paths: [],
      requires_approval: opts.requiresApproval ?? level >= 4,
      audit_required: true,
      rate_limit: "none",
      rollback: "n/a",
    },
    schema,
    plan(_args: unknown, _ctx: ToolContext): PlannedMutation {
      return {
        target,
        data_changed: [{ path: target, before_hash: null, after_hash: "abc123" }],
        rollback_path: `delete ${target}`,
        summary: `dummy mutation on ${target}`,
        apply: applyFn,
      };
    },
  };
}
