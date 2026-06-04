/**
 * Eval harness: run cases, aggregate per category, check gates.
 *
 * Each case gets a fresh throwaway repo root (a temp dir) so cases never see
 * each other's filesystem state. The harness produces framework §23 records and
 * a per-category pass-rate aggregate the CI gate consumes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GATES,
  HARD_GATES,
  type EvalCase,
  type EvalResult,
  type EvalSuiteResult,
} from "./types.js";

/** Run a single case in an isolated temp repo, capturing failures as results. */
async function runCase(c: EvalCase): Promise<EvalResult> {
  const repoRoot = mkdtempSync(join(tmpdir(), "openllama-eval-"));
  try {
    const outcome = await c.run({ repoRoot });
    return {
      eval_id: c.id,
      category: c.category,
      input: c.input,
      expected: outcome.expected,
      actual: outcome.actual,
      passed: outcome.passed,
      risk_level: c.risk_level,
      notes: outcome.notes ?? "",
    };
  } catch (err) {
    // A thrown error is a hard fail — the eval itself broke. Record it so the
    // suite never silently passes by skipping a crashing case.
    return {
      eval_id: c.id,
      category: c.category,
      input: c.input,
      expected: "(case completes and asserts)",
      actual: `case threw: ${err instanceof Error ? err.message : String(err)}`,
      passed: false,
      risk_level: c.risk_level,
      notes: "eval harness caught an exception",
    };
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

/** Run all cases and aggregate. */
export async function runSuite(cases: EvalCase[]): Promise<EvalSuiteResult> {
  const results: EvalResult[] = [];
  for (const c of cases) {
    results.push(await runCase(c));
  }

  const byCategory: EvalSuiteResult["byCategory"] = {};
  for (const r of results) {
    const bucket = (byCategory[r.category] ??= { total: 0, passed: 0, rate: 1 });
    bucket.total++;
    if (r.passed) bucket.passed++;
  }
  for (const bucket of Object.values(byCategory)) {
    bucket.rate = bucket.total === 0 ? 1 : bucket.passed / bucket.total;
  }

  return {
    results,
    byCategory,
    total: results.length,
    passed: results.filter((r) => r.passed).length,
  };
}

export interface GateCheck {
  ok: boolean;
  failures: { category: string; rate: number; required: number; hard: boolean }[];
}

/**
 * Check the per-category pass rates against GATES. A category below its
 * threshold fails the gate; hard gates (prompt-injection, destructive-refusal)
 * are flagged so the reporter can emphasise them.
 */
export function checkGates(suite: EvalSuiteResult): GateCheck {
  const failures: GateCheck["failures"] = [];
  for (const [category, required] of Object.entries(GATES)) {
    const bucket = suite.byCategory[category];
    // A required category with zero cases is itself a failure — the gate would
    // be vacuously "met". Don't let a missing category pass silently.
    const rate = bucket?.rate ?? 0;
    if (rate < required) {
      failures.push({
        category,
        rate,
        required,
        hard: HARD_GATES.includes(category as (typeof HARD_GATES)[number]),
      });
    }
  }
  return { ok: failures.length === 0, failures };
}
