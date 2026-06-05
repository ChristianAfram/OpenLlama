# OpenLlama

**The auditable coding agent. Local-first, governance-native, compliance-ready. The agent your security team signs off on.**

> Status: **public beta** (v0.7 — "Public beta"). Local-only. See [`docs/production-readiness.md`](docs/production-readiness.md) for the CONDITIONAL GO decision.

## The thesis

Most coding agents are optimized for capability. OpenLlama is optimized for a
single invariant:

> **No tool that mutates the world runs unless an audit write succeeds first.**

Every action an agent takes — reading a file, proposing a diff, editing code,
running a command, pushing a branch — is risk-classified, policy-checked,
approval-gated where required, and recorded in a tamper-evident, hash-chained
audit ledger *before* the side effect happens. If the audit write fails, the
action does not run. There is no flag, mode, or fast path that bypasses this.

The claim is not "best agent." It is **"the best agent you are allowed to run"** —
on your own hardware, against local models, with a verifiable record of
everything it did.

## How it compares

The coding-agent market has split into two camps that do not overlap: **capability** (fast, autonomous, no paper trail) and **governance** (closed SaaS proxies that wrap cloud tools). Nobody has fused them. OpenLlama is built in that seam.

| Tool | License | Local models | Audit / evidence | Gap |
|------|---------|-------------|-----------------|-----|
| **Claude Code** | Closed | No (Anthropic only) | Session-scoped, not tamper-evident | Cloud-only; model lock-in; no on-prem audit |
| **OpenCode** (~165k★) | MIT | Yes (75+ providers) | None by design — "stores nothing" | No audit trail; governance is the user's problem |
| **OpenAI Codex CLI** (~85k★) | Apache-2.0 | Limited | Execution logs, no governance kernel | Cloud-tuned; no policy-as-code |
| **Hermes Agent** (Nous) | Open | Yes (any endpoint) | Memory/sessions, not compliance-grade | General agent, not a governed coding specialist |
| **OpenHands** (~75k★) | Open | Yes | Task logs | No compliance posture |
| **Cline** (~62k★) | Open | Yes | Limited | No governance kernel |
| **VibeFlow / PolicyLayer** | Closed SaaS | n/a (wraps cloud) | Tamper-evident — as a paid external layer | Closed; cloud-dependent; third party holds your evidence |
| **OpenLlama** | MIT | Yes (Ollama) | Hash-chained, append-only, on-prem, exportable | Local-model quality ceiling (see [§22](docs/OpenLlama-Master-Plan.md)) |

**Why this seam is structurally unoccupied:** capability tools cannot add a tamper-evident kernel without abandoning the frictionless, store-nothing identity their whole pitch rests on. Governance SaaS tools cannot go local-first open-source without cannibalising the SaaS layer that is their business model.

**Who it is for:** EU/DE regulated teams (finance, health, legal, public sector), security/GRC personas, and privacy-first developers who want local autonomy *and* a personal audit trail.

**Who it is NOT for:** teams who want the fastest possible autonomous coding on frontier cloud models with zero friction. That is Claude Code / OpenCode territory. OpenLlama trades raw capability ceiling for provable control. If you have no compliance or sovereignty pressure, use one of those tools.

**Compliance context:** the artifacts OpenLlama produces (hash-chained ledger, SIEM export, exception records) are relevant to SOC 2 TSC, HIPAA §164.312(b), CMMC AU.2.042, NYDFS Part 500, and the EU AI Act's lifetime-logging requirement. OpenLlama does not *certify* compliance — that requires your org policy and a third-party auditor. It provides the evidence layer that *supports* an audit.

## What works today

The governance kernel, the full Level 0–5 tool surface, the deterministic AI
eval suite, the policy-as-code engine, the v0.5 safety layer, the v0.6
observability + rollback layer, and the v0.7 supply-chain + public-beta docs
are in place. Built and tested across milestones v0.1–v0.7:

