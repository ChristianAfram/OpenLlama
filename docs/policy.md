# Policy-as-code

OpenCLI's policy engine is the version-controlled, reviewed-like-code layer
that decides **what to do** about a proposed action. It sits between the risk
classifier (which decides **how risky** an action is) and the approval gate
(which **enforces** the decision). Master Plan §8; framework §8.

## Where it lives

- **Engine + rules:** [`src/policy/`](../src/policy) — pure, deterministic,
  in-process. No external policy server.
- **Documented bundle:** [`policies/README.md`](../policies/README.md).
- **CI gate:** [`.github/workflows/policy.yml`](../.github/workflows/policy.yml).
- **Exception lifecycle:** [`catalog/exceptions.yml`](../catalog/exceptions.yml),
  validated by `opencli policy exceptions`.

## Decisions

Every rule returns one of four decisions; the engine takes the **most
restrictive** across all rules that fired:

```
DENY  >  REQUIRE_CONFIRMATION  >  REQUIRE_APPROVAL  >  ALLOW
```

| Decision | Meaning | Executor behaviour |
|---|---|---|
| `ALLOW` | permitted, still audited | proceeds |
| `REQUIRE_APPROVAL` | needs a scoped, expiring grant | approval gate (grant required) |
| `REQUIRE_CONFIRMATION` | needs a manual, action-specific phrase, every time | approval gate + L5 confirmation phrase |
| `DENY` | forbidden | blocked — **no approval can rescue it** |

## Minimum policy behavior (Master Plan §8)

| Condition | Decision |
|---|---|
| `risk_level ∈ {high, critical}` | approval token must exist (REQUIRE_APPROVAL / _CONFIRMATION) |
| destructive action | manual confirmation every time (REQUIRE_CONFIRMATION) |
| secret path read/written | DENY |
| audit logging unavailable + high/critical | DENY |
| model has not passed its eval suite | DENY |
| egress domain not in allowlist | REQUIRE_APPROVAL (DENY in `--enterprise`) |

## Enterprise mode

`--enterprise` makes policy violations **hard blocks**: rules that would
`REQUIRE_APPROVAL` in default mode (dependency install, non-allowlisted egress)
become `DENY`, which no approval can override. Pass `--enterprise` to
`opencli exec`.

## How it integrates with the kernel

```
classify(level 0–5)  →  policy.evaluate()  →  approval gate  →  audit  →  apply
        │                      │                    │             │         │
   how risky?            what to do?          enforce grant   THE GATE   side effect
```

The policy decision and its reason are written to the audit event
(`policy_decision`, `policy_reason`), so every gated action is explained in the
ledger. Policy never bypasses the no-audit-no-action invariant — it runs *before*
the audit write, and a DENY produces a `blocked` event.

## Exception lifecycle (framework §25)

Accepted risk must expire. Every entry in `catalog/exceptions.yml` needs an
owner, an `expires_at`, and a `compensating_control`. `opencli policy
exceptions` (and the `policy` CI job) **fails the build** if any active exception
is past its expiry or is missing a required field. There are no permanent
exceptions.

## Testing

```bash
npm test                                   # tests/policy*.test.ts — full decision matrix
opencli policy test --json '<action>'    # evaluate one action (exit 2 on DENY)
opencli policy exceptions                # the lifecycle gate
```
