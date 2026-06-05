# Rollback Plan: OpenCLI Mutations

*Framework §49, §55 — Master Plan §13*

## Trigger Conditions

Initiate rollback when:
- A mutation was applied but is incorrect (wrong content, wrong file, wrong branch).
- The kill switch was tripped after a mutation executed.
- A security or policy incident requires reverting agent-applied changes.
- Post-launch validation shows an agent action was wrong.

## Immediate Mitigation

```bash
# 1. Halt all further mutations immediately.
opencli kill-switch activate --reason "<reason>"

# 2. Verify the audit chain is intact.
opencli audit verify
```

## Rollback Method

OpenCLI records every mutation in a hash-chained audit ledger. The rollback
engine consults the ledger and the snapshot store to reverse a specific event.

```bash
# Show recent mutations.
opencli audit show

# Reverse a specific mutation by its audit event_id.
opencli audit rollback <event_id> [--cwd <repo-root>]
```

## Supported Rollbacks

| Tool | Rollback method | Requirement |
|---|---|---|
| `write_file` | Delete the created file | File must not have been modified after creation |
| `edit_file` | Restore before-content from snapshot store | Snapshot store must be populated (requires `snapshots` option at execution time); file must not have been edited again |

## Unsupported Rollbacks (Irrecoverable)

| Tool | Reason | Manual recovery |
|---|---|---|
| `run_shell` | Shell side effects are arbitrary | Identify the side effect from the audit event and apply the inverse manually |
| `git commit` | Commit is in local git history | `git reset --hard <before_sha>` (recorded in `rollback_path` of the audit event) |
| `git push` | Remote branch was updated | `git push --force-with-lease origin <branch> <before_sha>` — operator action required |

## Commands

```bash
# View all events for a specific file or tool.
opencli audit show | grep <path>

# Rollback a write_file.
opencli audit rollback <event_id>

# Rollback a git commit (manual).
git reset --hard <before_sha>   # before_sha is in the audit event's rollback_path

# Rollback a git push (manual).
git push --force-with-lease origin <branch>:<before_sha>
```

## Feature Flags

No feature flags currently; kill switch is the runtime halt mechanism.

## Database Rollback

The audit ledger is append-only — it cannot be rolled back. Events record
the **intent and evidence**, not the world state. Rollback is performed on the
actual files/git state, not the ledger.

## Config Rollback

Kill switch state: `~/.config/openllama/kill-switch.json` (v0.7 legacy path) — delete or
`opencli kill-switch deactivate`.

Snapshot store: `~/.local/share/openllama/snapshots/` (v0.7 legacy path) — blobs are content-
addressed and accumulate; no cleanup required unless disk is constrained.

## Prompt or Model Rollback

1. Update `catalog/models.yml` to remove or mark the problematic model.
2. In `--enterprise` mode, the agent will refuse to start with the model.
3. Pass a different `--model` flag to the agent/chat command.

## Data Repair

If a rollback leaves a file in an unexpected state:
1. Check git blame / log for the file's history.
2. `git show <commit>:<path>` to inspect any prior version.
3. Restore the desired version manually, then run `opencli exec write_file` (or edit via editor) to re-record the change in the audit ledger.

## Verification

After rollback:
```bash
opencli audit verify     # chain must still be intact
opencli audit show       # confirm rollback event is recorded
```

Confirm the file/directory state matches expectation:
```bash
cat <path>
ls <dir>
git status
```

## Expected User Impact

- `write_file` rollback: the newly-created file disappears.
- `edit_file` rollback: the file returns to its pre-edit state.
- A rollback audit event is always recorded; the chain remains valid.

## Owner

Project maintainer.
