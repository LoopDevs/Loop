# scripts/ — repo-infra tooling

Everything here is either wired into `npm run verify` / CI, invoked by an
`npm run` alias, or an operator runbook step named in `AGENTS.md`. If a
script isn't referenced from one of those places (or from this file), it's
dead weight — either wire it up or move it to `archive/`.

This directory is **repo-infra only** — CI gates, dev/release plumbing,
git hooks. Catalog-ops tooling that talks to the production CTX admin API
and external media services lives in `tools/ctx-catalog/` (its own
README + `archive/` convention).

## CI / `npm run verify` gates

| Script                   | What it does                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `verify.sh`              | Runs every local quality check before pushing — the sequential local equivalent of CI (`npm run verify`).                                  |
| `check-audit-policy.mjs` | `npm audit` gate — pinned accepted-moderate set, fails on any high/critical (`npm run audit`, the required "Security audit" CI check).     |
| `test-catalog-tools.sh`  | Runs `--self-test` on every network-free `tools/ctx-catalog/` media-pipeline script, since `tools/` isn't an npm workspace (`test:tools`). |

## Operator / release scripts

| Script                           | What it does                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `bootstrap-e2e-refresh-token.sh` | One-time bootstrap of the `LOOP_E2E_REFRESH_TOKEN` repo secret via a live request-otp → verify-otp round trip. |
| `e2e-real.mjs`                   | Real-CTX e2e purchase probe (`.github/workflows/e2e-real.yml`, workflow_dispatch-only).                        |
| `ci-watch.sh`                    | Polls a PR's CI checks and reports the outcome — local convenience.                                            |

## Git hooks

`hooks/` is wired via husky (`prepare`): commit-msg (commitlint) and a
pre-push warning when another PR is already open (serial-PR discipline).
