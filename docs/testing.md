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

Vitest tests against a jsdom-like environment covering:

- Native wrappers under `app/native/` — platform detection, clipboard, haptics, preferences, status bar, back button, network, screenshot, share, biometrics, app-lock, webview, pending-purchase storage.
- Zustand stores — `auth.store`, `purchase.store` (full state machine: amount → payment → complete/redeem/error), `ui.store`.
- Services — `api-client`, `merchants`, `orders`, `auth`, `clusters`.
- Utilities — `error-messages`, `image`, `money` (currency-aware formatter), `slug` hook.

### E2E (`tests/e2e` + `tests/e2e-mocked`)

Playwright suites:

- `tests/e2e/smoke.test.ts` — home / auth / map / orders / 404 smoke on real upstream.
- `tests/e2e/purchase-flow.test.ts` — merchant detail, search navigation, sign-in, map loading on real upstream.
- `tests/e2e-mocked/purchase-flow.test.ts` — full purchase happy path (email → OTP → amount → payment → redeem) + wrong-OTP path, backed by the deterministic mock CTX in `tests/e2e-mocked/fixtures/mock-ctx.mjs`.
- `scripts/e2e-real.mjs` + `.github/workflows/e2e-real.yml` — manually dispatched real CTX + real Stellar wallet end-to-end run (see **Manual: real CTX + wallet purchase workflow** below).

---

## Running tests

```bash
# All unit tests
npm test

# Single package
npm run test -w @loop/backend
npm run test -w @loop/web

# Watch mode
cd apps/backend && npm run test:watch
cd apps/web && npm run test:watch

# With coverage
cd apps/backend && npm run test:coverage
cd apps/web && npm run test:coverage

# E2E against real upstream (Playwright starts its own dev servers)
npm run test:e2e

# E2E against mocked CTX upstream — fully deterministic, no external deps.
# Boots mock-ctx + backend + web on isolated ports (9091/8081/5174) so it
# can run alongside the real-upstream suite.
npm run test:e2e:mocked

# Everything at once
npm run verify
```

---

## When tests run

| Trigger                            | What runs                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `git commit`                       | lint-staged (ESLint + Prettier on changed files)                                                    |
| `git push`                         | `npm test` + `lint:docs` (blocks push on failure)                                                   |
| CI (every push)                    | typecheck + lint + test + audit + build + mocked e2e                                                |
| CI (PRs only)                      | + real-upstream e2e tests with Playwright                                                           |
| GitHub Actions `workflow_dispatch` | **E2E (real CTX + wallet)** — manually triggered full purchase flow that spends real XLM; see below |

### Manual: real CTX + wallet purchase workflow

`scripts/e2e-real.mjs` + `.github/workflows/e2e-real.yml` drive the full
purchase flow end-to-end against the real CTX upstream, paying an order
from the funded test Stellar wallet and polling until it is fulfilled.

Repository secrets required:

- `CTX_TEST_REFRESH_TOKEN` — refresh token for the test CTX account. CTX
  rotates this on every `/refresh-token` call, so the workflow rewrites
  the secret with the new value after each run.
- `STELLAR_TEST_SECRET_KEY` — secret key (`S…`) of the funded test wallet.
- `GH_SECRETS_PAT` — fine-grained PAT scoped to this repo with
  **Secrets: Read and write** permission. Used only by the "Rotate
  CTX_TEST_REFRESH_TOKEN secret" step; without it each run leaves the
  stored refresh token invalid and the next run 401s immediately.

Trigger: GitHub → Actions → **E2E (real CTX + wallet)** → Run workflow.
Optional inputs: `amount_usd` (default `5`), `merchant_id` (default:
first min-max merchant in the catalog).

The script can also be run locally against a running backend:

```bash
CTX_TEST_REFRESH_TOKEN=… STELLAR_TEST_SECRET_KEY=… node scripts/e2e-real.mjs
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

| Surface                             | Lines | Branches | Functions | Statements |
| ----------------------------------- | ----- | -------- | --------- | ---------- |
| `apps/backend` (unit + integration) | 80%   | 72%      | 75%       | 80%        |
| `apps/web` (excl. routes + root)    | 37%   | 32%      | 40%       | 35%        |

### Web coverage scope

`apps/web/vitest.config.ts` excludes `app/routes/**` and `app/root.tsx`
from coverage on purpose — those surfaces are exercised by Playwright
e2e (`tests/e2e`, `tests/e2e-mocked`), not by unit tests. Double-counting
them would make the number look better without adding confidence.

The 37–45% web unit figure reflects the fact that most user-facing UI
is route-level; everything unit-tested today is `services/`, `stores/`,
`hooks/`, `utils/`, `native/`, and leaf `components/`. When moving
route-only logic out into a unit-testable module, add the unit test and
ratchet the threshold up.

### Backend coverage scope

Backend currently sits at lines 85%, branches 77%, functions 79%,
statements 84%. The thresholds above (80/72/75/80) are just below those
numbers so ordinary work doesn't need to add tests but a clear
regression fails CI.
