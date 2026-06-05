# Runbook: OpenLlama Agent

## Owner

Project maintainer (christianafram54@gmail.com)

## Purpose

OpenLlama is a local-first, governance-native AI coding agent. It reads source
files, proposes diffs, and — when the user approves — applies edits under a
hash-chained audit invariant: **no tool that mutates the world runs unless an
audit write succeeds first**.

## Critical Flows

| Flow | Trigger | What happens |
|---|---|---|
| Agent read | `openllama agent "<task>"` | Model produces tool calls; L0/L1 tools run via dispatcher |
| Mutation (L3) | `write_file` | Executor: plan → snapshot (if needed) → audit write → apply |
| Mutation (L4) | `edit_file`, `git commit` | As above + approval gate |
| Mutation (L5) | `git push` to main | As above + manual confirmation phrase |
| Kill switch | `openllama kill-switch activate` | All mutations blocked, ledger event written |
| Rollback | `openllama audit rollback <event_id>` | Engine reverses the recorded mutation |

## Dependencies

- **SQLite ledger** — `~/.local/share/openllama/audit.sqlite` (or `OPENLLAMA_AUDIT_DB`)
- **Snapshot store** — `~/.local/share/openllama/snapshots/` (content-addressed blobs)
- **Kill switch state** — `~/.config/openllama/kill-switch.json` (or `OPENLLAMA_CONFIG_DIR`)
- **Ollama** — local model server, only needed for `agent` and `chat` commands

## Dashboards

`openllama audit metrics` — blocked-action rate, approval-denial rate,
injection-detection count, consecutive-denial peak, per-tool counts.

`openllama audit show` — human-readable event timeline.

## Alerts (manual, local-only at this milestone)

| Condition | Check | Action |
|---|---|---|
| Kill switch tripped | `openllama kill-switch status` exits 1 | Investigate `activated_at`, `triggered_by`, `reason`; deactivate when safe |
| Chain broken | `openllama audit verify` exits 1 | Treat as incident; do not proceed with mutations |
| Consecutive denials | `audit metrics` shows peak ≥ 5 | Review blocked events; check for model compromise or prompt injection |

## Common Failures

### "kill switch is active" on every mutation
**Cause:** kill switch was activated (manual, consecutive denials, or cost cap).
**Fix:** `openllama kill-switch status` to see the reason; then `openllama kill-switch deactivate` if appropriate.

### "approval denied / no approval channel is available" for L4/L5
**Cause:** Running via `agent` loop — the agent cannot approve itself.
**Fix:** Use `openllama exec <tool> --json '<args>'` from the terminal for interactive approval.

### "audit write failed; side effect NOT performed"
**Cause:** SQLite ledger is locked, corrupt, or the directory is unwritable.
**Fix:** Check `OPENLLAMA_AUDIT_DB` path permissions. If the ledger is corrupt, see Disaster Recovery below.

### "snapshot not found for ref ..."
**Cause:** `edit_file` was executed without a snapshot store (e.g. via exec command, or snapshots dir was deleted).
**Fix:** Rollback is not available for this event. Apply the inverse edit manually or restore from git.

## Recovery Steps

### Reverse a specific mutation
```bash
openllama audit rollback <event_id>
```
Supported: `write_file` (delete), `edit_file` (restore from snapshot).
Unsupported: `run_shell`, `git` (instructions printed).

### Manually reverse an edit when snapshot is missing
Look up the before-state in git:
```bash
git log --oneline -- <path>
git show <commit>:<path> > <path>   # restore the version before the edit
```

### Inspect the audit ledger
```bash
openllama audit show
openllama audit verify
openllama audit export --siem > events.jsonl
openllama audit export --otel > events-otel.jsonl
```

## Rollback Steps

See [docs/rollback.md](rollback.md) for the full rollback plan per change type.

## Kill Switch

```bash
openllama kill-switch status      # exits 1 if active
openllama kill-switch activate    # halt all mutations
openllama kill-switch deactivate  # re-enable mutations
```

Automated triggers (wired in the reasoning engine):
- 5 consecutive policy denials
- Token cap breach (`maxTotalTokens`)

## Data Repair

If a mutation was applied but its audit event is corrupt:
1. `openllama audit verify` — confirm the break.
2. Do NOT attempt to fix the ledger manually (the chain will break).
3. Note the break point (seq, event_id).
4. Use git to determine the actual state of affected files.
5. File an exception in `catalog/exceptions.yml`.

## Security Checks

On any suspicion of compromise:
1. `openllama kill-switch activate --reason "security incident"`
2. `openllama audit verify` — confirm chain is intact.
3. `openllama audit export --siem` — pipe to Splunk / grep for anomalies.
4. Review `policy_decision=DENY` events for injection attempts.

## Escalation

Solo project; owner is the maintainer. For compliance evidence: `audit export --siem`.

## Post-Incident Checklist

- [ ] Kill switch deactivated (if appropriate)
- [ ] Chain verified (`audit verify`)
- [ ] Affected mutations identified and reversed or documented
- [ ] Exception record added to `catalog/exceptions.yml` for accepted residual risk
- [ ] Snapshot store verified (not deleted)
- [ ] Model governance re-checked (`--enterprise` mode if warranted)
