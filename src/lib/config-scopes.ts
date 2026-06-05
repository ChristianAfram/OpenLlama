/**
 * Layered, governed configuration for OpenCLI (v0.8 — Config Scopes).
 *
 * Effective configuration is a deterministic merge of up to five scopes, in
 * increasing precedence:
 *
 *   builtin  <  user  <  project  <  env  <  flag
 *
 * The `[security]` group is GOVERNED ("locked"): a higher-precedence scope may
 * only *tighten* a security control, never *loosen* it. This is the structural
 * guarantee that a checked-in project file (`.opencli/config.yaml`) — which an
 * untrusted contributor could edit — can raise the security posture but can
 * never weaken the protections a user or the built-in defaults established.
 *
 * Locked-field semantics:
 *   security.enterprise   boolean — tighten = enable. Effective = OR of scopes.
 *                         A scope setting `false` over a lower `true` is a
 *                         loosening attempt: ignored and recorded as a rejection.
 *   security.denied_paths string[] — tighten = add. Effective = union of scopes.
 *                         A scope cannot remove a path a lower scope denied.
 *
 * Non-locked fields (profiles, activeProfile, context.*) follow plain
 * last-writer-wins precedence.
 *
 * Merge-time enforcement is the primary control: loosening attempts are dropped
 * and surfaced as `ConfigRejection`s so they can be logged/audited. The merge
 * never throws — a malicious project file degrades to "no effect", not a crash.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { DEFAULT_MODEL, DEFAULT_PROFILE, configPath, type Profile } from "./config.js";

/** A configuration scope, lowest to highest precedence. */
export type ConfigScopeName = "builtin" | "user" | "project" | "env" | "flag";

/** Precedence order (index = precedence; later wins). */
export const SCOPE_ORDER: ConfigScopeName[] = ["builtin", "user", "project", "env", "flag"];

export const DEFAULT_CONTEXT_BUDGET = 24_000;
export type CompactionStrategy = "structural" | "model";

export interface SecuritySettings {
  /** Enterprise hard-block mode. Locked: may be tightened (enabled), never loosened. */
  enterprise: boolean;
  /** Globally denied path globs. Locked: union across scopes; never removed by a higher scope. */
  denied_paths: string[];
}

export interface ContextSettings {
  /** Token budget before compaction kicks in. */
  budget: number;
  /** Compaction strategy: deterministic structural pruning, or optional model summary. */
  compaction: CompactionStrategy;
}

/** A single scope's (partial) contribution to the effective config. */
export interface ScopedConfig {
  activeProfile?: string;
  profiles?: Record<string, Profile>;
  security?: Partial<SecuritySettings>;
  context?: Partial<ContextSettings>;
}

/** Fully-resolved configuration after merging all scopes. */
export interface EffectiveConfig {
  activeProfile: string;
  profiles: Record<string, Profile>;
  security: SecuritySettings;
  context: ContextSettings;
}

/** A scope's attempt to loosen a locked control that was ignored by the merge. */
export interface ConfigRejection {
  scope: ConfigScopeName;
  field: string;
  reason: string;
}

export interface MergeResult {
  effective: EffectiveConfig;
  /** Origin scope for governed/locked fields (audit trail). */
  origins: Record<string, ConfigScopeName>;
  /** Loosening attempts that were dropped. Empty when all scopes are well-behaved. */
  rejections: ConfigRejection[];
}

/** Names of locked security fields, for documentation/audit. */
export const LOCKED_FIELDS = ["security.enterprise", "security.denied_paths"] as const;

function builtinScope(): ScopedConfig {
  return {
    activeProfile: "default",
    profiles: { default: { ...DEFAULT_PROFILE } },
    security: { enterprise: false, denied_paths: [] },
    context: { budget: DEFAULT_CONTEXT_BUDGET, compaction: "structural" },
  };
}

