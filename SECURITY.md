# Security Policy

> Stub policy for the pre-alpha phase. A full disclosure SLA and threat-surface
> writeup land in the public-beta hardening milestone (Master Plan §16, §19).

## Status

OpenLlama is **pre-alpha** and not intended for production use. Its security
model is under active construction. The core invariant — no world-mutating
action without a confirmed audit write — is not yet implemented (it arrives in
the v0.1 milestones). Do not rely on OpenLlama for any security-sensitive task
yet.

## Reporting a vulnerability

If you find a security issue, please report it privately rather than opening a
public issue:

- Use GitHub's **private vulnerability reporting** ("Report a vulnerability" on
  the Security tab), or
- Email the maintainer.

Please include reproduction steps and the affected version/commit. We will
acknowledge receipt and work with you on a fix and coordinated disclosure. A
formal response-time SLA will be published with the public beta.

## Scope

In scope: the OpenLlama CLI and its governance kernel (once implemented).
Out of scope (for now): the local model runtime (Ollama) and third-party
dependencies — report those upstream.

## Secrets

Never include secrets in issues, PRs, logs, or test fixtures. CI runs a secret
scanner; the audit ledger redacts secret-looking values by design (Prompt 1+).
