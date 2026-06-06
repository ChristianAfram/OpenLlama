/**
 * `opencli session` sub-commands — inspect and manage resumable sessions.
 *
 *   session list              – sessions, most recently updated first
 *   session show <id>         – session metadata + (redacted) transcript
 *   session rm <id> --yes     – delete a session (destructive; audited first)
 *
 * The session store is operator state, not the compliance record. Deleting a
 * session removes a resume transcript only; the authoritative audit ledger
 * (joined by correlation_id) is append-only and is never touched here. Deletion
 * destroys operator history, so it is a **Level 5** action (framework §41): it
 * is audited as `permission_level: 5` / `risk_level: critical` BEFORE it happens
 * and requires an explicit `--yes` manual confirmation every time. The governed
 * core lives in `deleteSessionGoverned` so the no-audit-no-action and
 * confirmation invariants can be unit-tested directly.
 */

import { Command } from "commander";
import { getDefaultSessionStore, type SessionStore } from "../sessions/store.js";
import { getDefaultLedger, AuditWriteError, type AuditLedger } from "../kernel/audit.js";
import { error, info, warn } from "../lib/ui.js";

/** Dependencies for governed session deletion (injectable for testing). */
export interface DeleteDeps {
  store: Pick<SessionStore, "get" | "turnCount" | "remove">;
  ledger: Pick<AuditLedger, "appendEvent">;
}

export type DeleteResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "confirmation_required" | "audit_failed" | "remove_failed" };

/**
 * Governed session-transcript deletion (framework §41 Level 5).
 *
 * Deleting a session destroys operator history, debugging context, and resume
 * state. Per §41, deleting database records is a **Level 5** action: it requires
 * an explicit, manual confirmation every time and must never execute
 * automatically. We model that here:
 *
 *   - `confirmed` (the `--yes` flag at the CLI) is the manual confirmation. With
 *     it false, nothing is audited and nothing is deleted.
 *   - No-audit-no-action: the L5 audit event is written BEFORE `store.remove`.
 *     If the audit write fails, the transcript is NOT removed.
 *
 * The authoritative audit ledger (joined by correlation_id) is append-only and
 * is never touched here — only the resume transcript is removed.
 */
export function deleteSessionGoverned(
  deps: DeleteDeps,
  id: string,
  confirmed: boolean,
): DeleteResult {
  const meta = deps.store.get(id);
  if (!meta) return { ok: false, reason: "not_found" };

  // Level 5: manual confirmation required every time. No confirmation → no
  // audit, no mutation.
  if (!confirmed) return { ok: false, reason: "confirmation_required" };

  // No-audit-no-action: record the deletion before performing it.
  try {
    deps.ledger.appendEvent({
      actor: "user",
      service: "opencli-session",
      action: "session_delete",
      input_source: "user",
      target: `session:${id}`,
      risk_level: "critical",
      permission_level: 5,
      policy_decision: "REQUIRE_CONFIRMATION",
      policy_reason: "session transcript deletion destroys operator history (Level 5)",
      session_id: id,
      correlation_id: meta.correlation_id,
      result: "executed",
      rollback_path: "irreversible (transcript removed; audit ledger retained)",
    });
  } catch (e) {
    if (e instanceof AuditWriteError) return { ok: false, reason: "audit_failed" };
    throw e;
  }

  return deps.store.remove(id) ? { ok: true } : { ok: false, reason: "remove_failed" };
}

export function registerSessionCommand(program: Command): void {
  const session = program
    .command("session")
    .description("Inspect and manage resumable agent sessions");

  // ── list ────────────────────────────────────────────────────────────────
  session
    .command("list")
    .description("List sessions, most recently updated first")
    .action(() => {
      const store = getDefaultSessionStore();
      const sessions = store.list();
      if (sessions.length === 0) {
        process.stdout.write("No sessions recorded.\n");
        return;
      }
      process.stdout.write(`${sessions.length} session(s)\n${"─".repeat(60)}\n`);
      for (const s of sessions) {
        const turns = store.turnCount(s.session_id);
        process.stdout.write(
          `${s.session_id}  [${s.status}]\n` +
            `  updated: ${s.updated_at}  model: ${s.model}\n` +
            `  cwd: ${s.cwd}\n` +
            `  turns: ${String(turns)}  tokens: ${String(
              s.total_input_tokens + s.total_output_tokens,
            )}  correlation: ${s.correlation_id}\n\n`,
        );
      }
    });

  // ── show ────────────────────────────────────────────────────────────────
  session
    .command("show")
    .description("Show a session's metadata and (redacted) transcript")
    .argument("<id>", "session id")
    .action((id: string) => {
      const store = getDefaultSessionStore();
      const meta = store.get(id);
      if (!meta) {
        error(`no session with id ${id}`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        `session ${meta.session_id} [${meta.status}]\n` +
          `correlation: ${meta.correlation_id}\n` +
          `created: ${meta.created_at}  updated: ${meta.updated_at}\n` +
          `model: ${meta.model}  prompt: ${meta.prompt_version}\n` +
          `cwd: ${meta.cwd}\n` +
          `tokens: in=${String(meta.total_input_tokens)} out=${String(meta.total_output_tokens)}\n` +
          `stop_reason: ${meta.stop_reason ?? "—"}\n${"─".repeat(60)}\n`,
      );
      for (const t of store.getTurns(id)) {
        const label = t.role === "tool_result" ? `tool_result(${t.tool_name ?? "?"})` : t.role;
        process.stdout.write(`[${label}]\n${t.content}\n\n`);
      }
    });

  // ── rm ──────────────────────────────────────────────────────────────────
  session
    .command("rm")
    .description("Delete a session and its transcript (destructive)")
    .argument("<id>", "session id")
    .option("--yes", "confirm deletion (required)")
    .action((id: string, opts: { yes?: boolean }) => {
      const store = getDefaultSessionStore();
      const meta = store.get(id);
      // Render the pre-confirmation warning before delegating, so the operator
      // sees what they are about to destroy and how to confirm.
      if (meta && !opts.yes) {
        warn(`session ${id} [${meta.status}] — ${String(store.turnCount(id))} turn(s)`);
        warn("deletion is destructive and cannot be undone (Level 5).");
        warn(`re-run with --yes to confirm: opencli session rm ${id} --yes`);
      }

      const result = deleteSessionGoverned(
        { store, ledger: getDefaultLedger() },
        id,
        opts.yes === true,
      );

      if (result.ok) {
        info(`deleted session ${id}`);
        return;
      }
      switch (result.reason) {
        case "not_found":
          error(`no session with id ${id}`);
          break;
        case "confirmation_required":
          // Warning already printed above.
          break;
        case "audit_failed":
          error("refusing to delete: audit write failed (no-audit-no-action)");
          break;
        case "remove_failed":
          error(`failed to delete session ${id}`);
          break;
      }
      process.exitCode = 1;
    });
}
