# Security Policy

*v0.7 public beta — OpenCLI*

---

## Supported Versions

| Version | Status | Security fixes |
|---|---|---|
| v0.7.x (main) | ✓ Active | Yes |
| v0.6.x and earlier | Archived | Critical only, best-effort |

OpenCLI is a **local-only** agent in public beta. There is no hosted service,
no cloud backend, and no network-accessible endpoint. The attack surface is
limited to the local machine and the user's own repository.

---

## Reporting a Vulnerability

Please report security issues **privately** rather than opening a public issue:

1. Use GitHub's **private vulnerability reporting**: navigate to the Security
   tab of this repository and click "Report a vulnerability".
2. Or email the maintainer directly (address on the GitHub profile).

Include:
- A concise description of the vulnerability
- Reproduction steps (the simpler the better)
- Affected version or commit SHA
- Your assessment of impact and exploitability

**Response SLA (public beta):**

| Severity | Acknowledgement | Initial triage | Fix target |
|---|---|---|---|
| Critical | ≤ 24 h | ≤ 48 h | ≤ 7 days |
| High | ≤ 48 h | ≤ 72 h | ≤ 14 days |
| Medium / Low | ≤ 5 business days | ≤ 10 business days | Next release cycle |

We follow **coordinated disclosure**: we will work with you on a fix before any
public announcement. We ask for a 90-day embargo on critical issues to give us
time to ship a fix; for lower-severity issues, disclosure timing is negotiated.

---

## Scope

**In scope (please report):**

- The OpenCLI governance kernel (`src/kernel/`)
- The approval gate and permission model (`src/kernel/approval.ts`, `src/kernel/executor.ts`)
- The audit ledger and hash chain (`src/kernel/audit.ts`)
- The policy engine and policy rules (`src/policy/engine.ts`, `src/policy/rules/`)
- The kill switch (`src/kernel/kill-switch.ts`)
- The eval suite as a safety control (`src/evals/`)
- The rollback engine (`src/kernel/rollback.ts`)
- Prompt injection bypasses in the trust-tier fencing
- Secret leakage through any path (ledger, exports, logs)
- Approval boundary bypasses (an agent approving its own L4/L5 action)
- Permission level downgrade by model output
- CI workflow vulnerabilities (suppressing gates, secret leakage in logs)
- Supply-chain issues in direct dependencies

**Out of scope (report upstream):**

- The local Ollama runtime and model weights — report to [Ollama](https://github.com/ollama/ollama)
- Issues requiring physical access to the user's machine (that's between you and your OS)
- Speculative or theoretical issues with no demonstrated impact
- Issues in transitive dependencies not exploitable through OpenCLI

---

## Threat Model

The comprehensive threat model is in [`docs/threat-models/opencli.md`](docs/threat-models/opencli.md).

The core invariants that protect the system:

1. **No-audit-no-action** — a world-mutating tool cannot execute unless a
   confirmed audit write succeeds first. This is structural: the executor checks
   the ledger write before calling `apply()`. An audit-write failure produces a
   `blocked` result, not a silent failure.

2. **Trust-tier separation** — user instructions are trusted; repository file
   contents, issue bodies, tool output, and any externally sourced text are
   treated as *data*, never as instructions. The kernel enforces this
   structurally; the eval suite verifies it with 100%-gate CI tests.

3. **Secret-path denylist + redaction** — `.env`, `.git/config`, `secrets/`,
   and CI workflow files are hard-denied at the policy layer. Secrets that reach
   the ledger are SHA-256 hashed; no plaintext secret is ever written.

4. **Deterministic risk classifier** — every action maps to a permission level
   (0–5). Model output may only *raise* the level, never lower it. Hard rules
   (destructive commands, protected branches) are immutable.

5. **Approval gate + L5 confirmation** — L4 actions require a scoped, expiring
   approval grant from the operator. L5 actions additionally require a
   manual, action-specific confirmation phrase typed by the operator. The agent
   loop is given no approval channel; it cannot approve its own actions.

6. **Kill switch** — a single `opencli kill-switch activate` freezes all
   mutating tools immediately, survives process restart, and is auto-triggered
   by N consecutive policy denials (default 5).

---

## Known Limitations (v0.7 public beta)

- **No signed release binaries.** Git tags are the authoritative release
  mechanism. Binary signing infrastructure is planned for v0.8. See
  `catalog/exceptions.yml` (EX-2026-002).
- **Local-only.** Hybrid/cloud mode is not yet implemented. All inference and
  storage is on the user's machine.
- **No model file integrity verification.** The user is responsible for pulling
  models from a trusted Ollama registry. OpenCLI does not verify `.gguf`
  file hashes against a known-good manifest.
- **Snapshot blob GC.** The snapshot store has no automated garbage collection
  in v0.7. Growth is bounded by the number of `edit_file` mutations in a
  session.
- **Legacy storage paths.** In v0.7, config and data are stored under
  `~/.config/openllama/` and `~/.local/share/openllama/` (the legacy name).
  Migration to `opencli` paths is planned for v0.8. See
  `catalog/exceptions.yml` (EX-2026-004) and `docs/runbook.md`.

---

## Secrets

Never include secrets in:
- Issues or PR descriptions
- Commit messages
- Test fixtures (use the `.gitleaks.toml` allowlist for intentional test values)
- Log output (the audit ledger redacts secrets by design)

CI runs `gitleaks` on every push. See `.github/workflows/ci.yml`.

---

## Supply-Chain

- Dependencies are pinned via `package-lock.json` and installed with `npm ci`.
- A CycloneDX SBOM (`sbom.json`) is committed to the repository and regenerated
  in CI via `.github/workflows/sbom.yml`.
- `npm audit --audit-level=high` runs on every push via `.github/workflows/supply-chain.yml`.
- Dependabot is configured for weekly npm updates (`.github/dependabot.yml`).
