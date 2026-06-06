import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeScopes,
  coerceScopedConfig,
  loadProjectScope,
  loadLayeredConfig,
  effectiveProfile,
  findProjectDir,
  DEFAULT_CONTEXT_BUDGET,
  type ScopedConfig,
} from "./config-scopes.js";

describe("mergeScopes — precedence", () => {
  it("applies builtin defaults when no scopes override", () => {
    const { effective } = mergeScopes([]);
    expect(effective.activeProfile).toBe("default");
    expect(effective.security.enterprise).toBe(false);
    expect(effective.context.budget).toBe(DEFAULT_CONTEXT_BUDGET);
    expect(effective.context.compaction).toBe("structural");
  });

  it("higher-precedence scope wins for non-locked fields", () => {
    const { effective, origins } = mergeScopes([
      { name: "user", config: { context: { budget: 1000 } } },
      { name: "project", config: { context: { budget: 2000 } } },
      { name: "flag", config: { context: { budget: 3000 } } },
    ]);
    expect(effective.context.budget).toBe(3000);
    expect(origins["context.budget"]).toBe("flag");
  });

  it("merges profiles by name across scopes", () => {
    const { effective } = mergeScopes([
      { name: "user", config: { profiles: { a: { model: "m1", host: "h1" } } } },
      { name: "project", config: { profiles: { b: { model: "m2", host: "h2" } } } },
    ]);
    expect(effective.profiles.a?.model).toBe("m1");
    expect(effective.profiles.b?.model).toBe("m2");
  });
});

describe("mergeScopes — locked security fields (tighten-only)", () => {
  it("project may ENABLE enterprise (tighten)", () => {
    const { effective, origins, rejections } = mergeScopes([
      { name: "user", config: { security: { enterprise: false } } },
      { name: "project", config: { security: { enterprise: true } } },
    ]);
    expect(effective.security.enterprise).toBe(true);
    expect(origins["security.enterprise"]).toBe("project");
    expect(rejections).toHaveLength(0);
  });

  it("project may NOT disable enterprise set by user (loosening rejected)", () => {
    const { effective, rejections } = mergeScopes([
      { name: "user", config: { security: { enterprise: true } } },
      { name: "project", config: { security: { enterprise: false } } },
    ]);
    expect(effective.security.enterprise).toBe(true); // unchanged
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.scope).toBe("project");
    expect(rejections[0]?.field).toBe("security.enterprise");
  });

  it("a flag cannot disable enterprise set by a lower scope either", () => {
    const { effective, rejections } = mergeScopes([
      { name: "project", config: { security: { enterprise: true } } },
      { name: "flag", config: { security: { enterprise: false } } },
    ]);
    expect(effective.security.enterprise).toBe(true);
    expect(rejections).toHaveLength(1);
  });

  it("a flag MAY enable enterprise (tighten from env/flag)", () => {
    const { effective, origins, rejections } = mergeScopes([
      { name: "env", config: {} },
      { name: "flag", config: { security: { enterprise: true } } },
    ]);
    expect(effective.security.enterprise).toBe(true);
    expect(origins["security.enterprise"]).toBe("flag");
    expect(rejections).toHaveLength(0);
  });

  it("denied_paths are a union — a higher scope cannot remove a lower scope's entry", () => {
    const { effective } = mergeScopes([
      { name: "user", config: { security: { denied_paths: ["/etc/**", "secrets/**"] } } },
      { name: "project", config: { security: { denied_paths: ["build/**"] } } }, // omits user's
    ]);
    expect(effective.security.denied_paths).toContain("/etc/**");
    expect(effective.security.denied_paths).toContain("secrets/**");
    expect(effective.security.denied_paths).toContain("build/**");
  });
});

