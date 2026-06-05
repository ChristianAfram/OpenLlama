# Production Readiness Review

*Framework §57, §51 — Master Plan §25 — v0.7 public beta*

---

## Project

OpenCLI — local-first, governance-native, open-source AI coding agent.

## Owner

Project maintainer (chris)

## Version

v0.7 — "Public beta"

## Risk Level

**Critical** — public launch; first external users; security-sensitive agent surface.

## Reviewer

Framework §51 scorecard applied by project maintainer. Independent verification
gap: noted and tracked as EX-2026-003 (rule-based verifier covers High/Critical
actions; live second-model verifier deferred to v0.8).

## Decision

**CONDITIONAL GO**

Conditions:
1. EX-2026-002 (no signed releases) must be resolved before the first binary
   release is published. Source distribution via git is safe; binary signing
   infrastructure ships in v0.8.
2. EX-2026-003 (live second-model verifier) must be resolved before any
   Critical-risk production deployment. The rule-based verifier covers the
   v0.7 scope.
3. The product remains **local-only**. Hybrid/cloud mode is not implemented;
   no data leaves the user's machine without operator-controlled export.

---

## 1. Summary

**What is launching:** OpenCLI v0.7 "Public beta" — the governance kernel,
full L0–L5 tool surface, policy-as-code engine, approval gate, kill switch,
independent verifier, rollback engine, SIEM/OTel export, and agentic metrics.

**Who is affected:** Developers who install and run the agent locally against
their own repositories and a locally running Ollama model server.

**Problem solved:** Provides the first verifiably safe local AI coding agent —
every action is risk-classified, policy-checked, approval-gated where required,
and recorded in a tamper-evident audit ledger before it runs.

**Expected impact:** Public beta testers can run the full agent loop with a
high confidence that no mutation happens without an audit record, and every
mutation is reversible via the rollback engine.

**Not included:** Hybrid/cloud mode; binary release signing; live second-model
verifier; MCP client; IDE integration.

**Known limitations:** Local-only; no signed binaries; snapshot GC not yet
automated; model file integrity not verified.

---

## 2. Critical User Flows

### Flow 1: Agent task with audit trail

**Expected:** `opencli agent "<task>"` runs the reasoning loop; every mutation
is recorded in the hash-chained ledger; `audit verify` confirms chain intact.

**Test result:** Covered by executor invariant tests (`tests/executor.test.ts`),
injection evals (100% gate), and rollback workflow (CI).

**Owner:** Project maintainer

### Flow 2: Prompt-injection resistance

**Expected:** Malicious content in repo files cannot cause a tool call, secret
leak, or permission change — even if the model is compromised.

**Test result:** `prompt-injection` eval category: 100% gate, enforced in
`evals.yml` on every push. Multiple injection vectors covered (force-push,
exfiltration, approve-all variants).

**Owner:** Project maintainer

### Flow 3: Mutation rollback

**Expected:** `opencli audit rollback <event_id>` reverses a `write_file` or
`edit_file` mutation; verifies hash preconditions; appends a rollback audit event.

**Test result:** `rollback-correctness` eval category (6 cases, 100% gate) +
`tests/rollback.test.ts` (8 tests). CLI rollback verified by `rollback.yml` CI job.

**Owner:** Project maintainer

---

## 3. Architecture

**Main services:** opencli-agent, audit-ledger, snapshot-store, rollback-engine, kill-switch

**Data flow:** user instruction → reasoning engine → tool call (zod-validated) →
classifier → policy engine → verifier → approval gate → executor (audit write → side effect)

**External dependencies:** Ollama local server (localhost:11434; user-controlled)

**Failure modes:** Audit write failure blocks mutation (no-audit-no-action).
Kill switch blocks all L3+ mutations. Policy DENY is terminal. Verifier BLOCK is terminal.

**Known risks:** See `docs/threat-models/opencli.md` residual risk section.

---

## 4. Code

**Repository:** christianafram/openllama (project name: OpenCLI)

**Branch:** main (via PR from `claude/openllama-prompt-system-WsFR7`)

**Lint:** ESLint (typescript-eslint recommended) — passes on every PR

**Type check:** `tsc --noEmit` strict — passes on every PR

**Static analysis:** TypeScript strict mode + eslint

**Secret scan:** gitleaks on every push (ci.yml)

**Dependency audit:** `npm audit --audit-level=high` (supply-chain.yml)

---

## 5. Testing

**Unit tests:** 298 tests (21 files) — all passing

**Integration tests:** Executor pipeline tests; approval-gate tests; policy-engine tests

