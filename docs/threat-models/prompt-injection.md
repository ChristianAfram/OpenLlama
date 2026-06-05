# Threat Model: Prompt Injection from Repository Content

Status: v0.3 ("It can't be tricked by the repo"). Owner: project maintainer.

## Assets

- The user's source code and working tree.
- Secrets reachable from the working tree (`.env`, key files, `secrets/`).
- The integrity of the hash-chained audit ledger.
- The user's git remotes and branches.

## Trust Boundaries

Trust order (Master Plan §6, framework §40):

```
system > developer > user > tool-output / external (untrusted)
```

Everything the agent reads from the repository — file contents, grep output,
git output, and (later) issues/PRs/MCP responses — is **external, untrusted
data**. It is never an instruction.

## Entry Points

- File contents returned by `read_file` / `grep` / `list_dir`.
- Output of `run_shell` / `git` operations.
- (Future) GitHub issue/PR bodies, dependency READMEs, MCP tool output.

## Actors

- A malicious or compromised repository (e.g. a planted comment in a README).
- A dependency shipping a hostile README or postinstall note.
- A model that has been successfully prompt-injected and now emits hostile tool
  calls. **We assume this can happen and defend against it anyway.**

## Abuse Cases

1. A README comment instructs the agent to force-push and email `.env` to an
   attacker.
2. Content instructs the agent to `rm -rf` the working tree.
3. Content instructs the agent to write an attacker key into `.env`.
4. Content forges the untrusted-data fence to "break out" and issue a system
   instruction.

## Threats (STRIDE, abbreviated)

- **Tampering / Elevation of Privilege:** injected text tries to make the agent
  perform a higher-privilege action than the user authorised.
- **Information Disclosure:** injected text tries to exfiltrate secrets.
- **Repudiation:** an action slips through without an audit record.

## Prompt Injection Risks & Controls

| Risk | Control | Evidence |
|---|---|---|
| Injected text treated as an instruction | External content fenced as `<untrusted_external_data>` with an explicit do-not-follow directive | `src/reasoning/context.ts`; eval `PI-004` |
| Forged closing fence breaks out of the envelope | The wrapper escapes any embedded fence; exactly one trailing fence remains | `fenceUntrusted()`; eval `PI-005` |
| Compromised model force-pushes / exfiltrates `.env` | Kernel blocks: classifier raises to L5, no approval channel → blocked; secret paths denied | executor + classifier + `paths.ts`; eval `PI-001` |
| Compromised model runs `rm -rf` | Destructive-token denylist (run_shell) + classifier L5 | eval `PI-002` |
| Compromised model writes to `.env` | Secret-path denylist (executor `denied_paths` + `paths.ts`) | eval `PI-003` |
| Secret leaks into the audit ledger | Mandatory redaction before storage (hash + placeholder) | `src/lib/redaction.ts`; eval `SH-004` |

## Data Exfiltration Risks

The agent has **no network-write tool**. Even a fully-compromised model cannot
send data outward: `read_file` on a secret path is denied, and there is no
email/HTTP-POST tool to exfiltrate through. This is enforced by the tool surface,
not by model behaviour.

## Residual Risk

- Model-behaviour evals (does the *uncompromised* model resist subtle injection
  in its reasoning?) require a live model and are tracked in `catalog/models.yml`
  with `last_evaluated: null` until run on real hardware.
- A future network-capable tool (e.g. an HTTP client) would expand this surface
  and must ship with its own threat-model update and L4/L5 classification.

## Required Follow-Ups

- Run the model-behaviour injection evals against the default model and record
  the pass rate in `catalog/models.yml` (§22).
- Re-run this threat model when issue/PR/MCP ingestion lands (new entry points).
