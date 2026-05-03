# Phase 4 — Dependencies & Supply Chain

- Capture date: 2026-04-29
- Commit audited: `761107214e436613a7fbbe4e91e82d197c521f71`
- Auditors: Codex, worker `Bernoulli`
- Phase status: complete

## Evidence

- Audit output: [artifacts/npm-audit-high.json](./artifacts/npm-audit-high.json)

## Findings logged

- `A3-028` High — the web release Docker builder re-enables dependency lifecycle scripts with a blanket `npm rebuild`.
- `A3-029` Medium — the enforced dependency gate ignores known moderate advisories already present in the lockfile.

## Clean bill so far

- Root lockfile, exact-version workspace manifests, and Dependabot coverage are all in place.
- GitHub Actions pinning and container base-image pinning are materially solid.
