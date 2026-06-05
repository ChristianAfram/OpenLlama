/**
 * Policy engine tests (Prompt 8, Master Plan §8).
 *
 * Proves the bundle produces the documented decisions, that the most-restrictive
 * rule wins, and that the engine is wired into the executor so policy gates real
 * actions (not just a standalone evaluator).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PolicyEngine,
  getDefaultPolicyEngine,
  moreRestrictive,
  type PolicyInput,
} from "../src/policy/index.js";
import { AuditLedger } from "../src/kernel/audit.js";
import { Executor } from "../src/kernel/executor.js";
import { writeFileTool } from "../src/tools/write_file.js";
import { editFileTool } from "../src/tools/edit_file.js";
import { runShellTool } from "../src/tools/run_shell.js";

const engine = getDefaultPolicyEngine();

function decide(partial: Partial<PolicyInput> & { tool: string; permission_level: PolicyInput["permission_level"] }) {
  return engine.evaluate({
    risk_level: "low",
    ...partial,
  } as PolicyInput);
}

// ─── Decision ordering ────────────────────────────────────────────────────────

describe("moreRestrictive", () => {
  it("orders ALLOW < REQUIRE_APPROVAL < REQUIRE_CONFIRMATION < DENY", () => {
    expect(moreRestrictive("ALLOW", "REQUIRE_APPROVAL")).toBe("REQUIRE_APPROVAL");
    expect(moreRestrictive("REQUIRE_APPROVAL", "REQUIRE_CONFIRMATION")).toBe("REQUIRE_CONFIRMATION");
    expect(moreRestrictive("REQUIRE_CONFIRMATION", "DENY")).toBe("DENY");
    expect(moreRestrictive("DENY", "ALLOW")).toBe("DENY");
  });
});

// ─── Level → decision (agent_actions) ─────────────────────────────────────────

describe("agent_actions permission-level mapping", () => {
  it.each([
    [0, "ALLOW"],
    [1, "ALLOW"],
    [2, "ALLOW"],
    [3, "ALLOW"],
    [4, "REQUIRE_APPROVAL"],
    [5, "REQUIRE_CONFIRMATION"],
  ] as const)("level %i → %s", (level, expected) => {
    const r = decide({ tool: "write_file", permission_level: level });
    expect(r.decision).toBe(expected);
  });
});

// ─── secrets ──────────────────────────────────────────────────────────────────

describe("secrets rule", () => {
  it("DENY when secret_path is flagged, even at a low level", () => {
    const r = decide({ tool: "read_file", permission_level: 0, secret_path: true });
    expect(r.decision).toBe("DENY");
    expect(r.rule_id).toBe("secrets.path_denylist");
  });

  it("DENY when the target looks like a secret path", () => {
    expect(decide({ tool: "write_file", permission_level: 3, target: ".env" }).decision).toBe("DENY");
    expect(decide({ tool: "write_file", permission_level: 3, target: "secrets/k.pem" }).decision).toBe("DENY");
    expect(decide({ tool: "write_file", permission_level: 3, target: "src/.env.local" }).decision).toBe("DENY");
  });

  it("DENY beats REQUIRE_CONFIRMATION (most restrictive wins)", () => {
    const r = decide({ tool: "write_file", permission_level: 5, target: ".env", secret_path: true });
    expect(r.decision).toBe("DENY");
  });
});

// ─── filesystem ───────────────────────────────────────────────────────────────

describe("filesystem rule", () => {
  it("DENY on a path that escapes the repo root", () => {
    expect(decide({ tool: "write_file", permission_level: 3, target: "../outside.txt" }).decision).toBe("DENY");
  });
  it("does not fire on synthetic shell/git targets", () => {
    expect(decide({ tool: "run_shell", permission_level: 4, target: "shell:echo hi" }).decision).toBe("REQUIRE_APPROVAL");
  });
});

// ─── git ──────────────────────────────────────────────────────────────────────

describe("git rule", () => {
  it("REQUIRE_CONFIRMATION for a protected-branch push", () => {
    const r = decide({ tool: "git", permission_level: 4, git_branch: "main" });
    expect(r.decision).toBe("REQUIRE_CONFIRMATION");
    expect(r.rule_id).toBe("git.protected_branch");
  });
  it("REQUIRE_CONFIRMATION for a release/* push", () => {
    expect(decide({ tool: "git", permission_level: 4, git_branch: "release/1.2" }).decision).toBe("REQUIRE_CONFIRMATION");
  });
  it("REQUIRE_CONFIRMATION for a force-push token in args", () => {
    const r = decide({ tool: "git", permission_level: 4, args: { flags: "--force" } });
    expect(r.decision).toBe("REQUIRE_CONFIRMATION");
    expect(r.rule_id).toBe("git.force_push");
  });
});

// ─── dependencies / network / model governance / core ─────────────────────────

describe("dependencies, network, model governance, core", () => {
  it("dependency install requires approval (DENY in enterprise)", () => {
    expect(decide({ tool: "run_shell", permission_level: 4, command: "npm install left-pad" }).decision).toBe("REQUIRE_APPROVAL");
    expect(decide({ tool: "run_shell", permission_level: 4, command: "npm install left-pad", enterprise: true }).decision).toBe("DENY");
  });
  it("non-allowlisted egress requires approval (DENY in enterprise)", () => {
    expect(decide({ tool: "fetch", permission_level: 4, egress_domain: "evil.example.com" }).decision).toBe("REQUIRE_APPROVAL");
    expect(decide({ tool: "fetch", permission_level: 4, egress_domain: "evil.example.com", enterprise: true }).decision).toBe("DENY");
  });
  it("DENY when the model has not passed its evals", () => {
    const r = decide({ tool: "edit_file", permission_level: 4, model: "sketchy:1b", model_eval_passed: false });
    expect(r.decision).toBe("DENY");
    expect(r.rule_id).toBe("model_governance.evals_not_passed");
  });
  it("DENY high/critical when audit is unavailable", () => {
    const r = decide({ tool: "edit_file", permission_level: 4, risk_level: "high", audit_available: false });
    expect(r.decision).toBe("DENY");
  });
  it("contributing lists every rule that fired", () => {
    const r = decide({ tool: "git", permission_level: 5, risk_level: "critical", git_branch: "main" });
    const ids = r.contributing.map((c) => c.rule_id);
    expect(ids).toContain("agent_actions.level_5");
    expect(ids).toContain("git.protected_branch");
  });
});

// ─── custom bundle ────────────────────────────────────────────────────────────

describe("PolicyEngine with a custom bundle", () => {
  it("an empty bundle defaults to ALLOW", () => {
    const empty = new PolicyEngine([]);
    expect(empty.evaluate({ tool: "x", permission_level: 5, risk_level: "critical" }).decision).toBe("ALLOW");
  });
});

// ─── Executor integration: policy gates real actions ──────────────────────────

describe("executor policy integration", () => {
  let repo: string;
  let ledger: AuditLedger;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "policy-exec-"));
    ledger = new AuditLedger(":memory:");
  });
  afterEach(() => {
    ledger.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it("records the policy decision on the audit event", async () => {
    const outcome = await new Executor(ledger).execute(
      writeFileTool,
      { path: "new.txt", content: "hi\n" },
      { ctx: { repoRoot: repo } },
    );
    expect(outcome.status).toBe("executed");
    const ev = ledger.getEvents(10, 0).find((e) => e.result === "executed");
    expect(ev?.policy_decision).toBe("ALLOW");
  });

  it("blocks an L4 edit with REQUIRE_APPROVAL and no provider", async () => {
    writeFileSync(join(repo, "e.txt"), "before\n");
    const outcome = await new Executor(ledger).execute(
      editFileTool,
      { path: "e.txt", old_string: "before", new_string: "after" },
      { ctx: { repoRoot: repo } },
    );
    expect(outcome.status).toBe("blocked");
    const ev = ledger.getEvents(10, 0).find((e) => e.result === "blocked");
    expect(ev?.policy_decision).toBe("REQUIRE_APPROVAL");
    expect(readFileSync(join(repo, "e.txt"), "utf8")).toBe("before\n");
  });

  it("enterprise mode hard-DENYs a dependency install (no approval can rescue it)", async () => {
    // Even with an auto-approving provider, a DENY is terminal.
    const autoApprove = {
      requestApproval: (req: { action_id: string; tool_name: string }) => ({
        status: "granted" as const,
        grant: {
          approval_id: "ap",
          action_id: req.action_id,
          permission_level: 4 as const,
          approved_by: "x",
          approved_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          scope: { tools: [req.tool_name], path_globs: ["shell:*"], session_id: "s", max_level: 4 as const },
          reason: "x",
        },
      }),
    };
    const outcome = await new Executor(ledger).execute(
      runShellTool,
      { command: "npm install left-pad" },
      { ctx: { repoRoot: repo }, session_id: "s", approvals: autoApprove, enterprise: true },
    );
    expect(outcome.status).toBe("blocked");
    const ev = ledger.getEvents(10, 0).find((e) => e.result === "blocked");
    expect(ev?.policy_decision).toBe("DENY");
  });

  it("non-enterprise: same dependency install is gated by approval, not denied", async () => {
    // With no approval channel it is blocked at the gate — but the decision is
    // REQUIRE_APPROVAL (approvable), NOT the enterprise hard DENY. We assert the
    // recorded decision rather than executing npm.
    const outcome = await new Executor(ledger).execute(
      runShellTool,
      { command: "npm install left-pad" },
      { ctx: { repoRoot: repo } },
    );
    expect(outcome.status).toBe("blocked");
    const ev = ledger.getEvents(10, 0).find((e) => e.result === "blocked");
    expect(ev?.policy_decision).toBe("REQUIRE_APPROVAL");
    expect(existsSync(join(repo, "node_modules"))).toBe(false);
  });
});