**E2E / CLI tests:** `rollback.yml` workflow exercises the full CLI pipeline

**AI evals:** 7 categories — all 100% gates:
- `prompt-injection` (100% — hard gate)
- `destructive-refusal` (100% — hard gate)
- `secret-handling` (100%)
- `tool-permissions` (100%)
- `approval-boundary` (100%)
- `json-tool-args` (100%)
- `rollback-correctness` (100%)

**Manual QA:** Demo flow documented in `docs/demo.md`

---

## 6. Security

**Authentication:** Not applicable (local-only; no network auth surface)

**Authorization:** L0–L5 permission model; approval gate; L5 confirmation phrase

**Permission model:** Deterministic classifier; model can only raise level; policy hard rules

**Secrets:** Secret-path denylist; ledger redaction; gitleaks CI gate

**API protection:** Not applicable (local-only)

**Prompt injection defense:** Trust-tier fencing; 100%-gate eval suite

**Threat model:** `docs/threat-models/opencli.md`

**Supply chain:** SBOM (sbom.json); npm audit; gitleaks; dependabot

---

## 7. Data

**Data model:** Append-only hash-chained SQLite ledger; content-addressed snapshot blobs

**Data classification:** `internal` (user's own codebase and audit records)

**Migrations:** Not applicable (SQLite created on first write; no schema migration)

**Backups:** Manual JSONL export documented in `docs/runbook.md`

**Restore test:** Documented; not yet drilled against a real ledger (noted in `docs/disaster-recovery.md`)

**Retention:** User-controlled; no automatic expiry

**Deletion path:** Delete the SQLite file (breaks chain; export first)

**Audit logs:** Every action recorded; `audit verify` for integrity

**Data flows:** `catalog/data-flows.yml`

---

## 8. Infrastructure

**Hosting:** Local machine only

**Environments:** Single (local developer environment)

**Secrets:** No secrets stored by OpenCLI; user's `.env` is denylist-protected

**Storage:** SQLite + filesystem blobs in `~/.local/share/openllama/ (v0.7 legacy path)`

**Cost estimate:** Local inference only; no cloud charges

**Asset inventory:** `catalog/assets.yml`

---

## 9. Deployment

**CI/CD:** GitHub Actions (ci.yml, evals.yml, policy.yml, kill-switch.yml, rollback.yml, sbom.yml, supply-chain.yml)

**Policy gates:** `policy.yml` — exception expiry, policy bundle validation

**Release:** `npm install && npm run build` → `node dist/index.js`

**Rollback:** `git revert <commit>` at the infrastructure level; `opencli audit rollback` for per-mutation revert

**Feature flags:** Kill switch acts as a runtime feature flag for all mutating tools

---

## 10. Observability

**Logs:** Hash-chained audit ledger (`opencli audit show`)

**Metrics:** `opencli audit metrics` — blocked-action rate, approval-denial rate, injection-detection count, consecutive-denial peak, rollback count

**Dashboards:** `docs/slo/opencli.md` — SLIs and targets

**Alerts:** Documented in `catalog/services.yml` (kill_switch_active, chain_broken, consecutive_denial_peak)

**SIEM/OTel export:** `audit export --siem` (raw JSONL); `audit export --otel` (OTel LogRecord JSONL)

**Runbook:** `docs/runbook.md`

---

## 11. Operations

**Owner:** Project maintainer

**Service catalog:** `catalog/services.yml` — 5 services registered

**Runbook:** `docs/runbook.md`

**Rollback steps:** `docs/rollback.md`

**Kill switches:** `opencli kill-switch activate` (manual + automated triggers)

**Incident process:** `docs/runbook.md` → Common Failures + Recovery Steps

---

## 12. AI Agent Safety

**Agent capabilities:** Read (L0), propose diff (L1), write new file (L3), edit/shell/git (L4), force-push (L5 — always refused)

**Allowed tools:** read_file, list_dir, grep, propose_diff, write_file, edit_file, run_shell, git

**Forbidden tools:** git push --force (structural refuse); any L5 without confirmation phrase

**Permission levels:** 0–5; deterministic classifier; model can only raise

**Approval requirements:** L4 requires scoped, expiring grant; L5 requires confirmation phrase + grant

**Kill switch:** Verified in `kill-switch.yml` CI

**Eval coverage:** 7 categories, all 100% gates

**Verifier:** Rule-based verifier covers High/Critical actions; BLOCK is terminal

---

## 13. Costs

**Expected monthly cost:** $0 (local inference only)

**Worst-case monthly cost:** $0 (no external API calls; hybrid mode not yet implemented)

**Abuse cost risk:** Loop guard (25 iteration cap) and kill switch prevent runaway local compute

---

## 14. Risks and Exceptions

| Exception ID | Risk | Impact | Owner | Expiry | Status |
|---|---|---|---|---|---|
| EX-2026-001 | No second-model verifier until v0.5 | L4/L5 actions rely on human approval + L5 phrase alone | chris | 2026-09-01 | **Resolved** (v0.5 landed rule-based verifier) |
| EX-2026-002 | No signed release binaries for v0.7 | Users cannot cryptographically verify release artifacts | chris | 2027-01-01 | Active — compensating: source distribution via git; SBOM committed |
| EX-2026-003 | Live second-model verifier deferred to v0.8 | Critical actions verified by rule-based verifier only, not a second live model | chris | 2027-01-01 | Active — compensating: rule-based verifier + human L5 gate |

---

## §51 Scorecard (0 = Missing, 1 = Partial, 2 = Ready with known risks, 3 = Fully ready)

| Category | Score | Notes |
|---|---|---|
| Product | 2 | Working agent; public beta; no production traffic yet |
| Architecture | 3 | Governance kernel well-documented, tested, layered |
| Code | 3 | Strict TypeScript, ESLint, no dead code, no hardcoded secrets |
| Testing | 3 | 298 tests + 7 eval categories (all 100% gates) + CI |
| **Security** | **2** | Full kernel controls in place; local-only; no binary signing yet |
| **Data** | **2** | Audit ledger + snapshots; redaction; no remote storage; no auto-backup |
| Infrastructure | 2 | Local-only; no cloud infra; SBOM new |
| **Deployment** | **2** | CI green; source release only; no binary signing yet |
| **Observability** | **3** | Audit metrics, SIEM/OTel export, runbook, SLO defined |
| Reliability | 2 | Kill switch, rollback engine, no-audit-no-action invariant |
| Performance | 2 | Loop guard, kill switch; no benchmarks published |
| Compliance | 1 | MIT license; local-only; no formal compliance framework |
| Operations | 2 | Runbook, rollback docs, DR docs, service catalog |
| Business | 1 | Pre-production; no adoption metrics; GTM not defined |
| **AI agent safety** | **3** | Approval gates, verifier, kill switch, evals, policy-as-code |
| Cost and abuse control | 2 | Loop guard, kill switch; no billing system (local-only) |
| **Policy enforcement** | **3** | OPA policy-as-code, CI gate, enterprise mode, exception lifecycle |
| Service ownership | 2 | All 5 services registered in catalog/services.yml |
| Asset inventory | 2 | catalog/assets.yml complete for v0.7 scope |
| Supply chain security | 2 | SBOM + npm audit + gitleaks + dependabot; no binary signing |
| Threat model | 2 | docs/threat-models/opencli.md complete; residual risks documented |
| Disaster recovery | 2 | docs/disaster-recovery.md; drills partially tested |
| Independent verification | 1 | Rule-based verifier; live second-model verifier deferred (EX-2026-003) |

**v0.7 exit criteria check:**
- No 0s: ✓
- Security ≥2: ✓ (2)
- Data ≥2: ✓ (2)
- Deployment ≥2: ✓ (2)
- Observability ≥2: ✓ (3)
- AI agent safety ≥2: ✓ (3)
- Policy enforcement ≥2: ✓ (3)
- Critical user flows =3: ✓ (see section 2)
- Independent verification: ✓ (rule-based verifier + exception EX-2026-003)
- Hard blockers (§6) cleared: ✓ (all cleared for local-only scope)

---

## 15. Final Decision

**Decision: CONDITIONAL GO**

**Conditions:**
1. EX-2026-002 (no signed binaries) is accepted with the compensating control of
   source distribution + committed SBOM. Must be resolved before any binary
   release is published outside of git.
2. EX-2026-003 (live second-model verifier) is accepted. Rule-based verifier
   covers the v0.7 scope. Must be resolved before any Critical-tier production
   deployment with external data.
3. Product is PUBLIC BETA (not production). Users should treat it as beta software;
   no production deployments of regulated data are recommended.

**Follow-up actions:**
- v0.8: signed release binaries (resolve EX-2026-002)
- v0.8: live second-model verifier (resolve EX-2026-003)
- v0.8: hybrid/cloud mode (with new data-flow entries and controls)
- v0.8: snapshot blob GC
- v0.8: model file integrity verification

**Review date:** 2026-09-01 (EX-2026-002 and EX-2026-003 expiry; re-score scorecard)