- **Hash-chained audit ledger** — every action is recorded in an append-only
  SQLite ledger; `hash = sha256(prev_hash + canonical_json(body))`. UPDATE/DELETE
  are blocked at the database level; any retroactive edit breaks the chain and is
  detected by `audit verify`. Secrets are redacted before storage — the ledger
  records *that* a secret was touched plus a SHA-256, never the value.
- **The no-audit-no-action executor** — the only component that touches the
  world. A mutating tool's `plan()` computes the change (and its before/after
  blob hashes) with **zero** side effects; the executor appends the audit event
  first and only then runs the side effect. An audit-write failure means no
  filesystem change, structurally.
- **Deterministic risk classifier** — maps every action to a permission level
  (0–5). Hard rules: destructive commands (`rm -rf`, `git push --force`,
  `DROP TABLE`, …), protected paths (`.env`, `.git/config`, CI workflows), and
  protected branches (`main`, `release/*`) are always Level 5. A model opinion
  may only *raise* the level, never lower it.
- **Approval gate** — Level 4/5 actions require a **scoped, expiring** approval
  grant; Level 5 additionally requires a manual, action-specific confirmation
  phrase. Overbroad ("approve everything") grants are refused. The agent is given
  no approval channel, so it can never approve its own action.
- **Policy-as-code** — a deterministic, in-process policy engine sits between the
  classifier and the approval gate and maps every action to a decision
  (`ALLOW` / `REQUIRE_APPROVAL` / `REQUIRE_CONFIRMATION` / `DENY`, most-restrictive
  wins) with a reason code written to the ledger. Rules cover permission levels,
  secret paths, repo-root containment, git (protected-branch/force-push),
  dependency installs, network egress, and model governance. `--enterprise` mode
  makes violations hard blocks. The **exception lifecycle** is CI-enforced:
  an expired or malformed entry in `catalog/exceptions.yml` fails the build. See
  [`docs/policy.md`](docs/policy.md).
