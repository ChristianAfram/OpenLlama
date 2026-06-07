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

## `opencli audit timeline --json`

The companion to the run stream: the past, grouped for display. It folds the flat
audit ledger into **runs** keyed by `correlation_id` — a top-level agent run and
any subagents it spawned share one correlation id, so they appear as a single run
with multiple `sessions`. Each run carries ordered `entries` and per-result
`counts`:

```jsonc
{
  "runs": [
    {
      "correlation_id": "…",
      "sessions": ["parent", "child"],
      "started_at": "…", "ended_at": "…",
      "counts": { "total": 5, "executed": 3, "blocked": 1, "failed": 1 },
      "entries": [
        { "event_id": "…", "seq": 12, "action": "run_shell", "tool_name": "run_shell",
          "result": "blocked", "permission_level": 5, "policy_decision": "REQUIRE_CONFIRMATION",
          "session_id": "parent", "source_kind": null, "target": "shell:…" }
      ]
    }
  ],
  "total_events": 5
}
```

The model is **display-only**: `buildTimeline` reshapes the authoritative ledger
and makes no decisions. Without `--json` the command prints a compact text tree.

## `opencli session list --json`

The resume picker's data source. Emits the resumable sessions as display
summaries so an editor can show a quick-pick and relaunch
`opencli agent --resume <id> --json`:

```jsonc
{
  "sessions": [
    { "session_id": "…", "correlation_id": "…", "status": "completed",
      "created_at": "…", "updated_at": "…", "model": "…", "cwd": "…",
      "turns": 6, "total_tokens": 1820, "stop_reason": "final_answer",
      "is_subagent": false }
  ],
  "count": 1
}
```

`is_subagent` marks ephemeral subagent children; the editor offers only
top-level sessions (`is_subagent: false`) for resume. Like the timeline, this is
display-only reshaping of session-store metadata.

## Consuming from an extension

The reference VS Code extension scaffold lives in [`extension/`](../extension).
It spawns `opencli agent --json`, parses each line with the same contract above,
renders a run timeline, and offers a **resume picker** backed by
`opencli session list --json`. The extension contains **no kernel logic** — it is
a pure client of these streams and of `opencli audit`.

## Tests

`tests/ide-bridge.test.ts` — serializer round-trip, single-line guarantee, and
the engine's event sequence (run_start → iteration/assistant/tool_call → run_end)
with `ok` / `blocked` / `invalid_args` statuses, plus a proof the observer never
changes the run result.
