# Threat Model: Approval Gate

Status: **started** (Prompt 5 / v0.2). Expanded as the permission model and the
verifier (v0.5) land.

## Assets

- The integrity of the L4/L5 boundary: no high/critical action executes without a
  valid, scoped, unexpired grant (and, for L5, a correct confirmation phrase).
- The audit record of every approval decision (granted / denied / rejected).

## Trust Boundaries

- **Agent ↔ approver.** The reasoning engine produces *proposals*. It is given
  **no** `ApprovalProvider`, so it can never approve its own action. Approval
  crosses from a human (CLI provider) or an explicitly-injected provider in tests.
- **Request ↔ grant.** A grant is verified (`verifyGrant`) against the exact
  request it claims to authorize, at the current time — not trusted as presented.

## Entry Points

- `Executor.execute()` for any tool classified L4/L5.
- `CliApprovalProvider.requestApproval()` reads a human decision from a TTY.

## Actors

- `user:cli` — a human at the terminal who can grant/deny.
- `agent:opencli` — the requester; never the approver.

## Abuse Cases & Threats

| Threat | Vector | Control |
|---|---|---|
| **Bypass** | L4/L5 action with no approval channel | Blocked; audited `REQUIRE_APPROVAL`/`REQUIRE_CONFIRMATION`. The agent loop supplies no provider. |
| **Self-approval (Elevation of Privilege)** | Agent tries to mint its own grant | The agent has no provider seam; grants only come from injected providers. |
| **Replay** | Reuse a grant/confirmation for another action | `action_id` binding + action-specific confirmation phrase (`CONFIRM <tool> <target>`). |
| **Overbroad grant ("approve everything")** | Wildcard tool/path, unbounded session/time | `verifyGrant` rejects empty/`*` tools, catch-all path globs, unbound session, and lifetimes beyond `MAX_GRANT_TTL_MS` (24h). |
| **Stale grant (Tampering with time)** | Use an expired grant | `expires_at` checked against `now`; expired → rejected. |
| **Scope creep** | Grant for tool A used for tool B, or path X used for path Y, or session S1 used in S2 | Tool / path-glob / session / max-level all checked. |
| **Confirmation downgrade** | L5 action with an L4-style grant (no phrase) | `missing_confirmation` / `wrong_confirmation` rejection. |
| **Repudiation** | "I never approved that" | Every decision is written to the hash-chained ledger with `approval_id` and `policy_decision`. |

## Prompt Injection Considerations

External content (repo files, issues, tool output) is data, never authority. It
cannot cause an approval: approval requires an out-of-band human decision through
the provider, and injected text never reaches the provider as a grant.

## Residual Risk

- No independent verifier yet (tracked as **EX-2026-001**, expires 2026-09-01).
  Compensating control: human approval + L5 confirmation phrase.
- The CLI provider trusts the controlling terminal; a compromised terminal is out
  of scope for v0.2 (addressed by OS-level controls).

## Required Follow-Ups

- v0.5: independent verifier as a second approver for L4/L5.
- Persist grants to the ledger/catalog for after-the-fact audit of scope.
- Rate-limit repeated approval prompts (abuse / fatigue).
