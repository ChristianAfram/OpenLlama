# Disaster Recovery: OpenLlama

*Framework §19 — Master Plan §14 — v0.6 milestone*

**Scope:** local-only deployment on an operator workstation. No cloud infra,
no shared database, no production service yet. This document covers the minimal
DR posture for the pre-alpha milestone. A production DR plan is required before
v0.7 (public beta).

---

## RTO / RPO

| Asset | RTO | RPO | Notes |
|---|---|---|---|
| Audit ledger | 0 min (no restore; append-only) | 0 | Append-only; cannot be destroyed by the agent |
| Snapshot store | Minutes (recreate from git) | Last mutation | Blobs are re-creatable from git history |
| Kill switch state | Seconds (delete file or deactivate) | N/A | File-backed; trivially reset |
| Source files | Per git restore | Last commit | Agent mutations are tracked in the ledger |
| Ollama model | Minutes (ollama pull) | N/A | Model is re-downloaded; not stored in repo |

---

## Backup

**Audit ledger** (`~/.local/share/openllama/audit.sqlite`):
- No automated backup at this milestone.
- For compliance use cases, export before destructive operations:
  ```bash
  openllama audit export --siem > audit-backup-$(date +%Y%m%d).jsonl
  ```
- *Restore not tested (pre-alpha).* JSONL export is the off-system copy.

**Snapshot store** (`~/.local/share/openllama/snapshots/`):
- Content-addressed blobs; identical content → identical file name.
- Can be recreated from git history if lost.
- *Restore not tested.*

**Source files** (in git repo):
- Protected by git. Every mutation made by the agent is preceded by an audit
  event containing before/after hashes and, for `edit_file`, a snapshot.
- `git log --all --diff-filter=M` shows which files were modified.

---

## Restore Procedures

### 1. Audit ledger corruption

```bash
# Detect:
openllama audit verify
# → prints seq of first broken link

# Recover:
# There is no repair path for a broken chain — this is a security property.
# The JSONL export (if taken) is the off-system audit record.
# File a security incident if unexpected corruption is found.
```

**Status: restore procedure documented; not drilled.**

### 2. Snapshot store deleted

```bash
# Re-create blobs from git for modified files:
git log --oneline -- <path>
git show <commit>:<path> > /tmp/before.txt
sha256sum /tmp/before.txt   # matches the before_hash in the audit event

# Copy to the snapshot store manually:
mkdir -p ~/.local/share/openllama/snapshots
cp /tmp/before.txt ~/.local/share/openllama/snapshots/<sha256-hex>
```

**Status: documented; not drilled.**

### 3. Kill switch stuck active

```bash
openllama kill-switch deactivate
# or:
rm ~/.config/openllama/kill-switch.json
```

**Status: verified in CI (`kill-switch.yml` workflow).**

### 4. Source file corrupted by a bad agent mutation

```bash
# Find the event:
openllama audit show | grep <path>

# Roll back if snapshot exists:
openllama audit rollback <event_id>

# Or restore from git:
git checkout HEAD -- <path>
```

**Status: rollback tested via `tests/rollback.test.ts` and `evals/rollback-correctness`.**

### 5. Ollama model unavailable

```bash
ollama pull <model-name>
```

`agent` and `chat` commands need the model; `exec`, `audit`, `eval`, and
`kill-switch` commands run without it.

**Status: no DR action needed; model is re-downloadable.**

---

## Disaster Recovery Drills

The following must be drilled before v0.7 (public beta):

| Drill | Description | Status |
|---|---|---|
| Kill switch | Status/activate/deactivate lifecycle | ✓ Verified in CI |
| Rollback (write_file) | Delete a created file | ✓ Tests + evals |
| Rollback (edit_file) | Restore prior content from snapshot | ✓ Tests + evals |
| Ledger export | JSONL + OTel export to stdout | ✓ `audit export` command |
| Chain verification | `audit verify` detects tampering | ✓ Tests (audit.test.ts) |
| Snapshot restore | Recreate blob from git | Not drilled |
| Ledger restore from JSONL | Import exported JSONL back into a new ledger | Not implemented |
| Model rollback | Change model in catalog + agent refuses | ✓ Model governance tests |

---

## Known Gaps (Pre-Alpha)

| Gap | Risk | Compensating control | Exception |
|---|---|---|---|
| No automated ledger backup | Data loss if SQLite file is deleted | JSONL export before operations | Accept until v0.7 |
| Ledger JSONL re-import not implemented | Cannot restore chain after db loss | Off-machine export is the record | Accept until v0.7 |
| Snapshot store not backed up | Lost snapshots = unrecoverable edits | Git history is the fallback | Accept until v0.7 |
| No alerting for chain break | Break may go unnoticed | `audit verify` in post-session scripts | Accept until v0.7 |

---

## Incident Response Path

1. Halt mutations: `openllama kill-switch activate --reason "<incident>"`
2. Verify chain: `openllama audit verify`
3. Export evidence: `openllama audit export --siem > evidence-$(date +%Y%m%d-%H%M%S).jsonl`
4. Inspect recent events: `openllama audit show -n 50`
5. Review metrics: `openllama audit metrics`
6. Identify affected files; reverse with `audit rollback` or git
7. Document in `catalog/exceptions.yml` if residual risk is accepted
8. Deactivate kill switch when safe: `openllama kill-switch deactivate`
