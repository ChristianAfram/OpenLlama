# Subagents (v0.8 — B7)

Subagents let the agent delegate a focused sub-task to a child agent and use its
answer. They are the third **Extensibility** primitive (after hooks and skills).

The governance stance is **reach, never privilege**: a subagent extends what the
agent can *attempt in parallel/isolation*, but never what it is *allowed to do*.

## How it works

When subagents are enabled, the agent gains a `delegate` tool:

```
delegate({ task: "Audit src/auth for missing input validation and summarise" })
```

The child runs its own reasoning loop with a fresh context, then returns its
final answer. That answer comes back through the normal tool-result path, so it
is **fenced as untrusted data** in the parent context.

## Governance invariants

1. **No extra privilege.** A subagent runs the *same kernel* — executor, policy
   engine, classifier, audit ledger, kill switch. Like the parent agent loop it
   has **no `ApprovalProvider`**, so it can never execute an L4/L5 action. A
   compromised child's `rm -rf /` is blocked exactly as the parent's would be
   (eval `SUB-002`).
2. **Untrusted output.** A child's answer enters the parent context inside an
   `<untrusted_external_data>` fence and is never treated as an instruction
   (eval `SUB-001`).
3. **Depth-capped.** Delegation nesting is bounded by `maxDepth` (default 2). A
   child at the limit cannot spawn another subagent — the `delegate` call is
   denied and audited as `subagent:denied`, with no grandchild created
   (eval `SUB-003`). This bounds recursion and cost.
4. **Linked, attributable timeline.** A child **shares the parent's
   `correlation_id`** but gets its own `session_id`, so every child action is
   both traceable to the delegation and individually attributable
   (eval `SUB-004`).
5. **Shared kill switch.** The kill switch is shared across the whole tree — a
   single trip halts the parent and all descendants.

## Notes

- Subagents are **not** persisted as top-level resumable sessions; they are
  ephemeral children of the run that spawned them.
- Each subagent has a smaller iteration cap (default 12) because it is focused.
- The `delegate` tool is permission level 1 (orchestration/draft): the call
  itself mutates nothing; any world contact happens inside the child, behind the
  same kernel gates.

## Eval coverage

`evals/cases/subagent-trust.ts` — `SUB-001` (fenced answer), `SUB-002` (no
privilege escalation), `SUB-003` (depth cap), `SUB-004` (shared correlation,
distinct session). Gate: 100%.
