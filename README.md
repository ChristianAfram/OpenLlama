# OpenLlama

**Local-first, governance-native, open-source AI coding agent.**

> Status: **pre-alpha** (Prompt 0 — Foundation). Not for production use.

## The thesis

Most coding agents are optimized for capability. OpenLlama is optimized for a
single invariant:

> **No tool that mutates the world runs unless an audit write succeeds first.**

Every action an agent takes — reading a file, proposing a diff, editing code,
running a command, pushing a branch — is risk-classified, policy-checked,
approval-gated where required, and recorded in a tamper-evident, hash-chained
audit ledger *before* the side effect happens. If the audit write fails, the
action does not run. There is no flag, mode, or fast path that bypasses this.

The claim is not "best agent." It is **"the best agent you are allowed to run"** —
on your own hardware, against local models, with a verifiable record of
everything it did.

## What works today (Prompt 0)

This is the foundation milestone. Currently available:

- `openllama chat "<prompt>"` — a **read-only** conversation with a local
  [Ollama](https://ollama.com) model. No tools, no writes, no kernel yet. It can
  only answer.

The governance kernel (audit ledger, executor, risk classifier, approval gate)
and the mutating tools are built in subsequent milestones. See
[`docs/OpenLlama-Master-Plan.md`](docs/OpenLlama-Master-Plan.md) for the full
roadmap and [`CLAUDE.md`](CLAUDE.md) for the production-readiness framework that
governs every change.

## Requirements

- Node.js ≥ 18
- A running [Ollama](https://ollama.com) server with a model pulled, e.g.
  `ollama pull qwen2.5-coder:7b`

## Quick start

```bash
npm install
npm run build
node dist/index.js chat "explain what a hash chain is"
```

Configuration lives in `~/.config/openllama/config.json`. You can override the
model and host per-run with `--model` / `--host`, or via the `OPENLLAMA_MODEL`
and `OLLAMA_HOST` environment variables (see `.env.example`).

## Development

```bash
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # tsup -> dist/
```

## License

[MIT](LICENSE) — *provisional*. The license and project name are revisited
before any public launch (see Master Plan §23).
