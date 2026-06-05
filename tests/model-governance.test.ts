/**
 * Model governance tests (Prompt 9).
 *
 * Exit criterion: "a model that fails evals is refused at load."
 *
 * Proves:
 *  1. Model not in catalog → allowed in non-enterprise, blocked in enterprise.
 *  2. Model in catalog but not evaluated → allowed in non-enterprise, blocked in enterprise.
 *  3. Model in catalog and evaluated → allowed in both modes; eval_passed = true.
 *  4. The policy engine's model_governance rule fires when model_eval_passed = false.
 *  5. loadModelCatalog handles missing file gracefully.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModelCatalog, checkModelGovernance } from "../src/lib/model-governance.js";
import { PolicyEngine } from "../src/policy/engine.js";

// ─── loadModelCatalog ─────────────────────────────────────────────────────────

describe("loadModelCatalog", () => {
  it("returns empty catalog when file does not exist", () => {
    const result = loadModelCatalog("/no/such/file.yml");
    expect(result.models).toHaveLength(0);
  });

  it("parses a valid catalog file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mg-"));
    const path = join(dir, "models.yml");
    writeFileSync(
      path,
      [
        "models:",
        "  - model: test-model:7b",
        "    source: local",
        "    last_evaluated: 2026-06-05",
      ].join("\n"),
      "utf8",
    );
    try {
      const catalog = loadModelCatalog(path);
      expect(catalog.models).toHaveLength(1);
      expect(catalog.models[0]!.model).toBe("test-model:7b");
      expect(catalog.models[0]!.last_evaluated).toBe("2026-06-05");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty catalog for a null-models entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "mg-"));
    const path = join(dir, "models.yml");
    writeFileSync(path, "models:\n", "utf8");
    try {
      const catalog = loadModelCatalog(path);
      expect(catalog.models).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── checkModelGovernance ─────────────────────────────────────────────────────

const CATALOG_WITH_EVALUATED = {
  models: [
    {
      model: "qwen2.5-coder:7b",
      source: "local",
      last_evaluated: "2026-06-05",
    },
  ],
};

const CATALOG_WITH_UNEVALUATED = {
  models: [
    {
      model: "qwen2.5-coder:7b",
      source: "local",
      last_evaluated: null,
    },
  ],
};

const EMPTY_CATALOG = { models: [] };

describe("checkModelGovernance — model not in catalog", () => {
  it("allows in non-enterprise mode with eval_passed undefined", () => {
    const r = checkModelGovernance("unknown-model:7b", EMPTY_CATALOG, false);
    expect(r.allowed).toBe(true);
    expect(r.in_catalog).toBe(false);
    expect(r.eval_passed).toBeUndefined();
  });

  it("blocks in enterprise mode", () => {
    const r = checkModelGovernance("unknown-model:7b", EMPTY_CATALOG, true);
    expect(r.allowed).toBe(false);
    expect(r.in_catalog).toBe(false);
    expect(r.eval_passed).toBe(false);
    expect(r.reason).toMatch(/enterprise/i);
  });
});

describe("checkModelGovernance — model in catalog, not evaluated", () => {
  it("allows in non-enterprise mode with eval_passed undefined", () => {
    const r = checkModelGovernance("qwen2.5-coder:7b", CATALOG_WITH_UNEVALUATED, false);
    expect(r.allowed).toBe(true);
    expect(r.in_catalog).toBe(true);
    expect(r.evaluated).toBe(false);
    expect(r.eval_passed).toBeUndefined();
  });

  it("blocks in enterprise mode", () => {
    const r = checkModelGovernance("qwen2.5-coder:7b", CATALOG_WITH_UNEVALUATED, true);
    expect(r.allowed).toBe(false);
    expect(r.in_catalog).toBe(true);
    expect(r.evaluated).toBe(false);
    expect(r.eval_passed).toBe(false);
    expect(r.reason).toMatch(/not been evaluated/i);
  });
});

describe("checkModelGovernance — model in catalog and evaluated", () => {
  it("allows in both enterprise and non-enterprise with eval_passed = true", () => {
    for (const enterprise of [false, true]) {
      const r = checkModelGovernance("qwen2.5-coder:7b", CATALOG_WITH_EVALUATED, enterprise);
      expect(r.allowed).toBe(true);
      expect(r.in_catalog).toBe(true);
      expect(r.evaluated).toBe(true);
      expect(r.eval_passed).toBe(true);
    }
  });
});

// ─── Policy engine: model_eval_passed = false → DENY ─────────────────────────

describe("Policy engine model_governance rule", () => {
  const engine = new PolicyEngine();

  it("DENY when model_eval_passed is false", () => {
    const result = engine.evaluate({
      tool: "run_shell",
      permission_level: 4,
      risk_level: "high",
      model_eval_passed: false,
    });
    expect(result.decision).toBe("DENY");
    expect(result.reason).toMatch(/eval suite|MODEL_EVAL/i);
  });

  it("does not fire when model_eval_passed is true", () => {
    const result = engine.evaluate({
      tool: "run_shell",
      permission_level: 4,
      risk_level: "high",
      model_eval_passed: true,
    });
    // Should be REQUIRE_APPROVAL (L4), not DENY.
    expect(result.decision).not.toBe("DENY");
  });

  it("does not fire when model_eval_passed is undefined (not set)", () => {
    const result = engine.evaluate({
      tool: "run_shell",
      permission_level: 4,
      risk_level: "high",
    });
    // Undefined → rule does not fire; should be REQUIRE_APPROVAL (L4).
    expect(result.decision).not.toBe("DENY");
  });
});
