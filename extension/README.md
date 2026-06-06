# OpenCLI for VS Code

A thin VS Code client for the [OpenCLI](../README.md) governance-native agent.

> **This extension contains no kernel logic.** It spawns the `opencli` binary and
> renders its output. Every governance gate — the executor, policy engine,
> approval flow, audit ledger, and kill switch — lives in the CLI. The editor can
> only *ask* the CLI to act; the CLI gates and audits everything. There is no new
> path to a side effect here.

## Commands

| Command | What it runs |
|---|---|
| **OpenCLI: Run Agent** | `opencli agent --json <instruction>` — streams the run into the OpenCLI output channel |
| **OpenCLI: Show Audit Timeline** | `opencli audit show` |
| **OpenCLI: Activate Kill Switch** | `opencli kill-switch activate` (after a modal confirm) |

The agent run is driven by the NDJSON event stream documented in
[`docs/ide-bridge.md`](../docs/ide-bridge.md). Each `tool_call` event includes
its `audit_event_id`, linking the action to its row in the audit ledger.

## Settings

- `opencli.binaryPath` — path to the `opencli` executable (default: `opencli`).

## Build

```
cd extension
npm install
npm run build
```

This is a reference scaffold. It is intentionally kept out of the root build and
test pipeline; the logic-bearing, governance-critical parts of the bridge live in
the main package (`src/ide/`) and are covered by `tests/ide-bridge.test.ts`.
