/**
 * Skill registry — discovers and loads `.opencli/skills/<name>/SKILL.md`.
 *
 * Discovery is bounded to the project's `.opencli/skills/` directory. A skill
 * name must be a strict slug (^[a-z0-9][a-z0-9_-]*$): this both namespaces the
 * skill and makes path traversal (`../`, absolute paths) structurally
 * impossible — `load()` only ever opens the SKILL.md of a discovered slug.
 *
 * Malformed frontmatter or an unreadable file causes that skill to be skipped,
 * never a crash. A skill body is returned verbatim; the caller (the use_skill
 * tool → engine) fences it as untrusted data.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Skill, SkillMetadata } from "./types.js";

/** A skill name must be a strict slug — no separators, no traversal. */
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_BODY_BYTES = 64 * 1024;

export class SkillRegistry {
  private readonly skills = new Map<string, SkillMetadata>();

  /** Build a registry by scanning a project's `.opencli/skills/` directory. */
  static fromProjectDir(projectDir: string | null): SkillRegistry {
    const reg = new SkillRegistry();
    if (!projectDir) return reg;
    const skillsDir = join(projectDir, ".opencli", "skills");
    if (!existsSync(skillsDir)) return reg;

    let entries: string[];
    try {
      entries = readdirSync(skillsDir);
    } catch {
      return reg;
    }

    for (const name of entries) {
      if (!SKILL_NAME_RE.test(name)) continue; // reject non-slug dirs (and traversal)
      const skillPath = join(skillsDir, name, "SKILL.md");
      if (!existsSync(skillPath)) continue;
      try {
        if (!statSync(skillPath).isFile()) continue;
        const raw = readFileSync(skillPath, "utf-8");
        const meta = parseFrontmatter(raw, name, skillPath);
        if (meta) reg.skills.set(meta.name, meta);
      } catch {
        // Skip unreadable / malformed skills — never crash discovery.
      }
    }
    return reg;
  }

  /** Metadata for all discovered skills (the menu shown to the model). */
  list(): SkillMetadata[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  /**
   * Load a skill's full body by name. Returns null if the skill is unknown,
   * the name is not a valid slug, or the file can't be read. The body is
   * UNTRUSTED — the caller must fence it before it enters the model context.
   */
  load(name: string): Skill | null {
    if (!SKILL_NAME_RE.test(name)) return null;
    const meta = this.skills.get(name);
    if (!meta) return null;
    try {
      const raw = readFileSync(meta.path, "utf-8");
      const body = stripFrontmatter(raw).slice(0, MAX_BODY_BYTES);
      return { metadata: meta, body };
    } catch {
      return null;
    }
  }
}

// ─── Frontmatter parsing ───────────────────────────────────────────────────────

interface RawFrontmatter {
  name?: unknown;
  description?: unknown;
  version?: unknown;
}

/**
 * Parse YAML frontmatter delimited by leading `---` lines. The frontmatter
 * `name`, if present, must equal the directory slug — a mismatch is rejected so
 * a skill can't masquerade under a different name than its location.
 */
function parseFrontmatter(raw: string, dirSlug: string, path: string): SkillMetadata | null {
  const fm = extractFrontmatter(raw);
  if (fm === null) return null;

  let parsed: RawFrontmatter;
  try {
    parsed = (parseYaml(fm) ?? {}) as RawFrontmatter;
  } catch {
    return null;
  }

  // name defaults to the dir slug; if specified it must match the slug.
  const declaredName = typeof parsed.name === "string" ? parsed.name : dirSlug;
  if (declaredName !== dirSlug) return null;
  if (!SKILL_NAME_RE.test(declaredName)) return null;

  const description =
    typeof parsed.description === "string" && parsed.description.trim()
      ? parsed.description.trim()
      : "(no description)";

  const meta: SkillMetadata = { name: declaredName, description, path };
  if (typeof parsed.version === "string" && parsed.version) meta.version = parsed.version;
  return meta;
}

/** Return the YAML between the first two `---` fences, or null if absent. */
function extractFrontmatter(raw: string): string | null {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end === -1) return null;
  return lines.slice(1, end).join("\n");
}

/** Return the markdown body after the frontmatter (or the whole file if none). */
function stripFrontmatter(raw: string): string {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return raw.trim();
  const end = lines.indexOf("---", 1);
  if (end === -1) return raw.trim();
  return lines.slice(end + 1).join("\n").trim();
}
