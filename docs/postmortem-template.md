# Postmortem Template

Use this template for any incident that affects the audit invariant, causes data loss or corruption, exposes a secret, triggers the kill switch unexpectedly, or degrades availability of a critical kernel component. Blameless by default; the goal is system improvement, not attribution.

---

## Incident: [Short title]

**Date:** YYYY-MM-DD  
**Severity:** P1 (Critical) / P2 (High) / P3 (Medium)  
**Duration:** HH:MM  
**Owner:** [name]  
**Participants:** [names]  
**Status:** Draft / In Review / Closed

---

## 1. Summary

One paragraph: what happened, what was the user / operator impact, and what was the outcome. Write this last, after the full review.

---

## 2. Timeline

All times in UTC.

| Time | Event |
|------|-------|
| HH:MM | Incident begins |
| HH:MM | First detection |
| HH:MM | Escalation / kill switch activated (if applicable) |
| HH:MM | Root cause identified |
| HH:MM | Mitigation applied |
| HH:MM | Incident resolved |
| HH:MM | Audit trail verified intact (if applicable) |

---

## 3. Root cause

What single underlying cause, if fixed, would have prevented this incident? Distinguish from contributing factors.

**Root cause:**

**Contributing factors:**

---

## 4. Impact

| Dimension | Impact |
|-----------|--------|
| Audit invariant | Intact / Degraded / Broken |
| Data loss | None / Scope: |
| Secret exposure | None / Scope: |
| Kill switch triggered | No / Yes — reason: |
| Operator-visible downtime | None / Duration: |
| Actions executed without audit | 0 / Count: |
| Hash chain integrity | Intact / Broken at event: |

If the audit invariant was degraded or broken, this is a Critical severity incident regardless of other impact.

---

## 5. Detection

How was the incident discovered? Was it caught by an alert, by `audit verify`, by a user report, or by chance?

**Detection method:**  
**Time to detect:**  
**Was this detectable earlier? If so, how?**

---

## 6. Response

Describe the response actions taken and by whom. Include any mitigations applied during the incident (kill switch, rollback, manual audit event review).

**Immediate mitigation:**  
**Rollback applied?** Yes / No — `audit rollback <event_id>` or manual steps:  
**Audit chain repaired?** Yes / No / Not applicable  

---

## 7. Resolution

What was the final state after the incident was closed? Confirm:

- [ ] `openllama audit verify` passes (hash chain intact or repaired)
- [ ] No secrets in audit ledger in clear text
- [ ] Kill switch deactivated (if it was activated)
- [ ] Any in-flight mutations accounted for (rolled back or confirmed intentional)
- [ ] SIEM export reviewed (if applicable)

---

## 8. What went well

List 2–4 things that worked: controls that caught the issue, fast response paths, good observability, etc.

---

## 9. What went wrong

List 2–4 things that failed or were slower than expected: detection gaps, missing alerts, confusing runbook steps, policy gaps.

---

## 10. Action items

| Action | Owner | Due | Priority |
|--------|-------|-----|----------|
| | | | |

Each action should be specific and produce an artifact (a new test, a new alert, a runbook update, a new policy rule, a new exception record with expiry).

If this incident revealed a residual risk without a compensating control, add an entry to `catalog/exceptions.yml` with an expiry date.

---

## 11. Lessons learned

What should every contributor and operator know after this incident that they did not know before?

---

## 12. Related

- Exception record: `catalog/exceptions.yml` entry (if created)
- Audit event IDs: (the events that captured the incident in the ledger)
- Threat model update: `docs/threat-models/openllama.md` (if applicable)
- Runbook update: `docs/runbook.md` (if applicable)
- PR / commit: (the fix)
