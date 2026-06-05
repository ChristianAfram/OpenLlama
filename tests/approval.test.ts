/**
 * Approval gate tests (Prompt 5) — the permission boundary.
 *
 * Exit criteria (Master Plan v0.2):
 *   - Approval cannot be bypassed: an L4/L5 action with no approval channel is
 *     blocked and never applied.
 *   - L5 cannot execute without a manual confirmation phrase.
 *   - Scopes are enforced: wrong tool / wrong path / wrong session / expired /
 *     level-exceeds-grant / different-action grants are all rejected.
 *   - Overbroad ("approve everything") grants are refused.
 *   - A correctly-scoped grant lets the action execute and records approval_id.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AuditLedger } from "../src/kernel/audit.js";
import { Executor } from "../src/kernel/executor.js";
import {
  verifyGrant,
  requiredConfirmationPhrase,
  MAX_GRANT_TTL_MS,
  type ApprovalGrant,
  type ApprovalProvider,
  type ApprovalRequest,
  type ApprovalDecision,
} from "../src/kernel/approval.js";
import type { MutatingTool, PlannedMutation, ToolDescriptor } from "../src/tools/registry.js";

// ─── A configurable L4/L5 mutating tool for the integration tests ─────────────

/** A test tool plus a probe telling whether its side effect actually ran. */
interface ProbeTool {
  tool: MutatingTool;
  applied: () => boolean;
}

function makeTool(level: 4 | 5, name = "danger_tool"): ProbeTool {
  const desc: ToolDescriptor = {
    name,
    description: "test mutating tool",
    permission_level: level,
    risk_level: level >= 5 ? "critical" : "high",
    allowed_paths: ["${REPO_ROOT}/**"],
    denied_paths: [],
    requires_approval: true,
    audit_required: true,
    rate_limit: "60/min",
    rollback: "none",
  };
  let applied = false;
  const tool: MutatingTool<{ path: string }> = {
    descriptor: desc,
    schema: z.object({ path: z.string() }),
    plan(args: { path: string }): PlannedMutation {
      return {
        target: args.path,
        data_changed: [{ path: args.path, before_hash: null, after_hash: "sha256:deadbeef" }],
        rollback_path: `delete ${args.path}`,
        summary: `mutated ${args.path}`,
        apply() {
          applied = true;
        },
      };
    },
  };
  return { tool: tool as MutatingTool, applied: () => applied };
}

// ─── Scripted approval providers ──────────────────────────────────────────────

class DenyProvider implements ApprovalProvider {
  requestApproval(): ApprovalDecision {
    return { status: "denied", reason: "scripted denial" };
  }
}

/** Grants a correctly-scoped token for whatever it's asked to approve. */
class AutoGrantProvider implements ApprovalProvider {
  constructor(private readonly opts: { confirm?: boolean; ttlMs?: number } = {}) {}
  requestApproval(req: ApprovalRequest): ApprovalDecision {
    const now = Date.now();
    const grant: ApprovalGrant = {
      approval_id: "appr-" + req.action_id,
      action_id: req.action_id,
      permission_level: req.permission_level,
      approved_by: "user:test",
      approved_at: new Date(now).toISOString(),
      expires_at: new Date(now + (this.opts.ttlMs ?? 60_000)).toISOString(),
      scope: {
        tools: [req.tool_name],
        path_globs: req.target ? [req.target] : ["__none__"],
        session_id: req.session_id ?? "__none__",
        max_level: req.permission_level,
      },
      reason: req.reason,
      rollback_path: req.rollback_path,
      ...(this.opts.confirm && req.permission_level >= 5
        ? { confirmation_phrase: requiredConfirmationPhrase(req) }
        : {}),
    };
    return { status: "granted", grant };
  }
}

// ─── Test harness ─────────────────────────────────────────────────────────────

let repo: string;
let ledger: AuditLedger;
let executor: Executor;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "openllama-appr-"));
  ledger = new AuditLedger(join(repo, ".audit.sqlite"));
  executor = new Executor(ledger);
});

afterEach(() => {
  ledger.close();
  rmSync(repo, { recursive: true, force: true });
});

const ctx = () => ({ repoRoot: repo });

// ─── Bypass prevention ────────────────────────────────────────────────────────

describe("approval cannot be bypassed", () => {
  it("blocks an L4 action when no approval channel is supplied", async () => {
    const { tool, applied } = makeTool(4);
    const outcome = await executor.execute(tool, { path: "x.txt" }, { ledger, ctx: ctx() });
    expect(outcome.status).toBe("blocked");
    expect(applied()).toBe(false);

    const ev = ledger.getEvents().find((e) => e.tool_name === "danger_tool")!;
    expect(ev.result).toBe("blocked");
    expect(ev.policy_decision).toBe("REQUIRE_APPROVAL");
  });

  it("blocks an L5 action when no approval channel is supplied", async () => {
    const { tool } = makeTool(5);
    const outcome = await executor.execute(tool, { path: "x.txt" }, { ledger, ctx: ctx() });
    expect(outcome.status).toBe("blocked");
    const ev = ledger.getEvents().find((e) => e.tool_name === "danger_tool")!;
    expect(ev.policy_decision).toBe("REQUIRE_CONFIRMATION");
  });

  it("blocks when the provider denies", async () => {
    const { tool } = makeTool(4);
    const outcome = await executor.execute(tool, { path: "x.txt" }, {
      ledger,
      ctx: ctx(),
      approvals: new DenyProvider(),
    });
    expect(outcome.status).toBe("blocked");
    if (outcome.status === "blocked") expect(outcome.reason).toContain("denied");
    const ev = ledger.getEvents().find((e) => e.tool_name === "danger_tool")!;
    expect(ev.policy_decision).toBe("DENY");
  });
});

