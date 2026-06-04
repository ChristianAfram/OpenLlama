/**
 * Interactive, human-driven approval provider for the CLI.
 *
 * Presents the full approval request (framework §42: what happens, what data is
 * used/changed, who receives it, how to undo, risk, scope, expiry) and reads a
 * decision from a readline interface. Level 4 needs a "yes"; Level 5 additionally
 * requires the human to type the exact confirmation phrase for THIS action.
 *
 * The grant it builds is narrow by construction: scoped to the single tool, the
 * single target path, the current session, and a short expiry — never a blanket
 * "approve everything." This is the only place a human decision becomes a grant.
 */

import { randomUUID } from "node:crypto";
import { createInterface, type Interface } from "node:readline";
import type {
  ApprovalDecision,
  ApprovalGrant,
  ApprovalProvider,
  ApprovalRequest,
} from "./approval.js";
import { requiredConfirmationPhrase } from "./approval.js";

export interface CliApprovalOptions {
  /** Identity recorded as `approved_by`. */
  approver?: string;
  /** Grant lifetime in milliseconds (default 5 minutes). */
  ttlMs?: number;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class CliApprovalProvider implements ApprovalProvider {
  private readonly approver: string;
  private readonly ttlMs: number;
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;

  constructor(opts: CliApprovalOptions = {}) {
    this.approver = opts.approver ?? "user:cli";
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.input = opts.input ?? process.stdin;
    this.output = opts.output ?? process.stderr;
  }

  async requestApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
    // A non-interactive stream cannot approve — deny rather than hang or
    // auto-approve. This keeps piped/CI invocations safe by default.
    const tty = (this.input as NodeJS.ReadStream).isTTY;
    if (tty === false) {
      return { status: "denied", reason: "no interactive terminal to obtain approval" };
    }

    this.print(this.renderRequest(req));

    const rl = createInterface({ input: this.input, output: this.output, terminal: false });
    try {
      const answer = (await question(rl, "Approve this action? (yes/no): ")).trim().toLowerCase();
      if (answer !== "yes" && answer !== "y") {
        return { status: "denied", reason: "operator declined" };
      }

      let confirmationPhrase: string | undefined;
      if (req.permission_level >= 5) {
        const required = requiredConfirmationPhrase(req);
        this.print(
          `\nLevel 5 action. To confirm, type exactly:\n  ${required}\n`,
        );
        const typed = (await question(rl, "Confirmation: ")).trim();
        if (typed !== required) {
          return { status: "denied", reason: "confirmation phrase did not match" };
        }
        confirmationPhrase = typed;
      }

      return { status: "granted", grant: this.buildGrant(req, confirmationPhrase) };
    } finally {
      rl.close();
    }
  }

  private buildGrant(req: ApprovalRequest, confirmationPhrase?: string): ApprovalGrant {
    const now = new Date();
    const expires = new Date(now.getTime() + this.ttlMs);
    return {
      approval_id: randomUUID(),
      action_id: req.action_id,
      permission_level: req.permission_level,
      approved_by: this.approver,
      approved_at: now.toISOString(),
      expires_at: expires.toISOString(),
      scope: {
        tools: [req.tool_name],
        path_globs: req.target ? [req.target] : ["__no_target__"],
        session_id: req.session_id ?? "__no_session__",
        max_level: req.permission_level,
      },
      reason: req.reason,
      rollback_path: req.rollback_path,
      ...(confirmationPhrase ? { confirmation_phrase: confirmationPhrase } : {}),
    };
  }

  private renderRequest(req: ApprovalRequest): string {
    const lines = [
      "",
      "─── APPROVAL REQUIRED ─────────────────────────────────────────",
      `  action:    ${req.tool_name}  (level ${String(req.permission_level)} / ${req.risk_level})`,
      `  what:      ${req.summary}`,
      ...(req.target ? [`  target:    ${req.target}`] : []),
      `  reason:    ${req.reason}`,
      `  rollback:  ${req.rollback_path}`,
      `  requested: ${req.requested_by}`,
      ...(req.session_id ? [`  session:   ${req.session_id}`] : []),
      "───────────────────────────────────────────────────────────────",
    ];
    return lines.join("\n");
  }

  private print(s: string): void {
    this.output.write(s + "\n");
  }
}

function question(rl: Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}
