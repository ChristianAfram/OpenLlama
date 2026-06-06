/**
 * Skill registry + use_skill tool unit tests (v0.8 — B6).
 *
 * Proves:
 *   - discovery from .opencli/skills/<name>/SKILL.md; frontmatter parsed.
 *   - name mismatch (frontmatter name != dir slug) is rejected.
 *   - malformed frontmatter / missing file → skipped, never crashes.
 *   - load() rejects path traversal / non-slug names.
 *   - body is returned without the frontmatter.
 *   - use_skill tool: lists skills in description; returns body; errors on unknown.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRegistry } from "../src/skills/registry.js";
import { makeUseSkillTool } from "../src/tools/use_skill.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencli-skills-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeSkill(name: string, frontmatter: string, body: string): void {
  const d = join(dir, ".opencli", "skills", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\n${frontmatter}\n---\n${body}\n`);
}

// ─── discovery ──────────────────────────────────────────────────────────────────

describe("SkillRegistry.fromProjectDir", () => {
  it("returns empty registry with no project dir / no skills dir", () => {
    expect(SkillRegistry.fromProjectDir(null).list()).toHaveLength(0);
    expect(SkillRegistry.fromProjectDir(dir).list()).toHaveLength(0);
  });

  it("discovers skills and parses frontmatter", () => {
    writeSkill("deploy", 'name: deploy\ndescription: Deploy steps\nversion: "2"', "Deploy body.");
    writeSkill("review", "name: review\ndescription: Review steps", "Review body.");
    const reg = SkillRegistry.fromProjectDir(dir);
    const list = reg.list();
    expect(list).toHaveLength(2);
    expect(list[0]!.name).toBe("deploy"); // sorted
    expect(list[0]!.description).toBe("Deploy steps");
    expect(list[0]!.version).toBe("2");
    expect(list[1]!.name).toBe("review");
  });

  it("defaults name to dir slug when frontmatter omits it", () => {
    writeSkill("helper", "description: Helps", "Body.");
    const reg = SkillRegistry.fromProjectDir(dir);
    expect(reg.has("helper")).toBe(true);
  });

  it("rejects a skill whose frontmatter name != dir slug", () => {
    writeSkill("realname", "name: fakename\ndescription: sneaky", "Body.");
    const reg = SkillRegistry.fromProjectDir(dir);
    expect(reg.list()).toHaveLength(0);
  });

  it("skips a non-slug directory name", () => {
    const d = join(dir, ".opencli", "skills", "Bad Name!");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), "---\ndescription: x\n---\nbody");
    expect(SkillRegistry.fromProjectDir(dir).list()).toHaveLength(0);
  });

  it("skips malformed frontmatter without crashing", () => {
    writeSkill("ok", "description: Fine", "Body.");
    const d = join(dir, ".opencli", "skills", "broken");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), "no frontmatter here at all");
    const reg = SkillRegistry.fromProjectDir(dir);
    expect(reg.list().map((s) => s.name)).toEqual(["ok"]);
  });
});

// ─── load ──────────────────────────────────────────────────────────────────────

describe("SkillRegistry.load", () => {
  it("returns the body without frontmatter", () => {
    writeSkill("deploy", "description: Deploy", "Line one.\nLine two.");
    const reg = SkillRegistry.fromProjectDir(dir);
    const skill = reg.load("deploy");
    expect(skill).not.toBeNull();
    expect(skill!.body).toBe("Line one.\nLine two.");
    expect(skill!.body).not.toContain("---");
    expect(skill!.body).not.toContain("description:");
  });

  it("returns null for unknown skills", () => {
    expect(SkillRegistry.fromProjectDir(dir).load("ghost")).toBeNull();
  });

  it("rejects path traversal and non-slug names", () => {
    writeSkill("valid", "description: v", "body");
    const reg = SkillRegistry.fromProjectDir(dir);
    expect(reg.load("../../../etc/passwd")).toBeNull();
    expect(reg.load("/etc/passwd")).toBeNull();
    expect(reg.load("..")).toBeNull();
    expect(reg.load("valid")).not.toBeNull();
  });
});

// ─── use_skill tool ──────────────────────────────────────────────────────────────

describe("makeUseSkillTool", () => {
  const CTX = { repoRoot: "/tmp" };

  it("lists available skills in its description", () => {
    writeSkill("deploy", "description: Deploy steps", "body");
    const reg = SkillRegistry.fromProjectDir(dir);
    const tool = makeUseSkillTool(reg);
    expect(tool.descriptor.description).toContain("deploy: Deploy steps");
    expect(tool.descriptor.permission_level).toBe(0);
  });

  it("returns the skill body and audit target on success", async () => {
    writeSkill("notes", "description: Notes", "the note body");
    const reg = SkillRegistry.fromProjectDir(dir);
    const tool = makeUseSkillTool(reg);
    const result = await tool.execute({ name: "notes" }, CTX);
    expect(result.ok).toBe(true);
    expect(result.output).toBe("the note body");
    expect(result.audit?.target).toBe("skill:notes");
  });

  it("returns an error (ok:false) for an unknown skill", async () => {
    const reg = SkillRegistry.fromProjectDir(dir);
    const tool = makeUseSkillTool(reg);
    const result = await tool.execute({ name: "missing" }, CTX);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("unknown skill");
  });
});
