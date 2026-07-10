# scripts/ — repo-infra tooling

Everything here is either wired into `npm run verify` / CI, invoked by an
`npm run` alias, or an operator runbook step named in `AGENTS.md`. If a
script isn't referenced from one of those places (or from this file), it's
dead weight — either wire it up or move it to `archive/`. This index exists
so the pile doesn't silently regrow (§P3 scripts-pile cleanup,
comprehensive-audit-2026-06-11.md Part IV phase 9).

This directory is **repo-infra only** — CI gates, dev/release plumbing,
git hooks. Catalog-ops tooling that talks to the production CTX admin API
and external media services lives in `tools/ctx-catalog/` (its own
README + `archive/` convention, disposed of in the same phase-9 pass).

## CI / `npm run verify` gates

| Script                         | What it does                                                                                                                                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify.sh`                    | Runs every local quality check before pushing — the sequential local equivalent of the CI `quality` job (`npm run verify`).                                                                                                  |
| `lint-docs.sh`                 | Checks docs stay in sync with code: env vars ↔ `.env.example`, routes ↔ `architecture.md`, stale-file references, shared exports, Fly config validation, and more (`npm run lint:docs`).                                     |
| `check-openapi-parity.mjs`     | Static route-mount ↔ OpenAPI-registration cross-check — missing registrations, missing 429s, 403-vs-404 on `/api/admin` (`npm run check:openapi-parity`).                                                                    |
| `check-shared-type-parity.mjs` | ADR 019 contract-parity detector — flags a type name hand-duplicated on both sides of the web↔backend boundary instead of living in `@loop/shared`. Invoked directly by `verify.sh` (no separate `npm run` alias).           |
| `check-dead-flags.mjs`         | Every env var declared in `env.ts` must actually be read somewhere in backend source (`npm run check:dead-flags`).                                                                                                           |
| `check-money-invariants.mjs`   | Static presence/shape check for every DB-tier money invariant `docs/invariants.md` documents (emission-conservation trigger, payout/settlement unique indexes, ledger CHECK constraints) (`npm run check:money-invariants`). |
| `check-audit-policy.mjs`       | `npm audit` gate — pinned accepted-moderate set, fails on any high/critical (`npm run audit`, the required "Security audit" CI check).                                                                                       |
| `check-env-perms.sh`           | Hygiene nudge (A4-116): warns (never fails) on permissive file-mode bits on git-ignored `.env` files.                                                                                                                        |
| `check-bundle-budget.sh`       | Fails if the web SSR client bundle or any single JS chunk crosses its size ceiling (A2-1711) (`npm run check:bundle-budget`).                                                                                                |
| `check-admin-bundle-split.sh`  | Asserts admin routes ship as their own code-split chunks, never bundled into the entry/root chunk every visitor downloads (A2-1115). Runs in the CI `build` job.                                                             |
| `postgres-init.sh`             | Docker-entrypoint init script — creates the `loop_test` database on a fresh Postgres volume (`docker-compose.yml`, vitest integration suites).                                                                               |
| `scaffold-endpoint.mjs`        | Endpoint scaffold generator (hardening D3) — writes the handler + test in the right tier shape and prints the route-mount/OpenAPI paste-snippets. Pairs with the `/add-endpoint` skill.                                      |
| `test-catalog-tools.sh`        | Runs `--self-test` on every network-free `tools/ctx-catalog/` media-pipeline script, since `tools/` isn't an npm workspace vitest covers (`npm run test:tools`).                                                             |

## Operator / release scripts

Named explicitly in `AGENTS.md` §Operator scripts (Phase-1 release path):

| Script                           | What it does                                                                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `preflight-tranche-1.sh`         | Diffs `flyctl secrets list` against the required Tranche-1 secret set — the pre-`flyctl deploy` gate. Never prints values.                                                                                         |
| `bootstrap-e2e-refresh-token.sh` | One-time bootstrap of the `LOOP_E2E_REFRESH_TOKEN` repo secret via a live request-otp → verify-otp round trip.                                                                                                     |
| `e2e-real.mjs`                   | The real Tranche-1 e2e purchase check — loop-native only (`POST /api/orders/loop`) against production CTX. Invoked by `.github/workflows/e2e-real.yml` and `bootstrap-e2e-refresh-token.sh`, and runnable locally. |
| `ci-watch.sh`                    | Polls a PR's CI run status without spawning a long-lived watcher — the allowlisted way to wait out a CI run.                                                                                                       |

## Support files

| Path                                   | What it does                                                                                                                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks/sensitive-path-reminder.mjs`    | Claude Code `PostToolUse` hook (`.claude/settings.json`) — reminds a contributor to run `/review-money-diff` after editing a money/auth path.                                                            |
| `__tests__/scaffold-endpoint.test.mjs` | Vitest coverage for `scaffold-endpoint.mjs`'s `buildPlan()`, run via `vitest.scripts.config.mjs` (`npm run test:scripts`, part of `npm test`).                                                           |
| `migration-parity-allowlist.json`      | Allowlist for drizzle-unrepresentable shapes, read by `apps/backend/src/scripts/check-migration-parity.ts` (`npm run check:migration-parity`; needs a live DB, runs in CI's `flywheel-integration` job). |
| `openapi-parity-allowlist.json`        | Deferred-violation allowlist, read by `check-openapi-parity.mjs`. Currently empty.                                                                                                                       |
| `shared-type-parity-allowlist.json`    | Deferred-violation allowlist, read by `check-shared-type-parity.mjs`.                                                                                                                                    |

## `archive/` — consumed one-shots

Kept for provenance only; do not run. Their findings/outputs are already
applied to the live system (see each file's header comment for what
superseded it):

- `probe-ctx-cryptocurrency.mjs` — one-off probe that discovered the
  `cryptoCurrency` value format CTX's `POST /gift-cards` expects; the
  answer is now hardcoded in `apps/backend/src/orders/procure-one.ts`.
- `scrape-merchant-images.mjs` — v1 merchant logo/cover scraper (Clearbit
  autocomplete), superseded by `tools/ctx-catalog/scrape-merchant-images-v2.mjs`.
