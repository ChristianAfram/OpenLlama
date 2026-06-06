/**
 * MCP server registry config — `.opencli/servers.json`.
 *
 * Each entry declares the subprocess command, whether the server is
 * allowlisted for enterprise use, and an optional default permission floor.
 * Malformed or missing files degrade silently to an empty config; the caller
 * (importer) treats every server as non-allowlisted when config is absent.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface McpServerEntry {
  /** Executable and any fixed flags (e.g. `["npx", "@org/mcp-server"]`). */
  command: string;
  args?: string[];
  /** Extra environment variables for the server process. */
  env?: Record<string, string>;
  /**
   * Whether this server is allowlisted for enterprise mode. In enterprise
   * mode a non-allowlisted server is DENY before any tool-level policy fires.
   */
  allowlisted: boolean;
  /**
   * Permission floor for tools from this server.
   * 4 = REQUIRE_APPROVAL (default), 5 = REQUIRE_CONFIRMATION every time.
   */
  default_level?: 4 | 5;
}

export interface McpServersConfig {
  servers: Record<string, McpServerEntry>;
}

/** Load and coerce `.opencli/servers.json`; returns empty config on any error. */
export function loadMcpServersConfig(projectDir: string | null): McpServersConfig {
  if (!projectDir) return { servers: {} };
  const path = join(projectDir, ".opencli", "servers.json");
  if (!existsSync(path)) return { servers: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return coerce(raw);
  } catch {
    return { servers: {} };
  }
}

function coerce(raw: unknown): McpServersConfig {
  if (typeof raw !== "object" || raw === null) return { servers: {} };
  const top = raw as Record<string, unknown>;
  if (typeof top.servers !== "object" || top.servers === null) return { servers: {} };

  const servers: Record<string, McpServerEntry> = {};
  for (const [name, entry] of Object.entries(top.servers as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.command !== "string") continue;

    const coerced: McpServerEntry = {
      command: e.command,
      allowlisted: e.allowlisted === true,
    };
    if (Array.isArray(e.args) && e.args.every((a: unknown) => typeof a === "string")) {
      coerced.args = e.args as string[];
    }
    if (typeof e.env === "object" && e.env !== null && !Array.isArray(e.env)) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(e.env as Record<string, unknown>)) {
        if (typeof v === "string") env[k] = v;
      }
      if (Object.keys(env).length > 0) coerced.env = env;
    }
    if (e.default_level === 4 || e.default_level === 5) {
      coerced.default_level = e.default_level;
    }
    servers[name] = coerced;
  }
  return { servers };
}
