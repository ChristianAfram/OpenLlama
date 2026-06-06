# Config Scopes

Config scopes landed in **v0.7** as the first platform-layer feature and are
available now.

OpenCLI resolves configuration from up to five **scopes**, merged in increasing
order of precedence:

```
builtin  <  user  <  project  <  env  <  flag
```

| Scope    | Source                                   | Trust                       |
|----------|------------------------------------------|-----------------------------|
| builtin  | compiled defaults                        | trusted                     |
| user     | `~/.config/openllama/config.json`        | the operator                |
| project  | `.opencli/config.yaml` (walked up from cwd) | **checked-in, untrusted authors** |
| env      | `OPENCLI_*` / legacy `OPENLLAMA_*`        | the operator's shell        |
| flag     | CLI options (`--model`, `--enterprise`)  | the operator's invocation   |

Implemented in `src/lib/config-scopes.ts`; the single entry point is
`loadLayeredConfig({ cwd, env, flags })`, which returns the merged
`EffectiveConfig`, an `origins` map (which scope set each governed field), and a
list of `rejections` (loosening attempts that were dropped).

## Governed ("locked") security fields

The `[security]` group is **tighten-only**. Because `.opencli/config.yaml` is
committed to the repository — and therefore editable by anyone who can open a
pull request — a higher-precedence scope must never be able to *weaken* a control
that a lower-precedence scope established.

| Field                   | Type       | "Tighten" means | Merge rule | A higher scope may NOT |
|-------------------------|------------|-----------------|------------|------------------------|
| `security.enterprise`   | `boolean`  | enable          | OR across scopes | disable what a lower scope enabled |
| `security.denied_paths` | `string[]` | add a path      | union across scopes | remove a lower scope's path |

A loosening attempt (e.g. a project file setting `enterprise: false` over a user
`true`) is **ignored** and recorded as a `ConfigRejection`. The merge never
throws: a malformed or malicious project file degrades to "no effect", not a
crash. Unknown keys and ill-typed values are dropped by `coerceScopedConfig`.

Non-locked fields (`profiles`, `activeProfile`, `context.budget`,
`context.compaction`) follow plain last-writer-wins precedence.

## Audit trail

On every `opencli agent` run the effective security posture is written to the
audit ledger as an `effective_config` event (permission level 0, informational):

- the effective `enterprise` value and the scope that set it,
- the effective `denied_paths`,
- the context budget / compaction strategy,
- a list of any `rejected_overrides` (scope:field) that were dropped.

Inspect it with `opencli audit show`. Config logging is non-fatal — it does not
gate world mutations, so a ledger failure warns rather than aborts the run.

## Why merge-time enforcement

Enforcement happens at **merge time** (the primary control) so that a loosening
attempt can never reach the policy engine, executor, or any tool in the first
place. This is the shipping behaviour in v0.7.

A defense-in-depth `config_integrity` *policy rule* (which would DENY a mutation
whose governing value originated from a project scope attempting to loosen) is a
future addition: **v0.8 expands config scopes** with that policy rule and managed
org-policy signing, once project-scoped values begin to drive MCP/network policy
directly. The merge-time control above already enforces tighten-only today.
