# Phase 18 - Testing and Regression Confidence

Status: complete
Owner: lead (Claude)

## Files reviewed

- apps/backend/src/**tests**/\* (~25 test files including integration suite + flywheel.test.ts)
- apps/backend/src/\*_/**tests**/_ (per-area test dirs)
- apps/web/app/**tests**/, apps/web/app/routes/**tests**/, services/**tests**/, hooks/**tests**/, components/.../\*.test.tsx
- tests/\* (e2e mocked + e2e real)
- playwright.config.ts, playwright.mocked.config.ts

## Findings filed

- A4-046 Low — real-CTX e2e backend runs with placeholder DATABASE_URL; ledger paths uncovered
- A4-049 Low — mocked e2e disables rate limiting; production rate-limiter regression-untested

## No-finding-but-reviewed

- Backend has 84+ tests across unit + integration + property (BigInt money).
- Mocked e2e is the deterministic gate; real e2e is PR-only.
- Vitest setup separates env per test via `vitest-env-setup.ts`.
- Property tests cover BigInt money flooring across the cashback split.

## Cross-references

- Test gaps that would have caught audit findings:
  - Per-route rate-limit isolation test would catch A4-001.
  - Cross-tab logout coordination test would catch A4-070.
  - Body-mismatch idempotency-key test would catch A4-011.
