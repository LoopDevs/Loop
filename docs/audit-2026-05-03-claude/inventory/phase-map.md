# Phase Map

This map defines primary ownership for file review. `inventory/file-disposition.tsv` is the executable register and may be refined during Phase 00.

## Root and Repo Policy

- `.github/**`: Phase 20, with Phase 01 and Phase 04 secondary review.
- `.husky/**`, `.gitignore`, `.gitattributes`: Phase 01, with Phase 20 where hooks affect CI/release.
- `.gitleaks.toml`: Phase 20, with Phase 17 secondary review.
- Root package manifests and npm config: Phase 04, with Phase 03 and Phase 20 secondary review.
- Root TypeScript, ESLint, Playwright, Commitlint, Prettier, Docker, and compose config: Phase 03, with Phase 18 and Phase 20 secondary review.
- Root docs and policy files: Phase 21, with Phase 01 and Phase 02 secondary review.

## Backend

- `apps/backend/src/app.ts`, middleware, routes, env, upstream, circuit breakers, request context: Phase 05.
- `apps/backend/src/auth/**`: Phase 06.
- `apps/backend/src/admin/**`: Phase 07.
- `apps/backend/src/public/**`: Phase 08.
- `apps/backend/src/orders/**`: Phase 09, except worker/sweep files that Phase 13 also owns.
- `apps/backend/src/payments/**`: Phase 10, except watcher/worker/bootstrap files that Phase 13 also owns.
- `apps/backend/src/db/**`: Phase 11.
- `apps/backend/src/credits/**`: Phase 12, with Phase 07, Phase 10, Phase 11, and Phase 13 secondary review.
- Worker, watcher, scheduler, sync, bootstrap, and data-store files: Phase 13.
- `apps/backend/src/openapi.ts` and `apps/backend/src/openapi/**`: Phase 16.
- Backend logs, metrics, runtime health, Discord, Sentry, cleanup, and startup observability: Phase 19.
- Backend tests: Phase 18 with owning implementation phases as secondary review.
- Backend package, Docker, Fly, tsup, drizzle, buf, tsconfig, README: Phase 03 with implementation-specific secondary review.

## Web

- `apps/web/app/routes/**`, services, hooks, stores, components, utils, root, entry server, CSS, route manifest: Phase 14.
- `apps/web/app/native/**`: Phase 15.
- Web tests: Phase 18 with Phase 14 or Phase 15 secondary review.
- Web package, Vite, React Router, Docker, Fly, tsconfig, README: Phase 03 with Phase 14, Phase 15, and Phase 20 secondary review.

## Mobile

- `apps/mobile/**`: Phase 15 with Phase 03, Phase 17, and Phase 18 secondary review.

## Shared

- `packages/shared/**`: Phase 16 with Phase 05, Phase 14, and Phase 18 secondary review.

## Tests and Scripts

- `tests/**`: Phase 18 with journey-specific implementation phases as secondary review.
- `scripts/**`: Phase 03 with Phase 18, Phase 20, and Phase 21 secondary review.

## Docs

- `docs/adr/**`: Phase 02 and Phase 21.
- `docs/runbooks/**`, `docs/slo.md`, `docs/alerting.md`, `docs/oncall.md`, `docs/log-policy.md`: Phase 19 and Phase 21.
- `docs/audit-2026-05-03-claude/**`: Phase 00 for scaffold inventory, Phase 24 for planned-feature matrix inputs, and Phase 25 for scaffold self-review.
- Other `docs/**`: Phase 21, with Phase 02 or implementation phases as needed.

## Cross-Cutting Phases Without Exclusive File Ownership

Phase 17, Phase 23, Phase 24, and Phase 25 are primarily cross-cutting. They close by proving relationships across files, feature plans, and the audit scaffold itself.