describe("coerceScopedConfig", () => {
  it("drops unknown keys and ill-typed values", () => {
    const c: ScopedConfig = coerceScopedConfig({
      activeProfile: "x",
      profiles: { ok: { model: "m", host: "h" }, bad: { model: 5 } },
      security: { enterprise: "yes", denied_paths: ["a", 7, "b"] },
      context: { budget: -1, compaction: "bogus" },
      junk: { nested: true },
    });
    expect(c.activeProfile).toBe("x");
    expect(c.profiles?.ok).toEqual({ model: "m", host: "h" });
    expect(c.profiles?.bad).toBeUndefined();
    expect(c.security?.enterprise).toBeUndefined(); // "yes" is not a boolean
    expect(c.security?.denied_paths).toEqual(["a", "b"]); // 7 dropped
    expect(c.context).toBeUndefined(); // budget invalid, compaction invalid
  });

  it("returns empty for non-objects", () => {
    expect(coerceScopedConfig(null)).toEqual({});
    expect(coerceScopedConfig("string")).toEqual({});
  });
});

describe("project scope discovery + load", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "opencli-scopes-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds the nearest .opencli ancestor", () => {
    mkdirSync(join(dir, ".opencli"), { recursive: true });
    const nested = join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(findProjectDir(nested)).toBe(dir);
  });

  it("returns null when no .opencli exists", () => {
    expect(findProjectDir(dir)).toBeNull();
  });

  it("loads and coerces a project YAML file", () => {
    mkdirSync(join(dir, ".opencli"), { recursive: true });
    writeFileSync(
      join(dir, ".opencli", "config.yaml"),
      "security:\n  enterprise: true\ncontext:\n  budget: 5000\n",
    );
    const scope = loadProjectScope(dir);
    expect(scope.security?.enterprise).toBe(true);
    expect(scope.context?.budget).toBe(5000);
  });

  it("a syntactically malformed project YAML file does not crash the merge", () => {
    mkdirSync(join(dir, ".opencli"), { recursive: true });
    // Invalid YAML (unterminated flow mapping) — must not throw.
    writeFileSync(join(dir, ".opencli", "config.yaml"), "security: { enterprise: true\n:::\n");
    // loadProjectScope degrades to an empty scope rather than throwing.
    expect(() => loadProjectScope(dir)).not.toThrow();
    expect(loadProjectScope(dir)).toEqual({});
    // The full layered load must also survive a malformed project file.
    expect(() =>
      loadLayeredConfig({ cwd: dir, env: { XDG_CONFIG_HOME: dir } as NodeJS.ProcessEnv }),
    ).not.toThrow();
  });

  it("a malicious project file cannot loosen enterprise set by the user scope", () => {
    // User scope (lower precedence) enables enterprise via the existing JSON config.
    mkdirSync(join(dir, "openllama"), { recursive: true });
    writeFileSync(
      join(dir, "openllama", "config.json"),
      JSON.stringify({ security: { enterprise: true } }),
    );
    // Project scope (higher precedence) tries to disable it.
    mkdirSync(join(dir, ".opencli"), { recursive: true });
    writeFileSync(join(dir, ".opencli", "config.yaml"), "security:\n  enterprise: false\n");

    const { effective, rejections } = loadLayeredConfig({
      cwd: dir,
      env: { XDG_CONFIG_HOME: dir } as NodeJS.ProcessEnv,
    });
    // User enabled it; project's attempt to disable is ignored and recorded.
    expect(effective.security.enterprise).toBe(true);
    expect(rejections.some((r) => r.scope === "project")).toBe(true);
  });
});

describe("effectiveProfile", () => {
  it("prefers OPENCLI_* env over stored profile", () => {
    const { effective } = mergeScopes([
      { name: "user", config: { profiles: { default: { model: "stored", host: "h" } } } },
    ]);
    const p = effectiveProfile(effective, {
      OPENCLI_MODEL: "env-model",
      OPENCLI_HOST: "http://env:1",
    } as NodeJS.ProcessEnv);
    expect(p.model).toBe("env-model");
    expect(p.host).toBe("http://env:1");
  });

  it("falls back to legacy OPENLLAMA_MODEL / OLLAMA_HOST", () => {
    const { effective } = mergeScopes([]);
    const p = effectiveProfile(effective, {
      OPENLLAMA_MODEL: "legacy",
      OLLAMA_HOST: "http://legacy:2",
    } as NodeJS.ProcessEnv);
    expect(p.model).toBe("legacy");
    expect(p.host).toBe("http://legacy:2");
  });
});
