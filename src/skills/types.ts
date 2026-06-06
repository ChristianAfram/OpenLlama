/**
 * Skill system types (v0.8 — B6 Extensibility).
 *
 * A skill is a reusable, named instruction module authored as
 * `.opencli/skills/<name>/SKILL.md` with YAML frontmatter. Skills give the
 * agent reusable know-how (a workflow, a checklist, project conventions).
 *
 * CRITICAL trust model: a skill file is UNTRUSTED external content. It may be
 * checked into a repository by anyone, so its body is loaded through the same
 * fenced tool-result path as a file read — it is reference DATA, never an
 * instruction with authority. A skill can never grant a tool permission,
 * approve an action, lower a permission level, or loosen a security control.
 */

/** Frontmatter metadata for a skill. The menu the model sees is built from this. */
export interface SkillMetadata {
  /** Unique skill name (slug). Must match ^[a-z0-9][a-z0-9_-]*$. */
  name: string;
  /** One-line description of what the skill does / when to use it. */
  description: string;
  /** Optional version string for governance/audit. */
  version?: string;
  /** Absolute path to the SKILL.md file. */
  path: string;
}

/** A fully loaded skill: metadata + the (untrusted) markdown body. */
export interface Skill {
  metadata: SkillMetadata;
  /** The markdown body after the frontmatter. UNTRUSTED — fence before context. */
  body: string;
}