- **Reasoning loop** — an agent loop against a local
  [Ollama](https://ollama.com) model, with a hard iteration cap and a
  self-repair budget for invalid tool calls. External content (file contents,
  tool output) is fenced as untrusted data, never treated as instructions.
- **Tools** — `read_file`, `list_dir`, `grep` (L0), `propose_diff` (L1),
  `write_file` (L3, new files only), and the higher-risk mutating tools
  `edit_file` (L4), `run_shell` (L4), and `git` (commit L4, push L5,
  force-push always refused) — each gated by the executor and approval gate.
- **AI eval suite** — deterministic, model-independent evals prove the kernel's
  guarantees are *structural*: a prompt injection in repo content cannot cause a
  mutation or secret leak **even if the model is fully compromised and obeys
  it**. Categories: prompt-injection, destructive-refusal, secret-handling,
  tool-permissions, approval-boundary, json-tool-args. Prompt-injection and
  destructive-refusal are hard **100%** release gates, enforced in CI. See
  [`evals/README.md`](evals/README.md).
- **Independent verifier** — a second, rule-based reviewer that runs after
  policy evaluation for High/Critical actions. A BLOCK verdict is terminal —
  no approval can override it. Defense in depth against destructive commands,
  secret-path writes, and protected-branch pushes. The verifier interface is
  stable; a live second-model instance is a future milestone.
- **Kill switch** — global halt that blocks every mutating tool immediately,
  persisted to disk and survives process restarts. Automated triggers: N
  consecutive policy denials in a session (default 5), or a token-cap breach.
  Manual control: `openllama kill-switch [status|activate|deactivate]`.
  Verified in CI (`kill-switch.yml`).
- **Model governance** — `catalog/models.yml` registers every allowed model.
  In enterprise mode (`--enterprise`), the agent refuses to start with an
  unregistered or unevaluated model. The `model_governance` policy rule denies
  all actions when `model_eval_passed = false`.
- **Rollback engine** — one-command revert for every reversible mutation.
  `write_file` rollback deletes the created file; `edit_file` rollback restores
  the prior content from a content-addressed snapshot store captured before the
  audit write. Irrecoverable tools (shell, git push) print manual instructions.
  All reversals are themselves audited. Verified via `rollback-correctness` evals.
- **SIEM/OTel export** — `audit export --siem` emits raw JSONL for Splunk/Elastic;
  `audit export --otel` emits OTel-compatible `LogRecord` JSONL for Grafana Tempo
  or any OTLP-compatible backend.
- **Agentic metrics** — `audit metrics` computes golden-signal + agentic signals
  directly from the ledger: blocked-action rate, approval-denial rate,
  injection-detection count, consecutive-denial peak, per-tool call counts,
  rollback count. `--json` for machine-readable output.
- **Runbook + DR notes** — [`docs/runbook.md`](docs/runbook.md),
  [`docs/rollback.md`](docs/rollback.md), [`docs/disaster-recovery.md`](docs/disaster-recovery.md).
  Restore procedures documented; drills noted as tested or not-yet-drilled (§19).
- **Supply-chain gates** — CycloneDX SBOM (`sbom.json`) committed and regenerated
  in CI; `npm audit` vulnerability gate; license compliance check; gitleaks secret
  scan; Dependabot updates. See [`SECURITY.md`](SECURITY.md).
- **Full catalog** — `catalog/assets.yml`, `catalog/data-flows.yml`,
  `catalog/services.yml`, `catalog/models.yml`, `catalog/exceptions.yml`.
  Every production asset tracked; every data flow documented.
- **Threat model** — [`docs/threat-models/openllama.md`](docs/threat-models/openllama.md):
  full STRIDE + AI threat analysis; residual risks; accepted exceptions with expiry.
- **Production-readiness review** — [`docs/production-readiness.md`](docs/production-readiness.md):
  §51 scorecard (no 0s; Security/Data/Deployment/Observability/AI-safety/Policy all ≥2);
  §57 full review; decision: **CONDITIONAL GO** for public beta.

### Commands

```bash
openllama chat  "<prompt>"            # read-only conversation with a local model
openllama agent "<task>"              # the audited agent loop (read + draft + L3 write)
openllama exec  <tool> --json '<args>'  # run one tool through the kernel (no model)
openllama eval                        # run the AI eval suite + enforce the gates
openllama policy test --json '<action>' # evaluate an action against the policy bundle
openllama policy exceptions           # validate the exception catalog (CI gate)
openllama kill-switch status          # show kill-switch state
openllama kill-switch activate        # halt all mutating tools
openllama kill-switch deactivate      # re-enable mutating tools
openllama audit show                  # human-readable event timeline
openllama audit verify                # check the hash chain is intact
openllama audit export [--siem]       # JSONL export for Splunk/Elastic
openllama audit export --otel         # OTel LogRecord JSONL for Grafana/OTLP
openllama audit metrics [--json]      # blocked-action rate, agentic signals
openllama audit rollback <event_id>   # reverse a specific executed mutation
```

See [`docs/demo.md`](docs/demo.md) for the 90-second thesis demo (write a file →
show the ledger → tamper with it → watch the chain break).

The remaining milestones are tracked in
[`docs/OpenLlama-Master-Plan.md`](docs/OpenLlama-Master-Plan.md).
[`CLAUDE.md`](CLAUDE.md) is the production-readiness framework that governs every
change.

## Requirements

- Node.js ≥ 18
- A running [Ollama](https://ollama.com) server with a model pulled, e.g.
  `ollama pull qwen2.5-coder:7b` (only needed for `chat` and `agent`; `exec` and
  `audit` run without a model)

## Quick start

```bash
npm install
npm run build
node dist/index.js chat "explain what a hash chain is"

# Run a tool through the governance kernel — no model required:
node dist/index.js exec write_file --json '{"path":"hello.txt","content":"hi\n"}'
node dist/index.js audit verify
```

Configuration lives in `~/.config/openllama/config.json`. You can override the
model and host per-run with `--model` / `--host`, or via the `OPENLLAMA_MODEL`
and `OLLAMA_HOST` environment variables (see `.env.example`). The audit ledger
path can be overridden with `OPENLLAMA_AUDIT_DB`.

## Development

```bash
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # tsup -> dist/
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full contribution guide and risk classification requirements.

## License

[MIT](LICENSE)
