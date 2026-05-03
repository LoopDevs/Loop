# Phase Map

This is the initial ownership map from tracked repo surfaces to audit phases. It will be refined during execution, but every tracked file should land in one primary phase.

## Primary mappings

- `.github/**`, root policy files, branch protection evidence: phases 1, 18
- `docs/adr/**`, `docs/architecture.md`, `AGENTS.md`, package `AGENTS.md`: phase 2
- build tooling, Dockerfiles, `fly.toml`, root scripts, proto generation, bundle budget: phase 3
- `package.json`, `package-lock.json`, workflow-installed tools, license docs: phase 4
- `apps/backend/src/app.ts`, `middleware/**`, `routes/**`, request handlers and route registration: phase 5
- `apps/backend/src/auth/**`: phases 5, 6, 15
- `apps/backend/src/admin/**`, admin OpenAPI registrations, admin Discord paths: phase 6
- `apps/backend/src/public/**`: phase 7
- `apps/backend/src/orders/**`, `payments/**`, `credits/payout-*`, `credits/pending-payouts*`: phases 8, 10, 11
- `apps/backend/src/db/**`: phases 9, 10
- merchant/location sync, procurement, payout worker, watcher, schedulers: phase 11
- `apps/web/app/routes/**`, `components/**`, `hooks/**`, `services/**`, `stores/**`, `utils/**`: phase 12
- `apps/mobile/**`, `apps/web/app/native/**`: phase 13
- `packages/shared/**`, `apps/backend/src/openapi/**`, `docs/error-codes.md`: phase 14
- cross-cutting auth/session/storage, SSRF, secrets, headers, abuse controls: phase 15
- tests under `apps/**/__tests__`, `tests/**`, coverage posture: phase 16
- observability, alerting, runbooks, SLO, on-call, log policy: phase 17
- workflow configs, deploy/release automation, scanners, environments: phase 18
- reconciliation, dedupe, final counts, completeness gates: phase 19

## Cross-phase note

Some files are intentionally reviewed in multiple phases. The mapping above identifies the primary owner only; secondary review should be referenced in phase evidence rather than creating duplicate ownership.
