# OpenLlama

**Local-first, governance-native, open-source AI coding agent.**

> Status: **pre-alpha** (v0.2 — "It respects boundaries"). Not for production use.

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

## What works today

The governance kernel and the read/draft/low-risk tool surface are in place.
Built and tested across milestones v0.1–v0.2:

- **Hash-chained audit ledger** — every action is recorded in an append-only
  SQLite ledger; `hash = sha256(prev_hash + canonical_json(body))`. UPDATE/DELETE
  are blocked at the database level; any retroactive edit breaks the chain and is
  detected by `audit verify`. Secrets are redacted before storage — the ledger
  records *that* a secret was touched plus a SHA-256, never the value.
- **The no-audit-no-action executor** — the only component that touches the
  world. A mutating tool's `plan()` computes the change (and its before/after
  blob hashes) with **zero** side effects; the executor appends the audit event
  first and only then runs the side effect. An audit-write failure means no
  filesystem change, structurally.
- **Deterministic risk classifier** — maps every action to a permission level
  (0–5). Hard rules: destructive commands (`rm -rf`, `git push --force`,
  `DROP TABLE`, …), protected paths (`.env`, `.git/config`, CI workflows), and
  protected branches (`main`, `release/*`) are always Level 5. A model opinion
  may only *raise* the level, never lower it.
- **Approval gate** — Level 4/5 actions require a **scoped, expiring** approval
  grant; Level 5 additionally requires a manual, action-specific confirmation
  phrase. Overbroad ("approve everything") grants are refused. The agent is given
  no approval channel, so it can never approve its own action.
- **Reasoning loop** — an agent loop against a local
  [Ollama](https://ollama.com) model, with a hard iteration cap and a
  self-repair budget for invalid tool calls. External content (file contents,
  tool output) is fenced as untrusted data, never treated as instructions.
- **Tools** — `read_file`, `list_dir`, `grep` (L0), `propose_diff` (L1), and
  `write_file` (L3, new files only). The higher-risk mutating tools
  (`edit_file`, `git`, `run_shell`) arrive next.

### Commands

```bash
openllama chat  "<prompt>"            # read-only conversation with a local model
openllama agent "<task>"              # the audited agent loop (read + draft + L3 write)
openllama exec  <tool> --json '<args>'  # run one tool through the kernel (no model)
openllama audit show                  # human-readable event timeline
openllama audit verify                # check the hash chain is intact
openllama audit export [--siem]       # JSONL export for a SIEM
```

See [`docs/demo.md`](docs/demo.md) for the 90-second thesis demo (write a file →
show the ledger → tamper with it → watch the chain break).

The remaining milestones (independent verifier, policy-as-code, kill switch,
SIEM/OTel export, rollback engine) are tracked in
[`docs/OpenLlama-Master-Plan.md`](docs/OpenLlama-Master-Plan.md).
[`CLAUDE.md`](CLAUDE.md) is the production-readiness framework that governs every
change.

## Requirements

- Node.js ≥ 18
- A running [Ollama](https://ollama.com) server with a model pulled, e.g.
  `ollama pull qwen2.5-coder:7b` (only needed for `chat` and `agent`; `exec` and
  `audit` run without a model)

## Quick start

```bash
npm install
npm run build
node dist/index.js chat "explain what a hash chain is"

# Run a tool through the governance kernel — no model required:
node dist/index.js exec write_file --json '{"path":"hello.txt","content":"hi\n"}'
node dist/index.js audit verify
```

Configuration lives in `~/.config/openllama/config.json`. You can override the
model and host per-run with `--model` / `--host`, or via the `OPENLLAMA_MODEL`
and `OLLAMA_HOST` environment variables (see `.env.example`). The audit ledger
path can be overridden with `OPENLLAMA_AUDIT_DB`.

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
