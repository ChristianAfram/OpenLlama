# Hooks (v0.8 — B5)

Hooks are user/project-declared subprocesses that fire at lifecycle points during
an `opencli agent` run. They are the first **Extensibility** primitive.

The governance model is **tighten-only**, the same rule that governs config
scopes: a hook may add a restriction, never remove one.

## Lifecycle events

| Event | When | Can block? |
|---|---|---|
| `session_start` | once, before the first model turn | no (informational) |
| `pre_tool` | before each tool call is dispatched | **yes** |
| `post_tool` | after each tool call returns | no (output fenced) |
| `session_end` | once, after the run finishes | no (informational) |

## Configuration — `.opencli/hooks.json`

```json
{
  "hooks": [
    { "event": "pre_tool",  "command": "./scripts/guard.sh", "matcher": "write_file", "name": "write-guard" },
    { "event": "pre_tool",  "command": "node", "args": ["scripts/deny-mcp.js"], "matcher": "mcp:*" },
    { "event": "post_tool", "command": "./scripts/notify.sh", "timeoutMs": 3000 }
  ]
}
```

- `command` runs with **no shell** (arguments are passed as an array).
- `matcher` is a glob matched against the tool name (e.g. `write_file`, `git`,
  `mcp:*`). Absent matcher = every tool. Ignored for `session_start`/`session_end`.
- The lifecycle payload is delivered to the hook on **stdin** as JSON
  (`event`, `session_id`, `correlation_id`, `tool_name`, `tool_args`, `cwd`).
- A missing or malformed `hooks.json` degrades to **no hooks** — a broken config
  never crashes a run and never disables a kernel control.

## Block protocol (pre_tool)

A `pre_tool` hook blocks the tool if **either**:

1. it exits with a **non-zero** status, or
2. it prints `{"decision":"block","reason":"..."}` on stdout (exit 0).

Otherwise the tool is allowed to continue to the kernel's own gates.

A spawn failure or timeout on a `pre_tool` hook is **fail-closed** — the tool is
blocked. On `post_tool` it is a logged no-op.

## Governance invariants

1. **Tighten-only.** A `pre_tool` hook can block a tool the kernel would allow,
   but can **never** permit a tool the kernel blocks, grant an approval, or lower
   a permission level. An L4/L5 mutation without an approval grant stays blocked
   regardless of what any hook returns (eval `HT-002`).
2. **Untrusted output.** Hook stdout is **untrusted external content**. `post_tool`
   output is wrapped in an `<untrusted_external_data>` fence before it enters the
   model context, and is never interpreted as an instruction (eval `HT-003`).
3. **Audited.** Every hook execution writes a `hook_execution` audit event; a
   blocking hook is recorded with `policy_decision: DENY` and the reason
   (eval `HT-004`). Hook auditing is best-effort and is *separate* from the
   executor's no-audit-no-action gate — a hook can never bypass that gate.
4. **No bypass.** Hooks run at the engine's dispatch layer as an *additional*
   restriction. Because they can only add denials, the kernel's guarantees hold
   whether or not a hook runs.

## Eval coverage

`evals/cases/hook-trust.ts` — `HT-001` (block), `HT-002` (cannot force-allow an
L5 mutation), `HT-003` (output fenced), `HT-004` (audited). Gate: 100%.
