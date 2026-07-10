# Testing

## Testing pyramid

```
         ┌──────────────────┐
         │   e2e (Playwright)│  Slow — critical user paths only
         ├──────────────────┤
         │ integration tests │  Backend HTTP routes (Hono test client)
         ├──────────────────┤
         │   unit tests      │  Pure logic — stores, services, algorithms
         └──────────────────┘
```

---

## Test inventory

Exact test counts drift every time anyone adds or removes a test, so this
section used to get stale within a week. Instead, treat the vitest / Playwright
output as the source of truth — re-run with `npm test` / `npm run test:e2e`
any time you need an up-to-date number.

### Shared (`packages/shared`)

Vitest unit tests colocated as `src/*.test.ts`. The package's tuples are
pinned to Postgres CHECK constraints and its helpers are the
single-source-of-truth for money math and locale routing, so the tests
lean on exact-pin assertions (state machines, currency↔asset bijection,
Eurozone lockstep between `regions.ts` and `countries.ts`) rather than
example-only coverage. Runs in `npm test` and in CI's unit-test job via
`test:coverage --workspaces` (coverage-thresholded in
`packages/shared/vitest.config.ts`).

### Backend (`apps/backend`)

Vitest unit + integration tests covering:

- `clustering/` — zoom levels, centroid accuracy, pagination, concurrent-refresh guard.
- `merchants/sync.ts` — pagination, denomination parsing, disabled-merchant filtering.
- `orders/handler.ts` — merchant lookup, amount validation (`0.01`–`10_000`), upstream validation, path traversal, `X-Client-Id` plumbing.
- `images/proxy.ts` — SSRF (localhost / private-IP / IPv6 / allowlist / HTTPS enforcement), DNS-rebinding limitations.
- `circuit-breaker.ts` — state transitions, 4xx exclusion, concurrent-probe safety.
- `auth/handler.ts` — request-OTP / verify-OTP / refresh / logout proxies.
- Integration routes — `/health`, `/metrics`, merchants, auth, orders, clusters.

### Web (`apps/web`)

Vitest defaults to the **node** environment (see ADR-005 §7 for the
tradeoff); route coverage is intentionally split across unit tests,
targeted route tests, and a small number of Playwright journeys rather
than claiming blanket browser coverage. Purchase-flow
components override the environment per-file with
`// @vitest-environment jsdom` so `@testing-library/react` can render
the amount-input → payment-step → completion state machine without
spinning up a browser. Covers:

- Native wrappers under `app/native/` — `platform`, `clipboard`, `haptics`, `secure-storage` (A-024 / ADR-006 Keychain-backed), `status-bar`, `back-button`, `keyboard`, `network`, `notifications`, `screenshot-guard`, `share`, `biometrics`, `app-lock`, `webview`, `purchase-storage` (pending-order state).
- Zustand stores — `auth.store`, `purchase.store` (full state machine: amount → payment → complete/redeem/error), `ui.store`.
- Services — `api-client`, `merchants`, `orders`, `auth`, `clusters`.
- Utilities — `error-messages`, `image` (proxy URL builder), `money` (currency-aware formatter), `security-headers`.
- Purchase-flow components (jsdom opt-in per file) — `AmountSelection`, `PaymentStep`, `PurchaseComplete`, `RedeemFlow` — render + event assertions via `@testing-library/react`.
- Hooks — `use-auth`, `use-native-platform`, `use-session-restore`, `query-retry`.
- **Accessibility (ADR 042 / B-2)** — two layers, not one:
  - **Static:** `eslint-plugin-jsx-a11y`'s `recommended` rule set gates `npm run lint` on `apps/web/app/**/*.tsx` (structural JSX mistakes — missing `alt`, unlabeled controls, invalid ARIA, non-interactive elements wired to click handlers). A handful of rule hits are codebase-specific false positives (documented inline + in ADR 042's Consequences section) suppressed with scoped, reasoned `eslint-disable-next-line` comments rather than a blanket rule downgrade — the repo's `--max-warnings=0` lint gate means a rule-level `warn` would still fail CI, so precision matters here.
  - **Runtime:** `jest-axe` (`*.a11y.test.tsx`, jsdom) scans the rendered DOM at the `wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa` rule tags on one smoke test per key surface — `MobileHome`, `PurchaseContainer` (signed-out inline auth), `AuthRoute` (`/auth` sign-in form), `LoopOrdersList`, `Onboarding` (first screen). These are regression smoke tests, not an audit — jsdom has no layout engine so `jest-axe` cannot catch color-contrast violations; that + the keyboard/screen-reader pass remain manual (tracked at `docs/readiness-backlog-2026-07-03.md` B-2).

### E2E (`tests/e2e` + `tests/e2e-mocked` + `tests/e2e-flywheel`)

Playwright suites:

