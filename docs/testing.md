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

### Backend — 176 tests across 14 files

| Module                     | Tests | Coverage                                                               |
| -------------------------- | ----- | ---------------------------------------------------------------------- |
| `clustering/algorithm.ts`  | 13    | All zoom levels, edge cases, centroid accuracy                         |
| `clustering/data-store.ts` | 5     | Pagination, error recovery, NaN coords, disabled, concurrent guard     |
| `merchants/sync.ts`        | 12    | Pagination, disabled filtering, denomination parsing, concurrent guard |
| `orders/handler.ts`        | 10    | Merchant lookup, upstream validation, X-Client-Id, path traversal      |
| `images/proxy.ts`          | 9     | SSRF: localhost, private IPs, IPv6, allowlist, HTTPS enforcement       |
| `circuit-breaker.ts`       | 27    | All state transitions, 4xx exclusion, concurrent probes                |
| Integration routes         | 16    | Health, merchants, auth, orders, clusters                              |

### Web — 133 tests across 12 files

| Module                      | Tests | Coverage                                                                                                                                    |
| --------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Native modules (13 modules) | 47    | Platform, clipboard, haptics, storage, status bar, back button, network, screenshot, share, biometrics, app lock, webview, purchase storage |
| `stores/auth.store.ts`      | 8     | Session management, token storage, clear                                                                                                    |
| `stores/purchase.store.ts`  | 10    | Full state machine: amount → payment → complete/redeem/error                                                                                |
| `stores/ui.store.ts`        | 9     | Theme system/light/dark, toasts, localStorage                                                                                               |
| `services/api-client.ts`    | 6     | GET/POST, auth headers, error handling, binary responses                                                                                    |
| `services/merchants.ts`     | 12    | fetchMerchants, fetchMerchant, fetchMerchantBySlug                                                                                          |
| `services/orders.ts`        | 9     | createOrder, fetchOrders, fetchOrder                                                                                                        |
| `services/auth.ts`          | 8     | requestOtp, verifyOtp, logout, platform detection                                                                                           |
| `services/clusters.ts`      | 5     | Fetch params, Accept header, JSON fallback, errors                                                                                          |
| `utils/error-messages.ts`   | 7     | Offline detection, status codes, fallbacks                                                                                                  |
| `utils/image.ts`            | 8     | URL construction, encoding, width/quality params                                                                                            |
| `hooks/slug.ts`             | 5     | Slugification, special chars, empty input                                                                                                   |

### E2E — 11 tests across 3 files

| Test file                                | Tests | Coverage                                                                                        |
| ---------------------------------------- | ----- | ----------------------------------------------------------------------------------------------- |
| `tests/e2e/smoke.test.ts`                | 5     | Home, auth, map, orders, 404                                                                    |
| `tests/e2e/purchase-flow.test.ts`        | 4     | Merchant detail, search navigation, sign-in flow, map loading (real CTX upstream)               |
| `tests/e2e-mocked/purchase-flow.test.ts` | 2     | Full purchase happy path (email → OTP → amount → payment → redeem) + wrong-OTP, mocked upstream |

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

## Coverage thresholds

| Area                | Target |
| ------------------- | ------ |
| Backend clustering  | 85%    |
| Backend auth/orders | 85%    |
| Web services        | 80%    |
| Web stores          | 80%    |
| Web hooks           | 70%    |
| Overall minimum     | 65%    |
