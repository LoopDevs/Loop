# Phase 14 — Testing

**Commit SHA at audit time:** `450011ded294b638703a9ba59f4274a3ca5b7187`
**Audit date:** 2026-04-23
**Scope:** Phase 14 of `docs/audit-2026-adversarial-plan.md` (§3, §3.4, §Phase 14, pass-4 G4-03, pass-5 G5-95..G5-100)
**Rule:** Evidence-only. No source, tracker, or config edits. Priors consulted only after independent conclusions (§0.2).
**Finding ID block:** A2-1700..A2-1799

---

## 0. Summary (up-front)

254 test files · 2298 `it()` blocks · vitest node env · Playwright chromium only in CI.

Verdict — the unit surface is broad (handler × test file nearly 1:1 for admin, auth, orders, payments, public, users, merchants, clustering, images) but three shape defects cut deep:

1. **"Mock-the-SUT" anti-pattern is systemic.** Core money modules (`credits/accrue-interest.ts`, `credits/adjustments.ts`, `orders/procurement.ts`, etc.) are exercised only through a hoisted `db` chain mock — so bugs inside `tx.update(...).where(...)` (see prior A2-610 Critical) were never reachable by unit tests. The admin-credit-adjustment handler test goes a step further and stubs `applyAdminCreditAdjustment` itself.
2. **Full-journey e2e does not exist (G4-03).** Mocked Playwright covers `auth → amount → payment → redeem(URL)` in a single test; real-upstream Playwright covers navigation only. No test walks `signup → wallet-link → order → fulfillment → cashback-credit → recycle → payout` — the spine of the product. The mocked-e2e backend opens no DB (`DATABASE_URL` is a placeholder, migrations skipped), so admin/credits/payouts endpoints are never driven end-to-end by any suite.
3. **E2E mocked is demonstrably flaky** — 15+ consecutive CI failures on the same `toBeVisible` sync signal (`/We sent a code to/`) inside `tests/e2e-mocked/purchase-flow.test.ts:56` between 2026-04-22 20:51 and 2026-04-23 00:11. Retries mask this most of the time but the primary signal has been unreliable.

Also flagged: web coverage thresholds (37 lines / 32 branches) encode weakness rather than defend against it; no property-based tests despite `bigint`-money math; no bundle-size / LCP / a11y budget in CI (G5-95–100, G2-11).

**Priors reconciliation** — A2-508 (13 admin handlers untested) is **largely closed**; admin now has 78 test files for 80 handlers. A2-1116 (`sitemap.tsx` untested) **still open** — no file at `apps/web/app/routes/__tests__/sitemap.test.tsx`. A2-610 (accrue-interest tests mock `db`) **confirmed still present** and reproducing in the same file — nothing has been re-wired against real Postgres.

---

## 1. Handler × test-file coverage matrix

Coverage determined by: for each `src/<module>/<handler>.ts`, the existence of a sibling `src/<module>/__tests__/<handler>.test.ts`. This captures the "every handler has a file" gate only — §2 reads the tests to judge whether that file is worth anything.

### Backend