- `tests/e2e/smoke.test.ts` — home / auth / map / orders / 404 smoke on real upstream.
- `tests/e2e/purchase-flow.test.ts` — merchant detail, search navigation, sign-in, map loading on real upstream.
- `tests/e2e-mocked/purchase-flow.test.ts` — full purchase happy path (email → OTP → amount → payment → redeem) + wrong-OTP path, backed by the deterministic mock CTX in `tests/e2e-mocked/fixtures/mock-ctx.mjs`.
- `tests/e2e-flywheel/*.test.ts` — Loop-native flywheel walk (purchase → cashback → withdrawal) against a real Postgres + mocked Stellar/Horizon stack; runs in CI under the `flywheel-integration` lane.
- `scripts/e2e-real.mjs` + `.github/workflows/e2e-real.yml` — manually dispatched real CTX + real Stellar wallet end-to-end run (see **Manual: real CTX + wallet purchase workflow** below).

---

## Running tests

```bash
# All unit tests
npm test

# Single package
npm run test -w @loop/shared
npm run test -w @loop/backend
npm run test -w @loop/web

# Watch mode
cd apps/backend && npm run test:watch
cd apps/web && npm run test:watch

# With coverage
cd apps/backend && npm run test:coverage
cd apps/web && npm run test:coverage

# E2E — self-contained mocked suite (default). Boots mock-ctx + backend +
# web on isolated ports (9091/8081/5174). No external deps, no env vars
# required. This is what `test:e2e` resolves to (audit A-003: previously
# `test:e2e` silently depended on a real backend being up separately and
# failed with missing merchant data).
npm run test:e2e
npm run test:e2e:mocked   # explicit alias for the same mocked suite

# E2E — real upstream. Requires apps/backend to be running locally against
# real CTX (see `docs/development.md`). Only use when validating the live
# upstream contract; `test:e2e` is the right default for feature work.
npm run test:e2e:real

# Everything at once
npm run verify
```

### Mobile Safari opt-in (audit A-004, A-026)

The real-upstream config has a `mobile-safari` project scoped to `smoke.test.ts` only — the purchase-flow suite asserts desktop-only UI (Navbar search is hidden behind `md:block`) and would always fail at mobile widths.

The project is **off by default**: it requires a manually-installed WebKit build and would otherwise break a fresh checkout for anyone who forgot to run `npx playwright install webkit`. Opt in explicitly:

```bash
npx playwright install webkit     # once per machine
MOBILE_SAFARI=1 npm run test:e2e:real
```

`CI` always skips the project regardless of `MOBILE_SAFARI` — GitHub Actions installs chromium only.

---

## When tests run

| Trigger                            | What runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git commit`                       | lint-staged (ESLint + Prettier on changed files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `git push`                         | `npm test` + `lint:docs` (blocks push on failure)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| CI (every push)                    | Quality (typecheck + lint + format:check + lint:docs + `check:openapi-parity` route↔spec gate + `check:dead-flags` + `check:money-invariants` money-critical DB object presence check, T0-3) + Unit tests + Flywheel-integration (real-postgres flywheel walk + `check:migration-parity` migration-replay/schema diff) + Security audit + Secret scan (gitleaks) + Container CVE scan (trivy) + SBOM + Build verification (incl. `check:bundle-budget` after the web SSR build) + Mocked e2e (`test:e2e:mocked`) + Loop-native flywheel e2e + Notify (Discord on pass/fail). |
| CI (PRs only)                      | + real-upstream e2e tests with Playwright (`test:e2e:real`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| GitHub Actions `workflow_dispatch` | **E2E (real Tranche-1 purchase + wallet)** — manually triggered loop-native purchase flow that spends real XLM (or USDC); see below                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### Manual: real Tranche-1 purchase workflow

`scripts/e2e-real.mjs` + `.github/workflows/e2e-real.yml` drive the
loop-native purchase chain end-to-end against the real CTX upstream:
Loop-native auth refresh → `POST /api/orders/loop` → Stellar payment
from the funded test wallet → poll until `state='fulfilled'`.

Default per run: ~$0.02 USD on Aerie + Stellar fees. Aerie's `$0.01`
catalog minimum makes this the cheapest possible real-money flow on
the deployed catalog.

Repository secrets required:

- `LOOP_E2E_REFRESH_TOKEN` — Loop-native refresh token for the test
  account. Bootstrap once via
  `./scripts/bootstrap-e2e-refresh-token.sh --backend
https://api.loopfinance.io --email reviewer@loopfinance.io
--gh-secret`. The script drives `POST /api/auth/request-otp` →
  prompts for the OTP from the inbox → `POST /api/auth/verify-otp` →
  uploads the resulting refresh token to the repo secret via `gh