/**
 * Merge an ordered list of scopes into one effective config. Lower-precedence
 * scopes come first. Locked security fields are tighten-only; loosening attempts
 * are dropped and recorded.
 */
export function mergeScopes(
  scopes: { name: ConfigScopeName; config: ScopedConfig }[],
): MergeResult {
  const base = builtinScope();
  const effective: EffectiveConfig = {
    activeProfile: base.activeProfile ?? "default",
    profiles: { ...base.profiles },
    security: { enterprise: false, denied_paths: [] },
    context: { budget: DEFAULT_CONTEXT_BUDGET, compaction: "structural" },
  };
  const origins: Record<string, ConfigScopeName> = {};
  const rejections: ConfigRejection[] = [];

  for (const { name, config } of scopes) {
    // ── Non-locked: last-writer-wins ──────────────────────────────────────
    if (config.activeProfile !== undefined) {
      effective.activeProfile = config.activeProfile;
      origins.activeProfile = name;
    }
    if (config.profiles) {
      for (const [pname, profile] of Object.entries(config.profiles)) {
        effective.profiles[pname] = { ...profile };
      }
    }
    if (config.context) {
      if (config.context.budget !== undefined) {
        effective.context.budget = config.context.budget;
        origins["context.budget"] = name;
      }
      if (config.context.compaction !== undefined) {
        effective.context.compaction = config.context.compaction;
        origins["context.compaction"] = name;
      }
    }

    // ── Locked: security.enterprise (tighten = enable) ────────────────────
    if (config.security?.enterprise !== undefined) {
      if (config.security.enterprise) {
        if (!effective.security.enterprise) {
          effective.security.enterprise = true;
          origins["security.enterprise"] = name;
        }
      } else if (effective.security.enterprise) {
        // A higher scope tried to DISABLE enterprise that a lower scope enabled.
        rejections.push({
          scope: name,
          field: "security.enterprise",
          reason:
            "project/override scope cannot disable enterprise mode set by a lower scope",
        });
      }
      // false over false is a no-op (not a rejection).
    }

    // ── Locked: security.denied_paths (tighten = add; union) ──────────────
    if (config.security?.denied_paths !== undefined) {
      for (const p of config.security.denied_paths) {
        if (!effective.security.denied_paths.includes(p)) {
          effective.security.denied_paths.push(p);
          origins[`security.denied_paths:${p}`] = name;
        }
      }
    }
  }

  return { effective, origins, rejections };
}

