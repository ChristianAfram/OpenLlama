/**
 * Model governance — catalog-backed check at agent startup.
 *
 * Reads `catalog/models.yml` and verifies the requested model is registered
 * and (in enterprise mode) has been evaluated before use.
 *
 * The check result (`eval_passed`) threads into the executor's `PolicyInput` so
 * the policy engine's `model_governance` rule can DENY per-action if the model
 * hasn't passed evals.
 *
 * Framework §22 / Master Plan §11.
 */

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

// ─── Catalog types ─────────────────────────────────────────────────────────────

export interface ModelEntry {
  model: string;
  source?: string;
  runtime?: string;
  license?: string;
  last_evaluated: string | null;
  min_pass_rate?: Record<string, number>;
  eval_suite?: string;
  known_weaknesses?: string[];
  allowed_tasks?: string[];
  forbidden_tasks?: string[];
}

export interface ModelCatalog {
  models: ModelEntry[];
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export function loadModelCatalog(catalogPath: string): ModelCatalog {
  if (!existsSync(catalogPath)) return { models: [] };
  try {
    const raw = readFileSync(catalogPath, "utf8");
    const parsed = parseYaml(raw) as ModelCatalog | null;
    if (!parsed || !Array.isArray(parsed.models)) return { models: [] };
    return parsed;
  } catch {
    return { models: [] };
  }
}

// ─── Governance check ─────────────────────────────────────────────────────────

export interface ModelGovernanceResult {
  /** Whether the agent may proceed with this model. */
  allowed: boolean;
  /** Whether the model appears in models.yml. */
  in_catalog: boolean;
  /** Whether `last_evaluated` is non-null. */
  evaluated: boolean;
  /**
   * Threaded into the executor's PolicyInput.model_eval_passed.
   * - `true`       → model is in catalog and evaluated
   * - `false`      → model failed / skipped governance check (enterprise blocks)
   * - `undefined`  → no catalog entry found; policy rule not triggered
   */
  eval_passed: boolean | undefined;
  reason: string;
}

export function checkModelGovernance(
  model: string,
  catalog: ModelCatalog,
  enterprise: boolean,
): ModelGovernanceResult {
  const entry = catalog.models.find((m) => m.model === model);

  if (!entry) {
    if (enterprise) {
      return {
        allowed: false,
        in_catalog: false,
        evaluated: false,
        eval_passed: false,
        reason: `Model "${model}" is not registered in catalog/models.yml; enterprise mode requires all models to be registered and evaluated before use.`,
      };
    }
    return {
      allowed: true,
      in_catalog: false,
      evaluated: false,
      eval_passed: undefined,
      reason: `Model "${model}" is not in catalog/models.yml; proceeding with warnings (non-enterprise mode only).`,
    };
  }

  const evaluated = entry.last_evaluated !== null && entry.last_evaluated !== undefined;

  if (!evaluated) {
    if (enterprise) {
      return {
        allowed: false,
        in_catalog: true,
        evaluated: false,
        eval_passed: false,
        reason: `Model "${model}" is registered but has not been evaluated (last_evaluated: null); enterprise mode requires evaluation before use.`,
      };
    }
    return {
      allowed: true,
      in_catalog: true,
      evaluated: false,
      eval_passed: undefined,
      reason: `Model "${model}" has not been evaluated yet (last_evaluated: null); proceeding with warnings (non-enterprise mode only).`,
    };
  }

  return {
    allowed: true,
    in_catalog: true,
    evaluated: true,
    eval_passed: true,
    reason: `Model "${model}" is registered and evaluated (last_evaluated: ${entry.last_evaluated}).`,
  };
}