// ─── L4 happy path ────────────────────────────────────────────────────────────

describe("L4 with a correctly-scoped grant executes and is audited", () => {
  it("executes and records approval_id + REQUIRE_APPROVAL", async () => {
    const { tool, applied } = makeTool(4);
    const outcome = await executor.execute(tool, { path: "feature.txt" }, {
      ledger,
      ctx: ctx(),
      approvals: new AutoGrantProvider(),
    });
    expect(outcome.status).toBe("executed");
    expect(applied()).toBe(true);

    const ev = ledger.getEvents().find((e) => e.tool_name === "danger_tool")!;
    expect(ev.result).toBe("executed");
    expect(ev.policy_decision).toBe("REQUIRE_APPROVAL");
    expect(ev.approval_id).toBeTruthy();
  });
});

// ─── L5 confirmation requirement ──────────────────────────────────────────────

describe("L5 cannot execute without the manual confirmation phrase", () => {
  it("blocks an L5 grant that lacks the confirmation phrase", async () => {
    const { tool, applied } = makeTool(5);
    const outcome = await executor.execute(tool, { path: "wipe.txt" }, {
      ledger,
      ctx: ctx(),
      approvals: new AutoGrantProvider({ confirm: false }),
    });
    expect(outcome.status).toBe("blocked");
    if (outcome.status === "blocked") expect(outcome.reason).toContain("missing_confirmation");
    expect(applied()).toBe(false);
  });

  it("executes an L5 grant that carries the correct confirmation phrase", async () => {
    const { tool } = makeTool(5);
    const outcome = await executor.execute(tool, { path: "wipe.txt" }, {
      ledger,
      ctx: ctx(),
      approvals: new AutoGrantProvider({ confirm: true }),
    });
    expect(outcome.status).toBe("executed");
    const ev = ledger.getEvents().find((e) => e.tool_name === "danger_tool")!;
    expect(ev.policy_decision).toBe("REQUIRE_CONFIRMATION");
    expect(ev.approval_id).toBeTruthy();
  });
});

// ─── verifyGrant: pure scope/expiry/overbreadth checks ────────────────────────

describe("verifyGrant: scope and expiry enforcement", () => {
  const baseReq: ApprovalRequest = {
    action_id: "act-1",
    tool_name: "edit_file",
    permission_level: 4,
    risk_level: "high",
    target: "src/auth/token.ts",
    summary: "edit token.ts",
    data_changed: [],
    rollback_path: "git checkout src/auth/token.ts",
    reason: "implement refresh",
    session_id: "sess-1",
    requested_by: "agent:opencli",
  };

  function goodGrant(over: Partial<ApprovalGrant> = {}): ApprovalGrant {
    const now = Date.now();
    return {
      approval_id: "appr-1",
      action_id: "act-1",
      permission_level: 4,
      approved_by: "user:chris",
      approved_at: new Date(now).toISOString(),
      expires_at: new Date(now + 60_000).toISOString(),
      scope: {
        tools: ["edit_file"],
        path_globs: ["src/auth/*.ts"],
        session_id: "sess-1",
        max_level: 4,
      },
      reason: "implement refresh",
      ...over,
    };
  }

  it("accepts a correctly-scoped, unexpired grant", () => {
    expect(verifyGrant(goodGrant(), baseReq, new Date()).ok).toBe(true);
  });

  it("rejects a grant for a different action", () => {
    const r = verifyGrant(goodGrant({ action_id: "other" }), baseReq, new Date());
    expect(r.ok).toBe(false);
    expect(r.rejection).toBe("action_mismatch");
  });

  it("rejects an expired grant", () => {
    const past = Date.now() - 10_000;
    const grant = goodGrant({
      approved_at: new Date(past - 1000).toISOString(),
      expires_at: new Date(past).toISOString(),
    });
    const r = verifyGrant(grant, baseReq, new Date());
    expect(r.ok).toBe(false);
    expect(r.rejection).toBe("expired");
  });

  it("rejects when the action level exceeds the grant's max_level", () => {
    const grant = goodGrant({ scope: { ...goodGrant().scope, max_level: 3 } });
    const r = verifyGrant(grant, baseReq, new Date());
    expect(r.ok).toBe(false);
    expect(r.rejection).toBe("level_exceeds_grant");
  });

  it("rejects a grant scoped to a different tool", () => {
    const grant = goodGrant({ scope: { ...goodGrant().scope, tools: ["write_file"] } });
    const r = verifyGrant(grant, baseReq, new Date());
    expect(r.ok).toBe(false);
    expect(r.rejection).toBe("scope_tool_mismatch");
  });

  it("rejects a grant whose path globs do not cover the target", () => {
    const grant = goodGrant({ scope: { ...goodGrant().scope, path_globs: ["docs/*.md"] } });
    const r = verifyGrant(grant, baseReq, new Date());
    expect(r.ok).toBe(false);
    expect(r.rejection).toBe("scope_path_mismatch");
  });

  it("rejects a grant bound to a different session", () => {
    const grant = goodGrant({ scope: { ...goodGrant().scope, session_id: "other" } });
    const r = verifyGrant(grant, baseReq, new Date());
    expect(r.ok).toBe(false);
    expect(r.rejection).toBe("scope_session_mismatch");
  });
});

