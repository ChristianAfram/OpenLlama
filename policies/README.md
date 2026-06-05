# Policies

This is the documented home of OpenLlama's policy bundle (Master Plan §8). The
**executable** bundle lives in [`src/policy/`](../src/policy) — it is implemented
natively in TypeScript and runs **in-process**, so OpenLlama stays a single local
tool with no external policy server and no native build-time toolchain.

> **Why native TS rather than committed `.rego`/WASM here?** The framework
> (`CLAUDE.md` §8) lists "Custom scripts" and "Runtime guardrails" as valid
> policy-as-code, and §15 prefers a small, maintainable local implementation over
> a fragile dependency. Committing `.rego` files that nothing executes would be
> decorative documentation that does not match the system (§26). The TS rules are
> the single source of truth; this README and [`docs/policy.md`](../docs/policy.md)
> are the human-readable bundle. An OPA/WASM compilation path remains an option
> for a future milestone without changing the rule semantics.

## The rules (one module per Master Plan §8 file)

| Master Plan file | Implementation | Decision |
|---|---|---|
| `agent_actions.rego` | `src/policy/rules/agent-actions.ts` | L0–L3 ALLOW · L4 REQUIRE_APPROVAL · L5 REQUIRE_CONFIRMATION |
| `secrets.rego` | `src/policy/rules/secrets.ts` | secret path read/write → DENY |
| `filesystem.rego` | `src/policy/rules/filesystem.ts` | repo-root escape → DENY |
| `git.rego` | `src/policy/rules/git.ts` | force-push / protected-branch → REQUIRE_CONFIRMATION |
| `dependencies.rego` | `src/policy/rules/dependencies.ts` | install → REQUIRE_APPROVAL (DENY in `--enterprise`) |
| `network.rego` | `src/policy/rules/network.ts` | non-allowlisted egress → REQUIRE_APPROVAL (DENY in `--enterprise`) |
| `model_governance.rego` | `src/policy/rules/model-governance.ts` | model failed evals → DENY |
| (cross-cutting) | `src/policy/rules/core.ts` | audit unavailable + high/critical → DENY |

Decisions aggregate **most-restrictive-wins**:
`DENY > REQUIRE_CONFIRMATION > REQUIRE_APPROVAL > ALLOW`.

## Try it

```bash
openllama policy test --json '{"tool":"git","permission_level":4,"git_branch":"main"}'
openllama policy exceptions     # the §25 exception-lifecycle CI gate
```