/** Walk up from `start` to find the nearest directory containing `.opencli/`. */
export function findProjectDir(start: string): string | null {
  let dir = start;
  // Bounded walk to filesystem root.
  for (;;) {
    if (existsSync(join(dir, ".opencli"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Path to a project's `.opencli/config.yaml`, given the project root. */
export function projectConfigPath(projectDir: string): string {
  return join(projectDir, ".opencli", "config.yaml");
}

/**
 * Parse an untrusted config document (object) into a ScopedConfig, keeping only
 * recognised, well-typed fields. Unknown keys and ill-typed values are dropped
 * — a malformed scope contributes nothing rather than corrupting the merge.
 */
export function coerceScopedConfig(raw: unknown): ScopedConfig {
  const out: ScopedConfig = {};
  if (raw === null || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.activeProfile === "string") out.activeProfile = obj.activeProfile;

  if (obj.profiles && typeof obj.profiles === "object") {
    const profiles: Record<string, Profile> = {};
    for (const [k, v] of Object.entries(obj.profiles as Record<string, unknown>)) {
      if (v && typeof v === "object") {
        const p = v as Record<string, unknown>;
        if (typeof p.model === "string" && typeof p.host === "string") {
          profiles[k] = { model: p.model, host: p.host };
        }
      }
    }
    if (Object.keys(profiles).length > 0) out.profiles = profiles;
  }

  if (obj.security && typeof obj.security === "object") {
    const s = obj.security as Record<string, unknown>;
    const security: Partial<SecuritySettings> = {};
    if (typeof s.enterprise === "boolean") security.enterprise = s.enterprise;
    if (Array.isArray(s.denied_paths)) {
      security.denied_paths = s.denied_paths.filter((x): x is string => typeof x === "string");
    }
    if (Object.keys(security).length > 0) out.security = security;
  }

  if (obj.context && typeof obj.context === "object") {
    const c = obj.context as Record<string, unknown>;
    const context: Partial<ContextSettings> = {};
    if (typeof c.budget === "number" && Number.isFinite(c.budget) && c.budget > 0) {
      context.budget = c.budget;
    }
    if (c.compaction === "structural" || c.compaction === "model") {
      context.compaction = c.compaction;
    }
    if (Object.keys(context).length > 0) out.context = context;
  }

  return out;
}

/** Load the user-scope config (existing JSON file) as a ScopedConfig. */
export function loadUserScope(env: NodeJS.ProcessEnv = process.env): ScopedConfig {
  const path = configPath(env);
  if (!existsSync(path)) return {};
  try {
    return coerceScopedConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

/** Load the project-scope config (`.opencli/config.yaml`) as a ScopedConfig. */
export function loadProjectScope(cwd: string): ScopedConfig {
  const projectDir = findProjectDir(cwd);
  if (!projectDir) return {};
  const path = projectConfigPath(projectDir);
  if (!existsSync(path)) return {};
  try {
    return coerceScopedConfig(parseYaml(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

/** Derive the env-scope config from environment variables (security tightening only). */
export function loadEnvScope(env: NodeJS.ProcessEnv = process.env): ScopedConfig {
  const out: ScopedConfig = {};
  // OPENCLI_ENTERPRISE=1/true tightens; it can never disable a lower scope.
  const ent = env.OPENCLI_ENTERPRISE;
  if (ent === "1" || ent?.toLowerCase() === "true") {
    out.security = { enterprise: true };
  }
  return out;
}

/** Options that can be supplied by CLI flags (highest precedence scope). */
export interface FlagScopeInput {
  enterprise?: boolean;
  contextBudget?: number;
  compaction?: CompactionStrategy;
}

export function flagScope(flags: FlagScopeInput): ScopedConfig {
  const out: ScopedConfig = {};
  if (flags.enterprise) out.security = { enterprise: true };
  const context: Partial<ContextSettings> = {};
  if (flags.contextBudget !== undefined) context.budget = flags.contextBudget;
  if (flags.compaction !== undefined) context.compaction = flags.compaction;
  if (Object.keys(context).length > 0) out.context = context;
  return out;
}

/**
 * Resolve the full effective configuration for a given cwd + env + CLI flags.
 * This is the single entry point commands should use to read governed settings.
 */
export function loadLayeredConfig(opts: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  flags?: FlagScopeInput;
}): MergeResult {
  const env = opts.env ?? process.env;
  return mergeScopes([
    { name: "builtin", config: builtinScope() },
    { name: "user", config: loadUserScope(env) },
    { name: "project", config: loadProjectScope(opts.cwd) },
    { name: "env", config: loadEnvScope(env) },
    { name: "flag", config: flagScope(opts.flags ?? {}) },
  ]);
}

/** Resolve the effective profile from an EffectiveConfig (model/host env overrides applied). */
export function effectiveProfile(
  config: EffectiveConfig,
  env: NodeJS.ProcessEnv = process.env,
): Profile {
  const base = config.profiles[config.activeProfile] ?? { ...DEFAULT_PROFILE };
  const envModel = env.OPENCLI_MODEL ?? env.OPENLLAMA_MODEL;
  const envHost = env.OPENCLI_HOST ?? env.OLLAMA_HOST;
  return {
    model: envModel && envModel.length > 0 ? envModel : (base.model || DEFAULT_MODEL),
    host: envHost && envHost.length > 0 ? envHost : base.host,
  };
}
