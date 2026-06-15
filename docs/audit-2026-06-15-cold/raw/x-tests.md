# Cold Audit — Test Coverage / Quality / Vacuity Sweep (§12, sweep 15)

> Branch `fix/stranded-order-hardening`. Scope: coverage on risky paths,
> vacuous/misleading tests, regression guards for fixed bugs, determinism,
> test infra. Method: per-vertical test:source ratio, then targeted read of
> the highest-risk modules (pay-ctx, procure-one, watcher, redemption,
> refresh-rotation, ledger-invariant, payout-worker, kill-switches, step-up).

Test file totals: **363** (`*.test.ts(x)`). Backend **205**, web **158**.

---

## Coverage

Per-vertical **co-located** test:source ratio (backend `src/<vertical>`).
"Transitive" = covered by integration/flywheel without a co-located unit test.

| Vertical   | src | test | ratio | Notes                                                                                                                                                                                                       |
| ---------- | --: | ---: | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| auth       |  23 |   17 |  0.74 | strong; refresh-race + step-up signer/middleware covered                                                                                                                                                    |
| orders     |  27 |   16 |  0.59 | **procure-one.ts has NO co-located test** (see X-T-01); fulfillment/cashback-split transitive via flywheel                                                                                                  |
| payments   |  22 |   16 |  0.73 | payout-worker + watcher error paths excellent                                                                                                                                                               |
| credits    |  17 |   15 |  0.88 | ledger-invariant real conservation asserts                                                                                                                                                                  |
| admin      |  95 |   87 |  0.92 | **step-up-handler.ts MISSING** (see X-T-02)                                                                                                                                                                 |
| merchants  |   5 |    2 |  0.40 | sync + handler only; eviction/grouping thin                                                                                                                                                                 |
| clustering |   3 |    3 |  1.00 | algorithm + data-store + handler                                                                                                                                                                            |
| ctx        |   2 |    2 |  1.00 | operator-pool + stream                                                                                                                                                                                      |
| db         |   3 |    4 |  1.33 | schema + pooled-url + users                                                                                                                                                                                 |
| discord    |   9 |    4 |  0.44 | notifier breadth thin (40+ notifiers, 4 test files)                                                                                                                                                         |
| images     |   2 |    1 |  0.50 | proxy SSRF covered                                                                                                                                                                                          |
| public     |   7 |    6 |  0.86 | never-500 surfaces covered                                                                                                                                                                                  |
| users      |  18 |   11 |  0.61 | DSR export/delete covered                                                                                                                                                                                   |
| webhooks   |   1 |    1 |  1.00 | hmac-verify                                                                                                                                                                                                 |
| config     |   1 |    1 |  1.00 |                                                                                                                                                                                                             |
| scripts    |   3 |    1 |  0.33 | quarterly-tax-parse only                                                                                                                                                                                    |
| middleware |  11 |    0 |  0.00 | **no co-located tests** — kill-switch/rate-limit/cors/request-context tested via top-level `__tests__/`; access-log/body-limit/cache-control/probe-gate/secure-headers/request-counter only via integration |

Web coverage gate floors (regression-only, not aspirational): lines 37 / func 40
/ branch 32 / stmt 35 — `app/routes/**`, home, onboarding excluded from unit
coverage (honestly documented as partial; Playwright covers some journeys).
Backend gate: lines 80 / branches 72 / statements 80.

---

## Findings

### X-T-01 — P1 — Orders — stranded-order regression NOT guarded at the worker level

