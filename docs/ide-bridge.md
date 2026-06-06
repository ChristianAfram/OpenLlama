# IDE Bridge (v0.8 — C1)

The IDE bridge is the data contract the OpenCLI editor integration is built on.
It is the first slice of the **IDE** milestone: rather than embed the kernel in
an editor, an extension drives the CLI and renders a structured event stream.
This keeps every governance gate (executor, policy, approval, audit, kill
switch) in one place — the editor is a thin, untrusted-of-nothing client.

## `opencli agent --json`

Run the agent with `--json` to receive a newline-delimited JSON (NDJSON) event
stream on **stdout**. Human-readable progress (`info`/`warn`) goes to **stderr**,
so stdout is a clean machine channel.

```
$ opencli agent --json "summarise src/kernel"
{"type":"run_start","v":1,"session_id":"…","correlation_id":"…","model":"…","instruction":"summarise src/kernel"}
{"type":"iteration","v":1,"n":1}
{"type":"tool_call","v":1,"name":"list_dir","status":"ok","audit_event_id":"…","feedback":"…"}
{"type":"assistant","v":1,"content":"…"}
{"type":"run_end","v":1,"stop_reason":"final_answer","iterations":2,"tool_calls":1,"answer":"…"}
```

## Event contract

Every event carries `type` and `v` (contract version, currently `1`).

| `type` | Fields | Meaning |
|---|---|---|
| `run_start` | `session_id`, `correlation_id`, `model`, `instruction` | run began |
| `iteration` | `n` | reasoning loop iteration `n` started |
| `assistant` | `content` | the model produced assistant text |
| `tool_call` | `name`, `status`, `audit_event_id`, `feedback` | a tool call resolved |
| `run_end` | `stop_reason`, `iterations`, `tool_calls`, `answer` | run finished |

`tool_call.status` is one of `ok`, `blocked`, `invalid_args`, `error`. The
`audit_event_id` links the call to its row in the audit ledger
(`opencli audit show`), so an editor can deep-link from a tool call to its
forensic record.

## Governance

- **Observational only.** The stream is produced by a read-only `AgentObserver`
  the engine invokes at lifecycle points. It cannot run a tool, mutate state, or
  influence a decision — every world action still flows through the executor and
  is gated and audited identically to a non-`--json` run.
- **Same gates apply.** `--json` changes *output formatting only*. A destructive
  L5 tool call still appears as `status:"blocked"` because the kernel blocked it.
- **Local channel.** The stream is local stdout — the same content the terminal
  would display.

## Consuming from an extension

The reference VS Code extension scaffold lives in [`extension/`](../extension).
It spawns `opencli agent --json`, parses each line with the same contract above,
and renders a run timeline. The extension contains **no kernel logic** — it is a
pure client of this stream and of `opencli audit`.

## Tests

`tests/ide-bridge.test.ts` — serializer round-trip, single-line guarantee, and
the engine's event sequence (run_start → iteration/assistant/tool_call → run_end)
with `ok` / `blocked` / `invalid_args` statuses, plus a proof the observer never
changes the run result.
