# Testing

## Testing pyramid

```
         ┌──────────────────┐
         │   e2e (Playwright)│  Slow — critical user paths only
         ├──────────────────┤
         │ integration tests │  Backend HTTP routes (Hono test client)
         ├──────────────────┤
         │   unit tests      │  Pure logic — clustering, auth, services
         └──────────────────┘
```

---

## Unit tests

Framework: **Vitest** (configured per-app in `vitest.config.ts`)

### Backend — what to test

| File | Tests |
|------|-------|
| `src/clustering/algorithm.ts` | All zoom levels, edge cases, centroid accuracy |
| `src/auth/otp.ts` | Generate, verify, expiry, max attempts |
| `src/auth/jwt.ts` | Issue pair, verify access, refresh, expired tokens |
| `src/merchants/sync.ts` | Mapping, filtering disabled merchants |

```bash
cd apps/backend && npm test              # run once
cd apps/backend && npm run test:watch   # watch mode
cd apps/backend && npm run test:coverage
```

Coverage thresholds (backend): **80% lines/functions/branches** for `src/clustering/` and `src/auth/`.

### Web — what to test

| File | Tests |
|------|-------|
| `app/services/*.ts` | API client functions (mock fetch) |
| `app/stores/auth.store.ts` | State transitions |
| `app/hooks/use-merchants.ts` | Query key, return shape |

```bash
cd apps/web && npm test
cd apps/web && npm run test:coverage
```

---

## Integration tests (backend)

Use Hono's built-in test utilities — no real HTTP server needed.

Location: `apps/backend/src/**/__tests__/*.integration.test.ts`

```typescript
import { app } from '../../index.js';
import { testClient } from 'hono/testing';

const client = testClient(app);
const res = await client.health.$get();
expect(res.status).toBe(200);
```

Test the full request/response cycle for:
- `GET /health`
- `GET /api/merchants` (mock data store)
- `POST /api/auth/request-otp` → `POST /api/auth/verify-otp`
- `GET /api/clusters` — both JSON and protobuf response paths

---

## End-to-end tests (Playwright)

Framework: **Playwright** (`playwright.config.ts` at repo root)

Location: `tests/e2e/`

### Running e2e tests

```bash
npm run test:e2e                        # headless, all browsers
npm run test:e2e -- --ui                # Playwright UI mode
npm run test:e2e -- --headed            # visible browser
npm run test:e2e -- tests/e2e/auth.test.ts  # single file
```

### What to cover

| Test file | Scenario |
|-----------|----------|
| `tests/e2e/smoke.test.ts` | App loads, home page renders, no console errors |
| `tests/e2e/auth.test.ts` | Email → OTP → authenticated home |
| `tests/e2e/merchants.test.ts` | Merchant list loads, search works, detail page |
| `tests/e2e/purchase.test.ts` | Select denomination → create order → confirmation |

E2e tests run against a **local dev stack** (web on :5173, backend on :8080 with test env vars).

---

## When tests run

### Pre-commit (Husky lint-staged)

Automatically on every `git commit`:
- ESLint --fix on staged `.ts` / `.tsx` files
- Prettier --write on staged files

Commit is **blocked** if lint fails.

### Pre-push (Husky pre-push)

Automatically on every `git push`:
- `npm test` — all unit tests across all workspaces

Push is **blocked** if any test fails. This keeps CI green.

### CI (GitHub Actions — `.github/workflows/ci.yml`)

Runs on every **push** and **pull request** to `main`:

| Step | What runs |
|------|-----------|
| typecheck | `npm run typecheck` |
| lint | `npm run lint` + `npm run format:check` |
| test:unit | `npm test` |
| test:e2e | `npm run test:e2e` (on PRs to main only) |
| build | `npm run build` (verifies build doesn't break) |

PRs **cannot be merged** if any CI step fails.

---

## Test file naming conventions

```
src/clustering/__tests__/algorithm.test.ts        # unit
src/auth/__tests__/otp.test.ts                    # unit
src/auth/__tests__/jwt.test.ts                    # unit
src/auth/__tests__/handler.integration.test.ts    # integration
tests/e2e/smoke.test.ts                           # e2e
```

---

## Coverage requirements

Run coverage reports locally before PRs touching critical paths:

```bash
cd apps/backend && npm run test:coverage
cd apps/web && npm run test:coverage
```

Target coverage (not enforced in config — review during PRs):

| Package | Target |
|---------|--------|
| backend `src/clustering/` | 90% |
| backend `src/auth/` | 85% |
| web `app/services/` | 70% |