describe("verifyGrant: overbroad scopes are refused (no 'approve everything')", () => {
  const req: ApprovalRequest = {
    action_id: "act-2",
    tool_name: "edit_file",
    permission_level: 4,
    risk_level: "high",
    target: "src/x.ts",
    summary: "edit",
    data_changed: [],
    rollback_path: "none",
    reason: "r",
    session_id: "s",
    requested_by: "agent:opencli",
  };
  function grant(scope: Partial<ApprovalGrant["scope"]>): ApprovalGrant {
    const now = Date.now();
    return {
      approval_id: "a",
      action_id: "act-2",
      permission_level: 4,
      approved_by: "user:chris",
      approved_at: new Date(now).toISOString(),
      expires_at: new Date(now + 60_000).toISOString(),
      scope: {
        tools: ["edit_file"],
        path_globs: ["src/*.ts"],
        session_id: "s",
        max_level: 4,
        ...scope,
      },
      reason: "r",
    };
  }

  it("rejects an empty tool list", () => {
    expect(verifyGrant(grant({ tools: [] }), req, new Date()).rejection).toBe("overbroad_scope");
  });

  it("rejects a wildcard tool", () => {
    expect(verifyGrant(grant({ tools: ["*"] }), req, new Date()).rejection).toBe("overbroad_scope");
  });

  it("rejects a catch-all path glob (**)", () => {
    expect(verifyGrant(grant({ path_globs: ["**"] }), req, new Date()).rejection).toBe(
      "overbroad_scope",
    );
  });

  it("rejects an unbound session", () => {
    expect(verifyGrant(grant({ session_id: "" }), req, new Date()).rejection).toBe(
      "overbroad_scope",
    );
  });

  it("rejects a grant whose lifetime exceeds the TTL cap", () => {
    const now = Date.now();
    const tooLong: ApprovalGrant = {
      ...grant({}),
      approved_at: new Date(now).toISOString(),
      expires_at: new Date(now + MAX_GRANT_TTL_MS + 60_000).toISOString(),
    };
    expect(verifyGrant(tooLong, req, new Date()).rejection).toBe("overbroad_scope");
  });
});

// ─── requiredConfirmationPhrase is action-specific (no replay) ────────────────

describe("requiredConfirmationPhrase", () => {
  const base: ApprovalRequest = {
    action_id: "a",
    tool_name: "delete_file",
    permission_level: 5,
    risk_level: "critical",
    target: "important.txt",
    summary: "delete",
    data_changed: [],
    rollback_path: "restore from backup",
    reason: "r",
    requested_by: "agent:opencli",
  };

  it("embeds the tool and target so it cannot be a generic 'yes'", () => {
    expect(requiredConfirmationPhrase(base)).toBe("CONFIRM delete_file important.txt");
  });

  it("differs for a different target (no cross-action replay)", () => {
    const other = requiredConfirmationPhrase({ ...base, target: "other.txt" });
    expect(other).not.toBe(requiredConfirmationPhrase(base));
  });
});

// ─── write_file destructive content (L5) now has an approval path ─────────────

describe("integration: destructive write_file is approvable with confirmation", () => {
  it("a confirmed L5 grant lets the destructive write proceed", async () => {
    const { writeFileTool } = await import("../src/tools/write_file.js");
    const outcome = await executor.execute(
      writeFileTool,
      { path: "danger.sh", content: "rm -rf /tmp/x\n" },
      { ledger, ctx: ctx(), approvals: new AutoGrantProvider({ confirm: true }) },
    );
    expect(outcome.status).toBe("executed");
    expect(existsSync(join(repo, "danger.sh"))).toBe(true);
    const ev = ledger.getEvents().find((e) => e.tool_name === "write_file")!;
    expect(ev.permission_level).toBe(5);
    expect(ev.approval_id).toBeTruthy();
  });

  it("without confirmation the same write stays blocked and creates no file", async () => {
    const { writeFileTool } = await import("../src/tools/write_file.js");
    const outcome = await executor.execute(
      writeFileTool,
      { path: "danger2.sh", content: "rm -rf /tmp/x\n" },
      { ledger, ctx: ctx(), approvals: new AutoGrantProvider({ confirm: false }) },
    );
    expect(outcome.status).toBe("blocked");
    expect(existsSync(join(repo, "danger2.sh"))).toBe(false);
  });
});
