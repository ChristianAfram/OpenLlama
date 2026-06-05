/**
 * Kill switch — global halt for all mutating tools.
 *
 * When active, every attempt to execute a mutating tool is blocked before any
 * side effect or audit write is attempted. The kill switch is persisted to disk
 * so it survives process restarts and is detectable from outside the process.
 *
 * Automated triggers (wired in the reasoning engine):
 *   - N consecutive policy denials in a single session (default 5)
 *   - Total-token cap breach
 *   - Audit-write failure
 *
 * Manual controls:
 *   openllama kill-switch status
 *   openllama kill-switch activate [--reason "..."]
 *   openllama kill-switch deactivate
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

export type KillSwitchTrigger =
  | "manual"
  | "consecutive_denials"
  | "cost_cap"
  | "audit_failure";

export interface KillSwitchState {
  active: boolean;
  reason: string;
  triggered_by: KillSwitchTrigger;
  activated_at: string; // ISO8601; empty when inactive
}

const INACTIVE: KillSwitchState = {
  active: false,
  reason: "",
  triggered_by: "manual",
  activated_at: "",
};

export class KillSwitch {
  constructor(readonly statePath: string) {}

  getState(): KillSwitchState {
    try {
      const raw = readFileSync(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as KillSwitchState;
      return typeof parsed?.active === "boolean" ? parsed : { ...INACTIVE };
    } catch {
      return { ...INACTIVE };
    }
  }

  isActive(): boolean {
    return this.getState().active;
  }

  activate(reason: string, triggered_by: KillSwitchTrigger = "manual"): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const state: KillSwitchState = {
      active: true,
      reason,
      triggered_by,
      activated_at: new Date().toISOString(),
    };
    writeFileSync(this.statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  }

  deactivate(): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(
      this.statePath,
      JSON.stringify({ ...INACTIVE }, null, 2) + "\n",
      "utf8",
    );
  }
}

let _default: KillSwitch | undefined;

export function getDefaultKillSwitch(): KillSwitch {
  if (!_default) {
    const configDir =
      process.env["OPENLLAMA_CONFIG_DIR"] ??
      `${homedir()}/.config/openllama`;
    _default = new KillSwitch(`${configDir}/kill-switch.json`);
  }
  return _default;
}

/** Reset the module-level singleton — test helper only. */
export function _resetDefaultKillSwitch(): void {
  _default = undefined;
}
