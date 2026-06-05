# Maintainers

## Current maintainers

| Name | GitHub | Role | Areas |
|------|--------|------|-------|
| Christian Afram | @christianafram | Lead maintainer | Governance kernel, policy engine, eval suite, release engineering |

## Governance model

OpenCLI follows a **Benevolent Dictator For Now** (BDFN) model while the project is pre-1.0. The lead maintainer holds final merge authority and release sign-off.

As the contributor base grows and the project reaches v1.0, governance will transition toward a **lazy consensus / RFC process**: significant changes are proposed as issues, a review window of at least 7 days applies, and silence is consent. Vetoes must be substantive (technical or security) and argued in writing.

## Maintainer responsibilities

A maintainer is expected to:

- Review PRs within 7 business days (security patches: 48 hours).
- Enforce CI gates — do not merge a PR with failing checks.
- Keep the exception catalog (`catalog/exceptions.yml`) up to date; expired entries must be resolved before they block CI.
- Own the security disclosure process per [`SECURITY.md`](SECURITY.md).
- Keep the `catalog/models.yml` registry current when new model versions are tested.
- Cut releases per the release checklist (`.github/workflows/release.yml` + steps below).

## Release process

1. All CI checks pass on `main`.
2. Run `npm run eval` locally; confirm no regression in eval gate categories.
3. Update `CHANGELOG.md` (or create for the first release) with the milestone summary.
4. Bump `version` in `package.json` to match the milestone (e.g. `0.8.0`).
5. Commit: `chore(release): v0.8.0`.
6. Tag: `git tag v0.8.0 && git push origin v0.8.0`.
7. The `release.yml` workflow triggers: it builds, attaches `sbom.json`, and publishes a GitHub Release as a draft.
8. Review the draft release; add release notes; publish.
9. Announce on the project's chosen channels.

Releases are source-distributed via git. Binary signing (cosign / GPG) is tracked as EX-2026-002 for v0.8.

## Becoming a maintainer

Sustained, high-quality contributions to the governance kernel or eval suite are the path. There is no formal application process; the lead maintainer will reach out. Maintainer status is role-based, not honorary — it comes with merge responsibility and the expectation of responsiveness.

## Stepping down

A maintainer who needs to step back should:

1. Open an issue marked `governance`.
2. Ensure no open security issues are left unaddressed.
3. Transfer any in-progress exception records or exception lifecycle items.

The project should never be without at least one active maintainer. If the lead maintainer is unavailable for more than 30 days without notice, a community RFC on succession is appropriate.