secret set`. Loop-native rotates the token on every
  `/refresh-token` call, so the workflow rewrites the secret after
  each run via `GH_SECRETS_PAT`.
- `STELLAR_TEST_SECRET_KEY` — secret key (`S…`) of the funded test
  wallet. Mainnet wallet for real-money tests.
- `LOOP_JWT_SIGNING_KEY` — Loop-native HS256 signing key the CI backend
  uses to validate the refresh token. Must match the secret used when
  the refresh token was minted.
- `LOOP_STELLAR_DEPOSIT_ADDRESS` — Loop's deposit address (where the
  test wallet sends XLM/USDC). Same address as production.
- `LOOP_STELLAR_OPERATOR_SECRET` — operator key the CI backend's
  procurement-worker uses to pay CTX in XLM. Same key as production.
- `GH_SECRETS_PAT` — fine-grained PAT scoped to this repo with
  **Secrets: Read and write** permission. Used by the "Rotate
  LOOP_E2E_REFRESH_TOKEN secret" step; without it each run leaves the
  stored refresh token invalid and the next run 401s immediately.

Trigger: GitHub → Actions → **E2E (real Tranche-1 purchase + wallet)**
→ Run workflow. Optional inputs:

- `amount_usd` — blank = `0.02` (Aerie minimum + 1¢ headroom). Any
  numeric override applies.
- `merchant_id` — blank = Aerie. Override id must be a min-max merchant
  whose currency matches `currency`.
- `payment_method` — `xlm` (default) or `usdc`. USDC requires the test
  wallet to hold a USDC trustline + balance against the configured
  issuer.
- `currency` — `USD` (default) | `GBP` | `EUR`. Must match the merchant.

The script can also be run locally against a running Tranche-1 backend
(see `docs/tranche-1-launch.md` for the env block):

```bash
E2E_REFRESH_TOKEN=… STELLAR_TEST_SECRET_KEY=… node scripts/e2e-real.mjs
```

---

## Test patterns

### Backend tests import from `app.ts`, not `index.ts`

`index.ts` calls `serve()` which binds a port. Tests import from `app.ts` to get the Hono app without starting a server.

### All backend tests mock these modules:

- `env.js` — test env values
- `logger.js` — suppress output
- `circuit-breaker.js` — pass-through to global fetch

### Web service tests mock `api-client`:

```typescript
vi.mock('~/services/api-client', () => ({
  apiRequest: vi.fn(),
  authenticatedRequest: vi.fn(),
}));
```

### Native module tests mock `@capacitor/core`:

```typescript
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
    getPlatform: vi.fn(() => 'web'),
  },
}));
```

---

## Coverage

Coverage thresholds are a **regression gate**, not an aspiration. They are
set just below the currently-measured coverage number so that a change
which drags coverage down fails CI. The explicit goal is to **ratchet
them up** as new tests land — never to widen the gap between "what we
test" and "what we claim to test" (audit A-014).

### Authoritative thresholds

Defined in `apps/backend/vitest.config.ts` and `apps/web/vitest.config.ts`.
If you're writing this table from memory, re-run `npm run test:coverage`
in each workspace — the config files are the source of truth.

| Surface                                               | Lines | Branches | Functions | Statements |
| ----------------------------------------------------- | ----- | -------- | --------- | ---------- |
| `apps/backend` (unit / default suite, no integration) | 80%   | 72%      | 75%       | 80%        |
| `apps/web` (excl. routes + root)                      | 37%   | 32%      | 40%       | 35%        |

A4-117: the backend coverage threshold reflects the default vitest
config only. `apps/backend/vitest.integration.config.ts` sets
`coverage: { enabled: false }` and the default config excludes
`src/__tests__/integration/**`, so integration tests run for
correctness but do NOT contribute to coverage numbers.

### Web coverage scope

`apps/web/vitest.config.ts` excludes `app/routes/**` and `app/root.tsx`
from unit-coverage on purpose — the metric is meant to track shared
modules (`services/`, `stores/`, `hooks/`, `utils/`, `native/`, leaf
components), not route assemblies. Some route journeys are exercised by
Playwright (`tests/e2e`, `tests/e2e-mocked`) and a handful of direct
route tests exist under `app/routes/**/__tests__`, but that coverage is
partial, not comprehensive. Excluding routes here is not evidence that
all routes are otherwise covered.

The 37–45% web unit figure reflects the fact that most user-facing UI
is route-level; everything unit-tested today is `services/`, `stores/`,
`hooks/`, `utils/`, `native/`, and leaf `components/`. When moving
route-only logic out into a unit-testable module, add the unit test and
ratchet the threshold up. When a route itself carries high-risk logic,
add a direct route test or Playwright coverage instead of relying on the
coverage exclusion as a proxy.

### Backend coverage scope

Backend currently sits at lines 85%, branches 77%, functions 79%,
statements 84%. The thresholds above (80/72/75/80) are just below those
numbers so ordinary work doesn't need to add tests but a clear
regression fails CI.