`apps/backend/src/orders/procure-one.ts:233-267` is the exact stranded-order
fix surface: when `payCtxOrder` throws (`PayCtxConfigError` /
`PayCtxReconcileError` / `PayoutSubmitError`) the order MUST be marked
`failed` and MUST NOT reach `markOrderFulfilled` (preserving the
fulfilled⟹paid invariant — fulfilled in our ledger but unpaid on CTX is the
pre-#1366 stranded class).

- `procure-one.ts` has **no co-located unit test** (`__tests__/procure-one.test.ts` absent).
- `procurement.test.ts` mocks `payCtxOrder` to **always resolve** (line 55-66, 228-229). It declares `PayCtxConfigError` in the mock (line 60) but **never makes payCtxOrder throw** — confirmed: zero `payCtxOrderMock.mockReject*` calls anywhere (`procurement.test.ts`, `flywheel.test.ts`, `procurement-worker.test.ts`).
- All 4 integration tests that touch `payCtxOrder` mock it to succeed (`flywheel.test.ts:88`, etc.).
- The SEP-7-parse-fail (`procure-one.ts:211-219`) and missing-`paymentUrls` (`:203-210`) → `markOrderFailed` branches are also untested — `procurement.test.ts` only supplies valid SEP-7 URIs (line 171-192).

**Impact:** the highest-value regression in the repo — the bug this branch is
named for — has no test asserting that a pay-ctx failure fails the order
instead of fulfilling it. A refactor that reorders `markOrderFulfilled` ahead
of `payCtxOrder`, or swallows a pay-ctx throw, would pass CI and silently
re-introduce stranded fulfilled-but-unpaid orders.
**Evidence:** `pay-ctx.ts` itself is well covered (config/reconcile/non-native/submit-propagation in `pay-ctx.test.ts`), but the procureOne→markFailed _wiring_ is not.
**Fix:** add `procure-one.test.ts` (or cases to `procurement.test.ts`) that
make `payCtxOrder` throw each of the 3 error classes + return SEP-7-parse-fail

- missing-paymentUrls, asserting `markOrderFailed` called and
  `markOrderFulfilled` NOT called.

### X-T-02 — P2 — Admin — false-coverage comment: step-up mint handler is untested

`apps/backend/src/admin/step-up-handler.ts` (`adminStepUpHandler`, POST
`/api/admin/step-up`) has **no test**. The integration test that consumes
step-up tokens explicitly claims the minting flow is "covered by unit tests":
`apps/backend/src/__tests__/integration/admin-writes.test.ts:87-89` —

> "the integration value here is proving the gated handler accepts a valid
> token, not the step-up minting flow itself (covered by unit tests)."

No such unit test exists. `auth/__tests__/admin-step-up.test.ts` only covers
`isAdminStepUpConfigured` + `signAdminStepUpToken`/`verifyAdminStepUpToken`;
`admin-step-up-middleware.test.ts` only covers `requireAdminStepUp` (the
consumer). The integration test pre-signs via `signAdminStepUpToken` directly
(line 162), bypassing the handler.
**Untested handler branches:** 503-when-unconfigured (`:42-52`),
401-for-CTX-proxy-admin (`:54-63`), VALIDATION_ERROR on bad body (`:65-68`),
NonAsciiEmail→generic-401 (`:73-80`), wrong-OTP→`incrementOtpAttempts`+401
(`:85-87`), consume-once (`markOtpConsumed`, `:89`), success envelope (`:95-98`),
INTERNAL_ERROR catch (`:99-102`).
**Impact:** the OTP re-verification gate for destructive admin actions
(credit-adjust / withdrawal / payout-retry) is unverified, and the doc comment
actively misleads a future maintainer into thinking it is. This is exactly the
"comment claims coverage the test doesn't deliver" class.
**Fix:** add `admin/__tests__/step-up-handler.test.ts`; correct the comment at
`admin-writes.test.ts:87-89`.

### X-T-03 — P3 — Middleware — no co-located tests for several middleware

`apps/backend/src/middleware/` has 11 source files and 0 co-located tests.
kill-switch / rate-limit / cors / request-context / trust-proxy are covered by
top-level `__tests__/`. But `access-log.ts`, `body-limit.ts`,
`cache-control.ts`, `probe-gate.ts`, `secure-headers.ts`, `request-counter.ts`
are only exercised incidentally via `routes.integration.test.ts` (no direct
behavioural assertions on, e.g., 413 body-limit boundary, Cache-Control
per-endpoint values, probe-gate gating). Lower risk (mostly Hono passthroughs)
but body-limit (413 boundary) and cache-control are security/contract-relevant.
**Fix:** add targeted unit tests for body-limit boundary + cache-control values.

### X-T-04 — P3 — Discord/observability — notifier coverage thin

9 source files / 4 test files in `discord/`; the codebase has 40+ notifiers but
only monitoring/admin-audit/asset-drift/stuck-sweepers notifier tests. Redaction
(no PII/codes/PINs in Discord payloads) is asserted only spottily. Lower risk
(outbound, non-money) but redaction is a stated control. **Fix:** add a
redaction-contract test over the notifier builders.

---

## Regression-guard scorecard (fixed-bug classes)

| Bug class                                   | Guard exists?     | Where                                                                                                                                   |
| ------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Stranded-order / pay-ctx (fulfilled⟹paid)   | **PARTIAL — GAP** | `pay-ctx.test.ts` covers pay-ctx's own throws; **procureOne→markFailed wiring untested (X-T-01)**                                       |
| Watcher skip / poison isolation             | YES               | `watcher.test.ts:585` ("skip persistence + poison isolation CRIT #1/#2"), `:586` skip-before-cursor-advance, `skipped-payments.test.ts` |
| Watcher cursor advance safety               | YES               | `watcher.test.ts:402/427/444` (unknown-memo advances, resume-from-cursor)                                                               |
| Redemption "Body already read"              | YES               | `redemption.test.ts:98-130` (consumed-body on one tick doesn't poison subsequent)                                                       |
| Redemption terminal reject → fail order     | YES               | `redemption.test.ts:56`                                                                                                                 |
| Refresh rotation race (A4-098)              | YES               | `native-refresh-race.test.ts`, `refresh-tokens.test.ts:174/187` (CAS win/lose)                                                          |
| Refresh reuse → session revoke (A2-1608)    | YES               | `refresh-tokens.test.ts:150`                                                                                                            |
| A4-017 bigint-money precision               | YES               | `procurement.test.ts:337/357`, `bigint-money-property.test.ts`                                                                          |
| Kill-switch fail-CLOSED on unknown (A4-047) | YES               | `kill-switches.test.ts:36`, per-path `:92`                                                                                              |
| Operator-pool-unavailable → revert (A4-101) | YES               | `procurement.test.ts:413`                                                                                                               |

---

## Vacuity / determinism / infra

- **Vacuity:** no tautologies found — `expect(true).toBe(true)`, self-equal, or
  bare `toBeDefined` patterns: **zero hits** across backend + web. The one
  remaining false-coverage _comment_ is X-T-02. Spot-read of ledger-invariant,
  payout-worker, pay-ctx, watcher confirms real state assertions, not
  mock-echo. (Prior audit's ~12 vacuous tests appear genuinely cleaned up.)
- **Determinism:** `Math.random`/`Date.now` in tests appear only in unique-seed
  data (emails/IPs/ids: `payment-watcher.test.ts:109`, `payout-worker.test.ts:132`,
  `auth/handler.test.ts:104`, `settings.cashback.test.tsx:80`) — not
  assertion-affecting. No flaky patterns surfaced.
- **Import rule:** no test imports from `src/index.ts` (the forbidden entry) —
  clean; tests use `app.ts` / direct module imports.
- **e2e port isolation:** `playwright.mocked.config.ts` uses isolated ports
  (mock CTX 9091, backend 8081, web 5174, test DB `:5433/loop_test`) — good.
  Three suites wired: `playwright.config.ts` (real), `playwright.mocked.config.ts`,
  `playwright.flywheel.config.ts`.
- **Coverage gates:** backend lines 80 / branch 72 / stmt 80; web lines 37 /
  func 40 / branch 32 / stmt 35 (route/home/onboarding excluded, honestly
  documented). Both are regression floors, not aspirations.

---

## Summary

Test suite is broad (363 files) and the highest-risk _primitives_ are well
covered with genuine error-path + edge-case assertions (pay-ctx, payout-worker,
watcher, ledger-invariant, kill-switches, refresh rotation, redemption
body-already-read). No vacuous/tautological tests remain.

Two real gaps, both on destructive/financial seams:

- **P1 X-T-01** — the stranded-order regression (the branch's namesake) is NOT
  guarded at the worker wiring level: `procure-one.ts` has no unit test and
  every test mocks `payCtxOrder` to succeed, so a regression that fulfils an
  order without paying CTX would pass CI.
- **P2 X-T-02** — `adminStepUpHandler` (step-up token mint, the OTP gate for
  destructive admin writes) has zero coverage while a comment in
  `admin-writes.test.ts:87-89` falsely claims it is "covered by unit tests".

Risky modules with NO or thin tests: `orders/procure-one.ts` (none — P1),
`admin/step-up-handler.ts` (none — P2), 6/11 `middleware/*` (incidental only),
`discord/*` notifier redaction (thin). Transitively-covered-but-no-co-located:
`orders/fulfillment.ts`, `orders/cashback-split.ts`, `orders/repo-idempotency.ts`,
`orders/repo-credit-order.ts`, `orders/transitions-sweeps.ts` (acceptable —
exercised by real-postgres flywheel + replay tests).
