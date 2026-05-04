# Phase 03 - Build, Release, and Reproducibility

Status: in-progress

Execution timestamp: `2026-05-03T18:22:42Z`

Baseline commit: `13522bb4ee8279336fb143c5c0f33bbbf6ef205b`

Required evidence:

- package script inventory: captured
- build and verify command results or justified skips: typecheck, lint, audit, SSR build, mobile build, docs lint, admin bundle split, and stable bundle budget captured
- Docker/Fly/deploy config review: snapshots captured
- mobile export and proto generation review: mobile build captured; proto generation pending for Phase 16 shared contract review
- reproducibility gaps: `A4-004`, `A4-005` filed

Artifacts:

- `artifacts/root-package-scripts.json`
- `artifacts/backend-package-scripts.json`
- `artifacts/web-package-scripts.json`
- `artifacts/mobile-package-scripts.json`
- `artifacts/shared-package-scripts.json`
- `artifacts/npm-typecheck.txt`
- `artifacts/npm-build.txt`
- `artifacts/web-build-mobile.txt`
- `artifacts/web-build-ssr-for-budget.txt`
- `artifacts/lint-docs.txt`
- `artifacts/lint-docs-escalated.txt`
- `artifacts/check-bundle-budget.txt`
- `artifacts/check-bundle-budget-stable.txt`
- `artifacts/check-admin-bundle-split.txt`
- `artifacts/npm-audit-policy.txt`
- `artifacts/npm-lint.txt`
- `artifacts/npm-format-check.txt`
- `artifacts/all-backend-route-literals.txt`
- `artifacts/lint-docs-openapi-checked-routes.txt`
- `artifacts/openapi-paths.txt`
- `artifacts/routes-missing-openapi.txt`
- `artifacts/ci-job-keys.txt`
- `artifacts/ci-job-names.txt`
- `artifacts/main-required-checks.json.txt`
- `artifacts/ci-docs-vs-workflow-lines.txt`
- `artifacts/ci.yml.snapshot`
- `artifacts/backend-Dockerfile.snapshot`
- `artifacts/web-Dockerfile.snapshot`
- `artifacts/backend-fly.toml.snapshot`
- `artifacts/web-fly.toml.snapshot`
- `artifacts/web-config-assets-review.txt`

Command results:

- `npm run typecheck`: pass.
- `npm run build`: pass.
- `npm run build:mobile -w @loop/web`: pass.
- `npm run lint`: pass.
- `npm run audit`: pass; current policy accepts four moderate advisories tied to the deprecated drizzle-kit/esbuild-kit chain.
- `npm run format:check`: fail limited to audit-workspace files, including the isolated Claude audit directory; product source formatting was not identified as the failing surface. Claude files were not modified from this workspace.
- `npm run lint:docs`: initial sandboxed run failed because `flyctl config validate` attempted to write under `~/.fly`; rerun with full filesystem access passed.
- `npm run check:bundle-budget`: first run raced with a concurrent mobile build and is invalid evidence; stable rerun after `npm run build -w @loop/web` passed with SSR client total 2396 KB under the 2500 KB budget.
- `./scripts/check-admin-bundle-split.sh`: pass.

Review dimensions:

- Logic correctness: build graph, SSR/static build switch, and docs lint guard behavior reviewed in part.
- Code quality: scripts are readable, but `lint-docs` has an outdated OpenAPI drift extractor.
- Security and privacy: Dockerfiles pin the Node base image by digest and run production images as non-root; CI defines secret, container, SBOM, and integration jobs, but live branch protection does not require several of them.
- Web package deploy/config/assets pass verified the web Dockerfile, Fly config, production env file, React Router/Vite/Vitest config, robots/manifest, and public static asset file types.
- Documentation accuracy: build command docs partially verified by command execution.
- Documentation coverage: pending full doc reconciliation.
- Test coverage and accuracy: docs lint guardrail accuracy issue filed as `A4-004`; CI required-check coverage issue filed as `A4-005`.
- Planned-feature fit: pending Phase 24.

Findings:

- `A4-004`
- `A4-005`
