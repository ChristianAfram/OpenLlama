/**
 * Hook config loader — `.opencli/hooks.json`.
 *
 * Coerces untrusted on-disk JSON into a typed HookDefinition[]. Malformed or
 * missing files degrade silently to an empty hook set (no hooks run) — a broken
 * config never crashes a run and never silently disables a kernel control
 * (hooks only ADD restrictions, so "no hooks" is the safe default).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookDefinition, HookEvent } from "./types.js";

const VALID_EVENTS: readonly HookEvent[] = [
  "session_start",
  "pre_tool",
  "post_tool",
  "session_end",
];

export interface HooksConfig {
  hooks: HookDefinition[];
}

/** Load and coerce `.opencli/hooks.json`; returns an empty set on any error. */
export function loadHooksConfig(projectDir: string | null): HooksConfig {
  if (!projectDir) return { hooks: [] };
  const path = join(projectDir, ".opencli", "hooks.json");
  if (!existsSync(path)) return { hooks: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return { hooks: coerceHooks(raw) };
  } catch {
    return { hooks: [] };
  }
}

function coerceHooks(raw: unknown): HookDefinition[] {
  if (typeof raw !== "object" || raw === null) return [];
  const top = raw as Record<string, unknown>;
  const list = Array.isArray(top.hooks) ? top.hooks : [];
  const out: HookDefinition[] = [];

  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;

    if (typeof e.event !== "string" || !VALID_EVENTS.includes(e.event as HookEvent)) continue;
    if (typeof e.command !== "string" || !e.command) continue;

    const def: HookDefinition = {
      event: e.event as HookEvent,
      command: e.command,
    };
    if (Array.isArray(e.args) && e.args.every((a: unknown) => typeof a === "string")) {
      def.args = e.args as string[];
    }
    if (typeof e.matcher === "string" && e.matcher) {
      def.matcher = e.matcher;
    }
    if (typeof e.timeoutMs === "number" && e.timeoutMs > 0 && Number.isFinite(e.timeoutMs)) {
      def.timeoutMs = e.timeoutMs;
    }
    if (typeof e.name === "string" && e.name) {
      def.name = e.name;
    }
    out.push(def);
  }
  return out;
}
