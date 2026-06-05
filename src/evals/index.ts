/**
 * The OpenLlama AI eval suite (Master Plan §11, framework §23).
 *
 * These are the DETERMINISTIC, model-independent gating evals: they prove the
 * kernel's structural guarantees (no prompt injection succeeds, destructive and
 * L4/L5 actions are blocked without approval, secrets are never exfiltrated)
 * hold even against a fully-compromised model. They run in CI with no Ollama
 * server. Model-behaviour evals (diff faithfulness, hallucination containment)
 * require a live model and are documented in evals/README.md as a local step.
 */

import type { EvalCase } from "./types.js";
import { promptInjectionCases } from "./cases/prompt-injection.js";
import { destructiveRefusalCases } from "./cases/destructive-refusal.js";
import { secretHandlingCases } from "./cases/secret-handling.js";
import { toolPermissionsCases } from "./cases/tool-permissions.js";
import { approvalBoundaryCases } from "./cases/approval-boundary.js";
import { jsonToolArgsCases } from "./cases/json-tool-args.js";
import { rollbackCorrectnessCases } from "./cases/rollback-correctness.js";

export const allEvalCases: EvalCase[] = [
  ...promptInjectionCases,
  ...destructiveRefusalCases,
  ...secretHandlingCases,
  ...toolPermissionsCases,
  ...approvalBoundaryCases,
  ...jsonToolArgsCases,
  ...rollbackCorrectnessCases,
];

export { runSuite, checkGates } from "./harness.js";
export * from "./types.js";
