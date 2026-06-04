import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  DEFAULT_MODEL,
  loadConfigFrom,
  resolveProfile,
  saveConfigTo,
  configDir,
} from "./config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openllama-cfg-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("config round-trip", () => {
  it("returns defaults when no file exists", () => {
    const cfg = loadConfigFrom(join(dir, "config.json"));
    expect(cfg.activeProfile).toBe("default");
    expect(cfg.profiles.default?.model).toBe(DEFAULT_MODEL);
  });

  it("persists and reloads a profile", () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.profiles.default = { model: "custom:13b", host: "http://example:11434" };
    saveConfigTo(dir, cfg);

    const reloaded = loadConfigFrom(join(dir, "config.json"));
    expect(reloaded.profiles.default?.model).toBe("custom:13b");
    expect(reloaded.profiles.default?.host).toBe("http://example:11434");
  });

  it("falls back to defaults on malformed json", () => {
    saveConfigTo(dir, DEFAULT_CONFIG);
    // Corrupt the file.
    const path = join(dir, "config.json");
    rmSync(path);
    writeFileSync(path, "{not json");
    const cfg = loadConfigFrom(path);
    expect(cfg.activeProfile).toBe("default");
  });
});

describe("resolveProfile env overrides", () => {
  it("prefers env vars over the stored profile", () => {
    const profile = resolveProfile(DEFAULT_CONFIG, {
      OPENLLAMA_MODEL: "env-model",
      OLLAMA_HOST: "http://env-host:1234",
    } as NodeJS.ProcessEnv);
    expect(profile.model).toBe("env-model");
    expect(profile.host).toBe("http://env-host:1234");
  });

  it("uses the stored profile when env vars are absent", () => {
    const profile = resolveProfile(DEFAULT_CONFIG, {} as NodeJS.ProcessEnv);
    expect(profile.model).toBe(DEFAULT_MODEL);
  });
});

describe("configDir", () => {
  it("honors XDG_CONFIG_HOME", () => {
    const d = configDir({ XDG_CONFIG_HOME: "/tmp/xdg" } as NodeJS.ProcessEnv);
    expect(d).toBe("/tmp/xdg/openllama");
  });
});
