# Contributing to OpenLlama

Thank you for your interest in contributing. OpenLlama is a governance-native project — the standards we apply to the agent apply to contributions too.

## Before you start

Read [`CLAUDE.md`](CLAUDE.md): it is the operating contract for every change. Risk classification, audit requirements, and the no-audit-no-action invariant are not just agent features — they are the standard we hold the codebase to.

## Quick reference

```bash
npm install
npm run lint          # eslint
npm run typecheck     # tsc --noEmit
npm test              # vitest run
npm run build         # tsup → dist/
```

All four must pass before submitting a PR. CI enforces them.

## What we welcome

- Bug fixes with a failing test that proves the bug and a passing test that proves the fix.
- Improvements to the governance kernel, policy bundle, or eval suite.
- New tools (must include: permission level declaration, audit event, rollback path, eval coverage).
- Documentation that closes a gap between what the docs claim and what the code does.
- Dependency updates when a security advisory requires it (open an issue first for major bumps).

## What we will not merge

- Changes that weaken the audit invariant (no-audit-no-action).
- Bypasses of the approval gate, policy engine, or kill switch.
- New runtime dependencies without a `docs/dependencies.md` entry and a documented failure-impact + fallback.
- PRs with no tests for new or changed behavior.
- PRs that introduce secrets, credentials, or personal data into the codebase.
- Broad refactors bundled with functional changes — separate them.

## Risk classification

Every PR should state its risk level in the description (Low / Medium / High / Critical per [`CLAUDE.md`](CLAUDE.md) §5). The review depth scales with risk:

| Risk | Minimum bar |
|------|------------|
| Low | `lint` + `typecheck` + `test` pass; brief description |
| Medium | Above + unit tests for new paths; rollback notes |
| High | Above + integration tests; threat model check; audit log events documented |
| Critical | Full review against §57 template; independent sign-off required |

When in doubt, classify higher.

## Governance kernel changes

Changes to `src/kernel/` are **High** risk minimum. Every kernel PR must:

1. Include or update tests in `tests/` that prove the invariant holds.
2. Not introduce any code path that allows a mutating tool to run without a confirmed audit write.
3. Run `npm run eval` and confirm the relevant eval categories still pass at 100%.

Eval gates for prompt-injection and destructive-refusal are 100% release gates enforced in CI.

## New tools

Every new tool must implement the `MutatingTool` interface (or `ReadOnlyTool` for L0) and declare:

```typescript
// required fields in the tool descriptor
permissionLevel: 0 | 1 | 2 | 3 | 4 | 5;
requiresApproval: boolean;
auditRequired: boolean;
allowedPaths?: string[];
deniedPaths?: string[];
rollback: ReversalPlan | 'irreversible';
```

Include at least one eval case in the appropriate `evals/` category.

## Policy changes

Changes to `policies/*.rego` require:

1. A `npm run policy:check` pass against at least one representative action.
2. An update to `catalog/exceptions.yml` if a previously-blocked action is being allowed (with expiry + compensating control).
3. A note in the PR description explaining the threat model impact.

## Commit style

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(kernel): add snapshot integrity check before rollback
fix(audit): redact nested secret fields in SIEM export
docs(threat-model): add supply-chain compromise scenario
test(evals): add prompt-injection case for git push framing
```

Keep commits atomic. One logical change per commit.

## Pull requests

- Target `main`.
- Fill the PR template — risk level, what changed, how to verify, rollback path.
- PRs require passing CI (all five workflows) before merge.
- For High/Critical risk: request a review from a maintainer; do not self-merge.
- Draft PRs are welcome for early feedback.

## Security vulnerabilities

Do **not** open a public issue for security vulnerabilities. Follow the process in [`SECURITY.md`](SECURITY.md).

## Code of conduct

Be direct, be honest about tradeoffs, and be kind. We care about correctness over cleverness and safety over speed.
