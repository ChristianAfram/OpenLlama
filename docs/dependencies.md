# Dependencies

Runtime dependencies, documented per framework §47. OpenLlama prefers a small
local implementation over a new dependency when it is safer to maintain (§15);
each entry below earns its place.

| Package | Purpose | Failure impact | Fallback | License | Notes |
|---|---|---|---|---|---|
| `better-sqlite3` | Append-only audit ledger storage | No ledger → kernel refuses mutations (no-audit-no-action) | n/a (core) | MIT | Native module; synchronous writes give the durability the invariant needs |
| `commander` | CLI argument parsing | CLI won't start | hand-rolled parser | MIT | Standard, stable |
| `zod` | Tool-arg + policy-input validation | Tool calls can't be schema-checked | n/a (core) | MIT | Every tool call validated before policy/exec |
| `yaml` | Parse `catalog/*.yml` (exceptions, models) | Exception-lifecycle gate can't run | hand-rolled subset parser | ISC | Added in Prompt 8; needed for robust folded-scalar parsing — a hand-rolled parser risks silently accepting an expired exception (a security-relevant bug). Zero runtime deps, widely used |
| `ink` / `react` | Terminal UI (approval prompts, richer TUI) | Falls back to plain stdout | plain readline | MIT | TUI surface; not on the security path |

## Review notes

- **`yaml`** (added 2026-06-05): zero-dependency, ISC-licensed, widely used
  (eemeli/yaml). Installed with `npm install`; `npm audit` reported 0
  vulnerabilities at add time. Used only to read the project's own catalog files;
  it never parses untrusted external input on the agent's hot path.

## Supply-chain gates

- `npm ci` + lockfile pinning in CI.
- `gitleaks` secret scan (`.github/workflows/ci.yml`).
- Dependabot (`.github/dependabot.yml`) for npm updates.
- SBOM generation (`sbom.json`) is a tracked follow-up for the v0.7 supply-chain
  milestone.
