/**
 * Config and profiles for OpenLlama.
 *
 * Stored as JSON under `~/.config/openllama` (XDG-aware). A profile names the
 * model and Ollama host to use. Read helpers are pure and accept an explicit
 * directory so they can be unit-tested against a temp dir.
 *
 * Environment overrides (highest precedence at resolve time):
 *   OLLAMA_HOST       -> profile.host
 *   OPENLLAMA_MODEL   -> profile.model
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_OLLAMA_HOST } from "./ollama.js";

export interface Profile {
  model: string;
  host: string;
}

export interface OpenLlamaConfig {
  activeProfile: string;
  profiles: Record<string, Profile>;
}

export const DEFAULT_MODEL = "qwen2.5-coder:7b";

export const DEFAULT_PROFILE: Profile = {
  model: DEFAULT_MODEL,
  host: DEFAULT_OLLAMA_HOST,
};

export const DEFAULT_CONFIG: OpenLlamaConfig = {
  activeProfile: "default",
  profiles: { default: { ...DEFAULT_PROFILE } },
};

/** Resolve the config directory, honoring XDG_CONFIG_HOME. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "openllama");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "config.json");
}

/** Load config from an explicit path, falling back to defaults if absent/invalid. */
export function loadConfigFrom(path: string): OpenLlamaConfig {
  if (!existsSync(path)) {
    return structuredClone(DEFAULT_CONFIG);
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<OpenLlamaConfig>;
    return normalizeConfig(parsed);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

/** Persist config to an explicit path, creating the directory if needed. */
export function saveConfigTo(dir: string, config: OpenLlamaConfig): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
}

/** Load the config from the resolved user config path. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): OpenLlamaConfig {
  return loadConfigFrom(configPath(env));
}

/**
 * Resolve the effective profile: the active profile from config, with
 * environment-variable overrides applied.
 */
export function resolveProfile(
  config: OpenLlamaConfig,
  env: NodeJS.ProcessEnv = process.env,
): Profile {
  const base = config.profiles[config.activeProfile] ?? DEFAULT_PROFILE;
  return {
    model: env.OPENLLAMA_MODEL && env.OPENLLAMA_MODEL.length > 0 ? env.OPENLLAMA_MODEL : base.model,
    host: env.OLLAMA_HOST && env.OLLAMA_HOST.length > 0 ? env.OLLAMA_HOST : base.host,
  };
}

function normalizeConfig(parsed: Partial<OpenLlamaConfig>): OpenLlamaConfig {
  const profiles =
    parsed.profiles && typeof parsed.profiles === "object"
      ? parsed.profiles
      : structuredClone(DEFAULT_CONFIG.profiles);
  const activeProfile =
    parsed.activeProfile && parsed.activeProfile in profiles
      ? parsed.activeProfile
      : (Object.keys(profiles)[0] ?? "default");
  return { activeProfile, profiles };
}
