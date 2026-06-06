/**
 * Filesystem path for the session store.
 *
 * Operator state (resumable transcripts) lives under the XDG data dir alongside
 * the audit ledger and snapshots. The legacy `openllama` dir name is retained
 * for v0.7→v0.8 continuity; the rename to `opencli` is a separate, fallback-
 * aware migration (it must not orphan the append-only audit ledger).
 */

import { homedir } from "node:os";
import { join } from "node:path";

export function defaultSessionDbPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCLI_SESSION_DB) return env.OPENCLI_SESSION_DB;
  const base = env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(base, "openllama", "sessions.sqlite");
}
