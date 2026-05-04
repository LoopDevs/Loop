# Phase 18 - Testing and Regression Confidence

Status: in-progress

Required evidence:

- test inventory by risk: started; current filesystem inventory captured in [testing-doc-ci-coverage-drift.txt](./artifacts/testing-doc-ci-coverage-drift.txt)
- mocked vs real coverage review: started; mocked, real-upstream, loop-native flywheel, and backend real-Postgres wiring compared against configs and CI
- fixture and mock drift review: started; mocked CTX and flywheel seed paths reviewed at harness level
- CI test wiring review: started; `.github/workflows/ci.yml`, root scripts, Vitest configs, and Playwright configs compared
- missing high-risk assertions list: started; existing findings A4-025 and A4-029 include test-accuracy gaps, and backend domain slices have now been run directly

Evidence captured:

- Current filesystem inventory shows 181 backend unit/integration specs, 123 web unit/route specs, 4 Playwright specs, 7 backend real-Postgres integration specs, 35 web route modules, and 14 direct route test specs.
- Focused skip/only scan found no active `.only`; only `describe.skip` occurrences are the real-Postgres integration files gated on `LOOP_E2E_DB`.
- Backend default coverage excludes `src/__tests__/integration/**`; the integration config includes those specs separately and disables coverage.
- CI runs `test-unit`, `flywheel-integration`, `test-e2e-mocked`, `test-e2e-flywheel`, PR-only real-upstream `test-e2e`, `audit`, `secret-scan`, `container-cve-scan`, `sbom`, `build`, and `quality`.
- `docs/testing.md` does not accurately describe that full CI/test surface and mislabels backend coverage as `unit + integration`.
- Backend domain slice run passed 81 test files and 1,034 tests across auth, orders, users, credits, payments, clustering, config, db, ctx, images, and root backend tests. Evidence: [backend-domain-slice-tests.txt](./artifacts/backend-domain-slice-tests.txt).
- Backend infrastructure and merchant slice run passed 13 test files and 175 tests across merchants, CTX fixtures, circuit breaker, logger, request context, trust proxy, upstream validation/scrubbing, Sentry scrubber, Discord, and kill-switch coverage. Evidence: [backend-infra-merchant-slice-tests.txt](./artifacts/backend-infra-merchant-slice-tests.txt).
- Mocked e2e harness setup and mock CTX server files were reviewed directly. Evidence: [e2e-mocked-harness-review.txt](./artifacts/e2e-mocked-harness-review.txt).
- The passing backend slice is regression-confidence evidence only; it does not close the already-filed logic findings where tests pass despite missing or inaccurate assertions.

Findings:

- A4-031: Testing guide misstates CI coverage and backend coverage scope.
