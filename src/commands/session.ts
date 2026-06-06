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
 * is a destructive action, so it is audited BEFORE it happens and requires an
 * explicit `--yes` confirmation (framework §41 Level 5).
 */

import { Command } from "commander";
import { getDefaultSessionStore } from "../sessions/store.js";
import { getDefaultLedger, AuditWriteError } from "../kernel/audit.js";
import { error, info, warn } from "../lib/ui.js";

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
      if (!meta) {
        error(`no session with id ${id}`);
        process.exitCode = 1;
        return;
      }
      if (!opts.yes) {
        warn(`session ${id} [${meta.status}] — ${String(store.turnCount(id))} turn(s)`);
        warn("deletion is destructive and cannot be undone.");
        warn(`re-run with --yes to confirm: opencli session rm ${id} --yes`);
        process.exitCode = 1;
        return;
      }

      // No-audit-no-action: record the deletion before performing it.
      try {
        getDefaultLedger().appendEvent({
          actor: "user",
          service: "opencli-session",
          action: "session_delete",
          input_source: "user",
          target: `session:${id}`,
          risk_level: "medium",
          permission_level: 3,
          session_id: id,
          correlation_id: meta.correlation_id,
          result: "executed",
          rollback_path: "irreversible (transcript removed; audit ledger retained)",
        });
      } catch (e) {
        if (e instanceof AuditWriteError) {
          error(`refusing to delete: audit write failed (${e.message})`);
          process.exitCode = 1;
          return;
        }
        throw e;
      }

      const removed = store.remove(id);
      if (removed) info(`deleted session ${id}`);
      else {
        error(`failed to delete session ${id}`);
        process.exitCode = 1;
      }
    });
}
