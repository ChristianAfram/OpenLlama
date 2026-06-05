# The 90-second OpenCLI thesis demo

This is the demo that *is* OpenCLI's pitch: a mutating action is gated by a
confirmed audit write, the action lands in a tamper-evident ledger, and any
retroactive edit to that ledger is detected instantly.

> Run it yourself with [`scripts/demo.sh`](../scripts/demo.sh), or step through
> the commands below. No model or network required — `opencli exec` runs a
> single tool through the exact same governance kernel the agent uses.

## Walkthrough

```console
$ export OPENLLAMA_AUDIT_DB=$(pwd)/.audit.sqlite

# 1. Create a file. This routes through the executor: classify → AUDIT → only
#    then write. If the audit write had failed, no file would have been created.
$ opencli exec write_file --json '{"path":"feature.txt","content":"new feature code\n"}'
✓ executed (audit 69e5701d-d2bb-43fc-a86c-6b1c4c06f041)
created new file feature.txt (17 bytes)
rollback: delete feature.txt

# 2. The file is there.
$ cat feature.txt
new feature code

# 3. The action is on the ledger.
$ opencli audit show
[1] 2026-06-04T13:52:44.297Z  write_file (write_file)
    actor:  agent:opencli
    target: feature.txt
    result: executed
    risk:   low / L3
    hash:   329fc481d38bac6e…

# 4. The hash chain is intact.
$ opencli audit verify
✓ Chain intact — 1 event(s) verified.

# 5. Now TAMPER: rewrite the event directly in SQLite (and even drop the
#    append-only trigger first). This is the attacker who edits the log.
$ sqlite3 .audit.sqlite "DROP TRIGGER no_update_events;
                         UPDATE events SET target='EVIL.txt' WHERE seq=1;"

# 6. The tamper is caught immediately — the recomputed hash no longer matches.
$ opencli audit verify
✗ Chain BROKEN at seq 1:
  seq 1: hash mismatch (recomputed 7aec3236…, stored 329fc481…)
exit code: 1
```

## Why this matters

The mutation in step 1 could not have happened without the audit write in front
of it — that is enforced in `src/kernel/executor.ts`, not promised in docs. And
once written, the record cannot be altered without detection (step 6), because
each event's hash chains the previous one (`src/kernel/audit.ts`).

That combination — **no action without a logged record, and no silent edit of
the record** — is the property a compliance reviewer actually needs, and it is
an architectural guarantee rather than a policy.