| Module        | Handler files | Test files | Missing handlers (no dedicated test)                                                                                                                                    |
| ------------- | ------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin/`      | 80            | 78         | `audit-envelope.ts`, `idempotency.ts` — see A2-1700                                                                                                                     |
| `auth/`       | 11            | 12         | none (extra: `require-auth.test.ts` tests a helper)                                                                                                                     |
| `clustering/` | 3             | 3          | none                                                                                                                                                                    |
| `credits/`    | 6             | 4          | `adjustments.ts`, `liabilities.ts` — see A2-1701                                                                                                                        |
| `images/`     | 1             | 1          | none                                                                                                                                                                    |
| `merchants/`  | 2             | 2          | none                                                                                                                                                                    |
| `orders/`     | 5             | 8          | none (extra: loop-get/list/handler split tests)                                                                                                                         |
| `payments/`   | 9             | 10         | none (extra: `watcher-scheduling`)                                                                                                                                      |
| `public/`     | 6             | 6          | none                                                                                                                                                                    |
| `users/`      | 8             | 8          | none (extra: `pending-payouts-summary`)                                                                                                                                 |
| Root (`src/`) | 8             | 7          | `app.ts`, `index.ts`, `openapi.ts`, `logger.ts`, `discord.ts`, `upstream.ts`, `circuit-breaker.ts`, `env.ts` have tests; `app.ts` / `index.ts` covered via integration. |

Gaps → A2-1700 (admin internals untested), A2-1701 (credits primitives untested).

### Web (`apps/web/app/`)

- Routes tested: 12 of 32 — `admin.assets*`, `admin.audit`, `admin.operators*`, `admin.orders.$orderId`, `admin.payouts.$id`, `admin.stuck-orders`, `admin.users`, `calculator`, `settings.cashback`, `settings.wallet`.
- Routes **untested**: `admin._index`, `admin.cashback`, `admin.merchants*`, `admin.orders`, `admin.payouts`, `admin.treasury`, `admin.users.$userId`, `auth`, `cashback*`, `gift-card.$name`, `home`, `map`, `not-found`, `onboarding`, `orders`, `orders.$id`, `privacy`, `sitemap`, `terms`, `trustlines`. The web vitest config excludes `app/routes/**`, `app/root.tsx`, `app/components/features/home/**`, and `app/components/features/onboarding/**` from unit coverage, delegating to Playwright — but see §4: Playwright covers exactly five of these. A2-1116 (sitemap.tsx) is in this list, still open.
- Services tested: 6 of 10 — `admin.ts`, `config.ts`, `public-stats.ts`, `user.ts` have no unit test. A2-1702.
- Components: extensive admin-feature coverage (~40 `.test.tsx` under `components/features/admin/__tests__`). Purchase-flow components have jsdom opt-in coverage; onboarding components have none (coverage-excluded).

---

## 2. Test-quality sample (30 tests read, classified)

Sample chosen across the critical axes (auth, orders, payments, admin writes, credits, users, public). Classifications:

- **S** — status-only body assertion (no body shape check) — acceptable for non-write endpoints if paired with a positive body test; a smell if the only test for a handler.
- **M** — test mocks the module under test (SUT).
- **K** — test mocks a direct collaborator so heavily that the real code path is not exercised ("coverage theater" variant).
- **C** — real wall-clock / `new Date()` / `Date.now()` without a freeze (G5-97).
- **I** — test isolation looks adequate (hoisted state + beforeEach reset).
- **OK** — positive + negative path, body asserted.

| File                                                         | Class   | Note                                                                                                                                                                                                        |
| ------------------------------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/src/__tests__/routes.integration.test.ts`           | S/I     | Integration over Hono test client — uses `app.ts`, stubs upstream via MSW-ish pattern. Good scaffolding. Some status-only checks on rate-limit responses; acceptable given the downstream test of the same. |
| `backend/src/__tests__/upstream.test.ts`                     | OK      | URL-builder traversal + CRLF probes. Fine. Not a CTX contract test.                                                                                                                                         |
| `backend/src/auth/__tests__/handler.test.ts`                 | OK/C    | 24 `it()`, covers request-otp / verify-otp / refresh / logout proxies, both 2xx and failure paths. Uses real `new Date()` for token-expiry assertions; no freeze.                                           |
| `backend/src/auth/__tests__/otps.test.ts`                    | OK      | Has a comment with the word "property" but no `fast-check` — misleading. Confirmed no property-based testing anywhere.                                                                                      |
| `backend/src/auth/__tests__/jwt.test.ts`                     | OK      | Sign/verify/rotate — good.                                                                                                                                                                                  |
| `backend/src/auth/__tests__/refresh-tokens.test.ts`          | OK      | Rotation tests present; no expired-token test past the `clockTolerance` window (minor).                                                                                                                     |
| `backend/src/auth/__tests__/social.test.ts`                  | S       | 7 of its assertions are status-only; body not inspected for rejected identity shapes.                                                                                                                       |
| `backend/src/orders/__tests__/handler.test.ts`               | OK/C    | 26 `it()`, exhaustive. 14 real `Date.now()` uses for age checks — jitter tolerance is present (`± 1 min`). Accept.                                                                                          |
| `backend/src/orders/__tests__/procurement.test.ts`           | **M/K** | db + transitions + operator-pool **all** stubbed. The actual query-building logic (paid-orders filter, atomic state transition) is not exercised.                                                           |
| `backend/src/orders/__tests__/transitions.test.ts`           | **M**   | `db` chain mocked; the WHERE/SET fragments are stubbed to identity functions, so a wrong predicate survives (same shape that let A2-610 slip).                                                              |
| `backend/src/payments/__tests__/payout-submit.test.ts`       | OK/K    | Stellar SDK mocked. Submit-happy + submit-retry + idempotency guard all covered; unavoidable for SDK interactions.                                                                                          |
| `backend/src/payments/__tests__/payout-worker.test.ts`       | OK      | Race / already-landed paths — good.                                                                                                                                                                         |
| `backend/src/payments/__tests__/watcher-scheduling.test.ts`  | OK      | Uses `vi.useFakeTimers` — one of 3 files that does.                                                                                                                                                         |
| `backend/src/payments/__tests__/horizon-circulation.test.ts` | OK      | Covers drift math branches.                                                                                                                                                                                 |
| `backend/src/payments/__tests__/asset-drift-watcher.test.ts` | OK      | Covers detect + noop-when-absent.                                                                                                                                                                           |
| `backend/src/credits/__tests__/accrue-interest.test.ts`      | **M/K** | db fully mocked (A2-610 root cause — confirmed unchanged at commit 450011d). The WHERE predicate lacking the `currency` clause cannot be detected by this test.                                             |
| `backend/src/credits/__tests__/pending-payouts.test.ts`      | OK      | Decent; uses fixture helper.                                                                                                                                                                                |
| `backend/src/credits/__tests__/payout-builder.test.ts`       | OK      | Pure math, good coverage.                                                                                                                                                                                   |
| `backend/src/admin/__tests__/credit-adjustments.test.ts`     | **M**   | Stubs `applyAdminCreditAdjustment` (the primary money primitive). Handler contract tested, primitive not. Compounds A2-1701.                                                                                |
| `backend/src/admin/__tests__/audit-tail.test.ts`             | OK      | Body asserted; validation + happy + error all covered. Representative of the "good admin test" pattern.                                                                                                     |
| `backend/src/admin/__tests__/reconciliation.test.ts`         | OK      | Body asserted, drift math checked.                                                                                                                                                                          |
| `backend/src/admin/__tests__/treasury.test.ts`               | OK      | 388 lines, thorough.                                                                                                                                                                                        |
| `backend/src/admin/__tests__/stuck-orders.test.ts`           | OK/C    | 7 `Date.now()` uses with ±1-min tolerance. OK for non-flaky but not ideal.                                                                                                                                  |
| `backend/src/admin/__tests__/user-search.test.ts`            | OK      | Closes A2-508 for this handler.                                                                                                                                                                             |
| `backend/src/admin/__tests__/user-detail.test.ts`            | OK      | Closes A2-508 for this handler.                                                                                                                                                                             |
| `backend/src/admin/__tests__/cashback-activity.test.ts`      | OK      | Empty-set + happy-path body. Fine.                                                                                                                                                                          |
| `backend/src/public/__tests__/cashback-preview.test.ts`      | OK      | Good.                                                                                                                                                                                                       |
| `backend/src/users/__tests__/handler.test.ts`                | OK/C    | 24 `new Date()` literals — timestamps snapshotted as `new Date()` with no freeze; acceptable here because the test asserts equality with the same literal.                                                  |
| `backend/src/clustering/__tests__/algorithm.test.ts`         | OK      | 24 cases, zoom-level + centroid. Solid.                                                                                                                                                                     |
| `backend/src/images/__tests__/proxy.test.ts`                 | OK      | SSRF coverage. Solid.                                                                                                                                                                                       |

**Patterns observed.**

- 54 test files use `vi.hoisted(() => state)` with an inline `db` chain. The pattern is safe for file-parallel vitest (each module instance is per-worker) but the SUT-mock problem is baked in.
- Only 3 files use `vi.useFakeTimers` (`native-modules.test.ts`, `procurement-scheduling.test.ts`, `watcher-scheduling.test.ts`); 48 files otherwise touch real time. Most are tolerant; A2-1703 records this as a latent risk.
- No `toMatchSnapshot` anywhere in the repo source tree (verified). G5-96 is not an issue.
- No `.skip` / `.only` / `.todo` anywhere. Verified via `find ... | xargs grep -lE "\.(skip|only|todo)"` — five files match but every hit is a domain name (`skippedAmount`, `skippedRace`, `skippedZero`) not a test modifier. G5-96 / skip-inventory clean.

---

## 3. Flake cluster (last ~100 CI runs on `main`)

`gh run list --branch main --limit 200 --workflow ci.yml` → **47 failures / 36 cancelled / 117 success** (200-run sample). Of the 47 failures, two distinct clusters dominate:

| Cluster                       | Failing job                               | Root cause                                                                                                                                                                                                                                     | Runs |
| ----------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| **E2E-mocked OTP visibility** | `E2E tests (mocked CTX)`                  | `toBeVisible` timeout on `/We sent a code to/` at `tests/e2e-mocked/purchase-flow.test.ts:56` (inside `signInInline`). Both specs fail — happy-path + wrong-OTP. Reproduced across 15+ consecutive runs 2026-04-22 20:51Z → 2026-04-23 00:11Z. | ~15  |
| **npm audit high vuln**       | `Security audit`                          | `npm audit --audit-level=high` fails on `esbuild ← @esbuild-kit/core-utils ← @esbuild-kit/esm-loader` (4 moderate, 1 high). Not a test flake but the same 15 runs fail here.                                                                   | ~16  |
| **Prettier format drift**     | `Quality (typecheck, lint, format, docs)` | `format:check` on `apps/backend/src/openapi.ts` — authored code not run through `prettier --write`.                                                                                                                                            | 3    |

All three clusters are deterministic given their inputs (the e2e one is dependent on page-render timing within a 5s budget — so it's on the boundary between flake and bug). None of the three is a genuine test-logic flake caught by retries.

No single unit test exceeds the >5% failure threshold — unit suites green on every observed run that got past the quality gate.

Flake finding → A2-1704 (e2e OTP signal brittleness).

---

## 4. E2E journey coverage

### Files

| Config                                          | Dir                 | Specs                                             | Size (loc) |
| ----------------------------------------------- | ------------------- | ------------------------------------------------- | ---------- |
| `playwright.config.ts` (real upstream, PR-only) | `tests/e2e/`        | `smoke.test.ts`, `purchase-flow.test.ts`          | 39 + 60    |
| `playwright.mocked.config.ts` (default)         | `tests/e2e-mocked/` | `purchase-flow.test.ts` + `fixtures/mock-ctx.mjs` | 111 + 240  |

### Journey matrix (G4-03)

| Stage                          | Mocked e2e                                               | Real e2e                   | Covered? |
| ------------------------------ | -------------------------------------------------------- | -------------------------- | -------- |
| Land on home                   | no direct, via `/` click-through                         | `smoke.test.ts`            | partial  |
| Authenticate (OTP)             | yes (happy + wrong-OTP)                                  | no (sign-in UI check only) | partial  |
| Social login (Google/Apple)    | no                                                       | no                         | **no**   |
| Wallet link / trustlines       | no                                                       | no                         | **no**   |
| Amount selection               | yes                                                      | no                         | partial  |
| Payment (pay + poll)           | yes (mock flips to fulfilled via `_test/mark-fulfilled`) | no                         | partial  |
| Redemption (URL/barcode)       | yes (URL path only — barcode path not exercised)         | no                         | partial  |
| Order list / detail            | no                                                       | no                         | **no**   |
| Cashback credit (ledger write) | no — mocked backend has no DB                            | no                         | **no**   |
| Recycle (credits → new order)  | no                                                       | no                         | **no**   |
| Pending-payout / payout        | no — no DB, no Stellar                                   | no                         | **no**   |
| Onboarding flow                | no                                                       | no                         | **no**   |

**Signup → recycle → payout is not covered anywhere.** The mocked suite cannot cover it because the backend runs with `DATABASE_URL=postgres://placeholder:placeholder@localhost:5433/loop_test` and migrations are gated on `NODE_ENV !== 'test'`, so no `credit_transactions` / `user_credits` / `pending_payouts` writes happen. The real suite exists as a manual workflow (`scripts/e2e-real.mjs` + `.github/workflows/e2e-real.yml`) but runs against production CTX only, one-shot, not part of CI.

Journey finding → A2-1705 (G4-03).

### Suite deltas (mocked vs real)

- Real runs against `https://spend.ctx.com`; mocked against a 240-LoC `mock-ctx.mjs`.
- Real: `fullyParallel: true`, workers 1 in CI, includes `mobile-chrome` smoke project.
- Mocked: `fullyParallel: false`, workers 1, chromium only.
- Mocked defines `DISABLE_RATE_LIMITING=1` (test-only toggle) to avoid the 5/min OTP limit during retries. Real runs against the real limiter.
- Only the real suite validates the CTX contract shape (loosely — `smoke` asserts UI only; `purchase-flow` asserts merchant list renders). There is **no Zod-schema-backed contract test** that pins the CTX response shape per endpoint. G4-07 / Phase 17 overlap but flagged here → A2-1706.

---

## 5. Skips / only inventory

Clean. `find ... | xargs grep -lE "\.(skip|only|todo)"` returned five files; every match is a domain identifier (`skippedAmount`, `skippedRace`, `skippedZero`, `skippedAlreadyLanded`). No `describe.skip`, `it.skip`, `test.skip`, `it.only`, `test.only`, `describe.only`, `.todo` anywhere in the suite.

---

## 6. Fixtures vs factories

- No `tests/fixtures/` directory (only `tests/e2e-mocked/fixtures/mock-ctx.mjs`, which is the upstream mock, not a data fixture).
- Each `.test.ts` builds its own state via `vi.hoisted(() => ({ ... }))`. 54 files use this pattern.
- No shared factory helpers (`makeUser`, `makeOrder`, `makeAdjustment`); no `faker` or equivalent.
- Consequence: when a domain shape changes (e.g. `orders.chargeCurrency` added in ADR-015), 54+ files must update independently. Consistency is by copy-paste.
- Not a bug, but a debt marker — A2-1707.

---

## 7. Testing-pyramid ratios

Approximate from `it()` counts:

- Unit + handler-level (vitest): 2298 `it()` across 254 files.
- Integration (`routes.integration.test.ts`): 32 `it()`.
- E2E: 7 specs total (2 real + 2 mocked × 1 chromium + 1 mobile-chrome smoke).

Ratio roughly 99% unit : 1% integration : ~0.3% e2e. The pyramid is functional but the e2e tip is razor-thin — three user-facing specs guarding the full product flow. A2-1708.

---

## 8. Coverage thresholds vs reality

| Config                     | Measured baseline (comment)                     | Threshold (CI gate) | Delta                 |
| -------------------------- | ----------------------------------------------- | ------------------- | --------------------- |
| backend `vitest.config.ts` | stmt 83.7 / branch 77.0 / func 79.4 / line 85.0 | 80 / 72 / 75 / 80   | reasonable            |
| web `vitest.config.ts`     | stmt 40.2 / branch 37.9 / func 45.4 / line 41.1 | 35 / 32 / 40 / 37   | threshold itself ≤ 40 |

Web threshold floors are artifacts of the route/home/onboarding exclusions. The exclusions are documented but they shift coverage of those paths onto Playwright, which covers five of them (see §4). Net unit+e2e coverage of `app/routes/**` and `app/components/features/home/**` is materially lower than the headline 41%. A2-1709.

---

## 9. Property-based, contract, and budget tests

- **Property-based**: none. No `fast-check`, no `jsverify`, no equivalent in the dep tree. Money math (`bigint` with `*_minor` suffix, currency-aware adjustments, cashback split) has zero property-based coverage. G4-01 / Phase 6.5 called this out — nothing has landed. A2-1710.
- **CTX contract tests**: none. Zod schemas validate responses at runtime but no CI test pins the shape. Drift is detectable only by an integration run against real CTX (manual workflow). A2-1706.
- **Bundle-size budget**: none. No `size-limit`, `bundlesize`, or equivalent CI job; no per-route asset-size assertion. A2-1711 (G2-11).
- **LCP / CLS / INP budget**: none. Playwright `smoke` does not assert Core Web Vitals. No Lighthouse budget anywhere in `.github/workflows/`. A2-1711.
- **a11y budget**: none in CI. No `@axe-core/playwright` or similar. A2-1712 (G2-11 / G4-18).
- **Mutation testing**: none (no `stryker`, no `@stryker-mutator/*`). G5-95 — A2-1713.

---

## 10. Test isolation / parallelism safety

- Backend vitest: `globals: false`, default pool (forks, file-parallel). Every test file module has its own `state` (`vi.hoisted(() => ({ ... }))`) per worker. Safe.
- Web vitest: same. Purchase-flow components use `// @vitest-environment jsdom` per-file opt-in.
- No test touches Postgres directly (A2-610's "every write is mocked" — same root cause); therefore no DB-contention issue under parallelism, but also no real-DB assertion for any write path.
- Playwright mocked: `fullyParallel: false, workers: 1` — serial due to mock CTX in-memory state. Test A resets via `/__test__/reset` before each — OK.
- No `.env` or shared resource mutated by tests (verified via grep for `process.env\[.*\] =` — found 11 mutations in test files, all inside `beforeEach` + restored in `afterEach`).

Parallelism is safe today. G5-100 green.

---

## 11. Findings

Severity per §3.4. Every finding logged, none remediated (pre-launch; remediation is post-Phase 19).

### A2-1700 — Admin audit envelope + idempotency primitives untested (Medium)

`apps/backend/src/admin/audit-envelope.ts` and `apps/backend/src/admin/idempotency.ts` have no sibling `__tests__` file. Both are ADR-017 primitives: admin-write response wrapping and replay-snapshot storage. Every admin mutation handler delegates to these, yet only the handler-level tests exercise them (via `vi.mock('../idempotency.js', ...)` in e.g. `credit-adjustments.test.ts` — i.e. the primitive is stubbed out). A bug in `validateIdempotencyKey`'s length bounds or `storeIdempotencyKey`'s snapshot shape would not be caught by any test.

### A2-1701 — Credits primitives (`adjustments.ts`, `liabilities.ts`) untested (High)

`apps/backend/src/credits/adjustments.ts` is the single place in the repo that writes credit-ledger adjustments from admin writes and refund paths. `apps/backend/src/credits/liabilities.ts` sums `user_credits.balance_minor` for the drift-detection side of ADR-015. Neither has a dedicated test file. The only coverage comes indirectly through `admin/credit-adjustments.test.ts`, which `vi.mock`s `applyAdminCreditAdjustment` entirely — so the tx-bounded write, the sign-convention check (`CHECK amount_minor != 0`), and the `InsufficientBalanceError` branch are not driven by any test. Same shape as A2-610 for `accrue-interest.ts`.

### A2-1702 — Web services `admin.ts`, `config.ts`, `public-stats.ts`, `user.ts` untested (Medium)

Four of the ten files under `apps/web/app/services/` lack a `__tests__` file. `admin.ts` is the TanStack-Query client for every admin panel call — the shape of its request parameters, its error-translation layer, and its cache-key construction are untested except through component-level mocks.

### A2-1703 — Most tests touch real wall-clock time without a freeze (Low)

48 test files use `Date.now()` / `new Date()` in assertions; only 3 use `vi.useFakeTimers`. A tight-clock test (e.g. a 5-minute-stuck-order assertion running at a millisecond boundary) can flake under CI load. Current mitigations rely on wide tolerances (`±1 min`). Historical evidence suggests this hasn't caused observed flakes, but the category is a ticking bomb once scheduling tests scale. G5-97.

### A2-1704 — E2E-mocked OTP sync signal is brittle; 15+ consecutive CI failures on identical `toBeVisible` timeout (High)

`tests/e2e-mocked/purchase-flow.test.ts:56` — `await expect(page.getByText(/We sent a code to/)).toBeVisible()` — timed out at 5s across 15+ CI runs between 2026-04-22 20:51Z and 2026-04-23 00:11Z. Both specs (happy + wrong-OTP) fail from the same line. Playwright retries set to 2 in CI masked some but the base rate during that window exceeded the retry budget. Root cause is likely the OTP request's auth-store effect / query-client idle-race; the selector has no `waitFor(() => request finished)` synchronisation. Given this is the default test suite on every push to `main`, merge-friction impact is material.

### A2-1705 — No end-to-end journey covering signup → order → fulfillment → credit → recycle → payout (High, G4-03)

Neither `tests/e2e/` nor `tests/e2e-mocked/` drives the full product lifecycle. Mocked cannot — backend is started with a placeholder `DATABASE_URL`, migrations skipped under `NODE_ENV=test`, so every endpoint touching `credit_transactions`, `user_credits`, `pending_payouts`, `orders` (internal DB) is unreachable. Real-upstream suite is one manual workflow that spends real XLM on real CTX — not a regression guard. The canonical "silent break-point between otherwise-correct modules" scenario (G4-03) is explicitly what this gap enables. Pair of mitigations: either (a) add a DB-backed mocked e2e config, or (b) document the journey in an integration test suite against a containerised Postgres. Either is out of scope for the audit; logging the gap here.

### A2-1706 — No CTX contract test (schema drift undetectable in CI) (High, G4-07 overlap)

Our Zod schemas in `apps/backend/src/orders/`, `apps/backend/src/merchants/`, `apps/backend/src/auth/` parse CTX responses at runtime. A CTX field rename / removal / type-narrowing is visible only at first real traffic hit (or the manual `scripts/e2e-real.mjs` workflow). No CI job pins the expected shape via a recorded fixture or a pact contract. Phase 17 has the continuous-detector concern; the point-in-time contract gap sits here.

### A2-1707 — No shared test factories; fixtures re-authored per file (Low)

54 backend test files open with a near-identical `vi.hoisted(() => ({ rows: [], ... }))` block. A shared `tests/factories/` with `makeOrder`, `makeUser`, `makeAdjustment` helpers would consolidate the 54× drift risk and make domain-shape changes a single-file update. Today adding a required column to `orders` requires touching every order test. Pure debt; not a correctness issue.

### A2-1708 — Testing pyramid is top-light: 7 e2e specs guard the full product surface (Medium)

2298 unit `it()` vs 32 integration `it()` vs 7 e2e specs (2 real + 2 mocked, counting per-project expansion). Integration layer (one `routes.integration.test.ts` file) is thin. The mocked-e2e is a single `purchase-flow.test.ts` with two cases. Any failure mode that bridges multiple modules (see A2-1705) has effectively zero test coverage. Not a quick fix, but recording the shape so it's visible at triage.

### A2-1709 — Web vitest coverage threshold ≤ 40 line / 32 branch because routes + home + onboarding are excluded (Low)

`apps/web/vitest.config.ts` excludes `app/routes/**`, `app/root.tsx`, `app/components/features/home/**`, `app/components/features/onboarding/**`. Rationale in the comment says these are Playwright-covered; §4 shows Playwright covers five of ~32 routes and none of onboarding. Net result: the threshold floors of 35/32/40/37 are a regression gate against the non-excluded code only — the product's front door is neither unit-tested nor e2e-tested. Recommended either (a) ratchet thresholds up, (b) add route-level tests, or (c) include the excluded paths and let the number speak truthfully. All three are implementation choices; the gap itself is Info-plus-implication → Low.

### A2-1710 — No property-based tests for `bigint` money math (Medium, G4-01 overlap)

`packages/shared/` + `apps/backend/src/credits/**` + `apps/backend/src/payments/payout-builder.ts` handle `*_minor` bigint arithmetic: add / subtract / round / currency-split. Every test is example-based. A property-based suite (`fast-check` on the sign-convention, round-trip `earn → recycle → balance=0`, and the cashback-split invariant `userCashbackMinor + loopMarginMinor == faceValueMinor - wholesaleMinor`) would catch edge cases example tests cannot enumerate. Phase 6.5 evidence notes "property-based tests — recommended" — still not implemented at commit 450011d.

### A2-1711 — No bundle-size / LCP / CLS / INP budget in CI (Medium, G2-11)

No `size-limit`, `bundlesize`, Lighthouse, or WebPageTest check anywhere in `.github/workflows/`. No Core Web Vitals assertion in the Playwright suites. Phase 8 marked `admin bundle split unverified` (A2-1115). Product is pre-launch but a bundle regression after launch has no canary.

### A2-1712 — No a11y budget / axe scan in CI (Medium, G2-11 / G4-18)

No `@axe-core/playwright` or equivalent. Admin UI a11y (G4-18 "ops productivity") has no automated floor. Each release depends on manual review, which historically doesn't happen.

### A2-1713 — No mutation-testing spot check on critical modules (Low, G5-95)

Would our tests catch a flipped boolean in `credits/adjustments.ts` or `payments/payout-submit.ts`? Unknown — no `stryker` config anywhere. Given A2-1701 (adjustments untested) and A2-610 (accrue-interest db-mocked), the mutation-survivability of money modules is almost certainly poor, but we don't have the empirical number. Flagged so remediation can re-check after A2-1701 is closed.

### A2-1714 — A2-1116 still open: `sitemap.tsx` route loader untested (Low)

Prior finding restated. `apps/web/app/routes/__tests__/sitemap.test.tsx` does not exist. The loader server-fetches merchants via the public API to emit the sitemap XML — a null/empty response or a shape drift would break SEO silently. Same severity it carried in Phase 8.

---

## 12. Reconciliation with priors

- **A2-508** (13 admin handlers untested) — **largely closed**. Admin now has 78 test files for 80 handler files (98%). Remaining two (`audit-envelope.ts`, `idempotency.ts`) re-filed as A2-1700.
- **A2-1116** (`sitemap.tsx` untested) — **still open**, re-filed as A2-1714.
- **A2-610** (accrue-interest tests mock `db`) — **confirmed unchanged**. Same root cause spans procurement + transitions + credits → generalised as A2-1701.

---

## 13. Method notes

1. Handler × test map built from `ls src/<module>/*.ts` vs `ls src/<module>/__tests__/*.test.ts` per module, with a shell loop recording misses.
2. CI flake clustering via `gh run list --branch main --limit 200 --workflow ci.yml --json conclusion` + per-run `gh run view $id --log-failed` for failure bodies.
3. `.skip`/`.only`/`.todo` inventory via `grep -lE "\.(skip|only|todo)" -r --include="*.test.ts" --include="*.test.tsx"` (every match reviewed; all domain hits).
4. Quality sample: 30 test files read end-to-end. See §2 for the classifications.
5. E2E journey coverage: `tests/e2e*/*.spec.ts` read end-to-end + `playwright.config.ts` + `playwright.mocked.config.ts` + `tests/e2e-mocked/fixtures/mock-ctx.mjs`.
6. Priors consulted _after_ independent findings drafted, per §0.2. `docs/audit-2026-tracker.md` index lines 235, 279, 300, 353, 376, 420 reviewed.

---

## 14. Finding tally

- **Critical**: 0
- **High**: 4 — A2-1701, A2-1704, A2-1705, A2-1706
- **Medium**: 6 — A2-1700, A2-1702, A2-1708, A2-1710, A2-1711, A2-1712
- **Low**: 5 — A2-1703, A2-1707, A2-1709, A2-1713, A2-1714
- **Info**: 0

**Total: 15.**

Blockers: none for the audit itself — Phase 14 continues cleanly. The four Highs (A2-1701, A2-1704, A2-1705, A2-1706) are post-audit remediation priorities in the Critical → High queue.
