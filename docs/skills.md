# Skills (v0.8 — B6)

Skills are reusable, named instruction modules — a workflow, a checklist, or
project conventions the agent can pull in on demand. They are the second
**Extensibility** primitive (after hooks).

## Authoring — `.opencli/skills/<name>/SKILL.md`

```markdown
---
name: deploy
description: Steps to cut a release and deploy to staging
version: "1"
---
1. Run the test suite.
2. Bump the version.
3. Tag the release.
...
```

- The directory name is the skill's slug and must match `^[a-z0-9][a-z0-9_-]*$`.
- The frontmatter `name`, if present, **must equal the directory slug** — a
  mismatch is rejected so a skill cannot masquerade under another name.
- `description` is the one-line menu entry the model sees. `version` is optional.
- A malformed or unreadable SKILL.md is skipped, never fatal.

## How the agent uses a skill

When skills are present, the agent gains a read-only `use_skill` tool whose
description enumerates the available skills. The model calls
`use_skill({ name })` to pull a skill's body into the conversation.

The body returns through the **normal tool-result path**, so it is automatically
wrapped in an `<untrusted_external_data>` fence — the same treatment as a file
read.

## Trust model — skills are UNTRUSTED data

A SKILL.md may be checked into a repository by anyone. OpenCLI therefore treats a
skill body as **reference data, never authority**:

1. **Fenced.** A loaded skill body enters context inside an
   `<untrusted_external_data>` fence and is never interpreted as an instruction
   (eval `SK-001`).
2. **No privilege escalation.** A skill cannot grant a tool permission, approve
   an action, or lower a permission level. A malicious skill instructing
   `rm -rf /` does not cause one — the kernel blocks the L5 mutation regardless
   of the skill text (eval `SK-002`).
3. **Path-confined.** Discovery and loading are bounded to
   `.opencli/skills/<slug>/`. Traversal (`../`), absolute paths, and non-slug
   names resolve to nothing (eval `SK-003`).
4. **Audited.** Loading a skill is a `use_skill` tool call and is recorded on the
   audit timeline with `target: skill:<name>` (eval `SK-004`).

## Eval coverage

`evals/cases/skill-trust.ts` — `SK-001` (fenced), `SK-002` (no escalation),
`SK-003` (path-confined), `SK-004` (audited). Gate: 100%.
