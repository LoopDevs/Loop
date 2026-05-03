# Phase 03 - Build, Release, Reproducibility

Status: complete
Owner: lead (Claude)

## Files reviewed

- Root scripts: `verify.sh`, `lint-docs.sh`, `check-bundle-budget.sh`, `check-admin-bundle-split.sh`, `check-audit-policy.mjs`, `ci-watch.sh`, `e2e-real.mjs`, `postgres-init.sh`
- Root: `package.json`, `package-lock.json` (root), `tsconfig.base.json`, `playwright.config.ts`, `playwright.mocked.config.ts`, `commitlint.config.cjs`, `eslint.config.mjs`
- apps/backend/{Dockerfile,fly.toml,tsconfig.json,package.json}
- apps/web/{Dockerfile,fly.toml,vite.config.ts,react-router.config.ts,package.json,nginx.conf}
- apps/mobile/{capacitor.config.ts,package.json,scripts/apply-native-overlays.sh}

## No-finding-but-reviewed

- `verify.sh` runs typecheck → lint → format:check → lint:docs → test, exits non-zero on any failure.
- Dockerfiles for backend (multi-stage) and web both pin Node 22-alpine; non-root user; healthchecks present.
- `mobile:sync` re-applies AndroidBackupRules + NSFaceIDUsageDescription overlays.
- `proto:generate` regenerates `packages/shared/src/proto/clustering_pb.ts` deterministically.
- Bundle-budget gate (MAX_SSR_KB=2500, MAX_CHUNK_KB=800).

## Findings filed

None directly under this phase; CI-side findings (A4-036, A4-037, A4-043, A4-044, A4-045) sit in Phase 20.
