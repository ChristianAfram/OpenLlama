/**
 * A scripted approval provider for tests: grants the exact request it receives
 * (correctly-scoped, short-lived). Usable for any L4 tool that needs approval
 * in a test environment without a human at the terminal.
 */

import type {
  ApprovalDecision,
  ApprovalProvider,
  ApprovalRequest,
} from "../../src/kernel/approval.js";

export function faithfulProvider(sessionId: string, pathGlob = "**"): ApprovalProvider {
  return {
    requestApproval(req: ApprovalRequest): ApprovalDecision {
      return {
        status: "granted",
        grant: {
          approval_id: `ap-test-${Math.random().toString(36).slice(2)}`,
          action_id: req.action_id,
          permission_level: 4,
          approved_by: "human:test",
          approved_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          scope: {
            tools: [req.tool_name],
            path_globs: [pathGlob],
            session_id: sessionId,
            max_level: 4,
          },
          reason: "test approval",
          rollback_path: "n/a",
        },
      };
    },
  };
}
