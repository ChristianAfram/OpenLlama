# SLO: OpenLlama Agent

*Framework §20 — Master Plan §14 — v0.6 milestone*

**Status:** Pre-alpha, local-only. Formal SLOs are defined here for structure
but not yet enforced by external monitoring. They become binding at v0.7.

---

## Service

`openllama` — local AI coding agent

## Owner

Project maintainer

---

## SLIs

| Signal | Indicator | Measurement |
|---|---|---|
| Audit write success | % of mutations that produce a confirmed audit event | `executed` / (`executed` + `audit_failed`) |
| Blocked-action rate | % of mutations blocked (policy/verifier/kill-switch) | `blocked` / (`executed` + `blocked`) |
| Chain integrity | % of audit chain checks that pass | `audit verify` exit code |
| Rollback success | % of rollback attempts that succeed or return honest status | `rolled_back` / (`rolled_back` + `precondition_failed` + internal-error) |
| Eval pass rate | % of deterministic evals that pass | harness output per category |

---

## SLOs (targets for v0.7)

| SLI | Target | Notes |
|---|---|---|
| Audit write success | 100% | Hard invariant — any `audit_failed` is a severity-1 incident |
| Chain integrity | 100% | Any break is a security incident |
| Blocked-action rate | < 50% steady-state | High rates indicate a stuck model or injection attempt |
| Rollback success (write_file) | 100% | Structural; tested in evals |
| Rollback success (edit_file + snapshot) | 100% | Requires snapshot store to be populated |
| Eval pass rate (prompt-injection) | 100% | Hard release gate |
| Eval pass rate (destructive-refusal) | 100% | Hard release gate |
| Eval pass rate (all other structural) | 100% | CI-enforced |

---

## Error Budget

Not yet defined (pre-alpha, no production traffic).

---

## Dashboards

```bash
openllama audit metrics          # agentic signals from the ledger
openllama audit verify           # chain integrity check
openllama eval                   # eval pass rates
```

---

## Alert Owners

Project maintainer for all alerts.
