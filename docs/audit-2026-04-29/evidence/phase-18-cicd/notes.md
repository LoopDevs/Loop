# Phase 18 — CI/CD & Release Controls

- Capture date: 2026-04-29
- Commit audited: `761107214e436613a7fbbe4e91e82d197c521f71`
- Auditors: Codex, worker `Helmholtz`
- Phase status: in-progress

## Findings logged

- `A3-020` Medium — the manual real-wallet workflow drops the repo’s hardened `--ignore-scripts` install posture.
- `A3-030` Medium — privileged workflows still fetch npm CLIs outside the lockfile and Dependabot path.
- `A3-026` Medium — `lint:docs` currently fails on a checked-in stale historical reference.

## Cross-phase note

- The broader live-merge-gate weakness is already logged as `A3-001` under phase 1 and is corroborated by this CI/CD pass.
