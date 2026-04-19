# Backend — Agent Guide

> Read this before modifying anything in `apps/backend/`.

## Structure

```
src/
├── app.ts              ← Hono app, middleware, all routes (import this in tests)
├── index.ts            ← Server startup + background tasks only (never import in tests)
├── env.ts              ← Zod-validated env config
├── logger.ts           ← Pino logger
├── upstream.ts         ← upstreamUrl() helper
├── circuit-breaker.ts  ← Shared circuit breaker for upstream calls
├── discord.ts          ← Webhook senders (order created/fulfilled, health, circuit)
├── openapi.ts          ← OpenAPI 3.1 spec (every new handler registers its path + status codes)
├── auth/handler.ts     ← Auth proxy (request-otp, verify-otp, refresh, logout → upstream CTX)
├── orders/handler.ts   ← Order proxy (create, list, get → upstream CTX)
├── merchants/
│   ├── sync.ts         ← Background sync from upstream /merchants
│   └── handler.ts      ← GET /api/merchants endpoints (from in-memory cache)
├── clustering/
│   ├── data-store.ts   ← Background sync from upstream /locations
│   ├── algorithm.ts    ← Grid-based clustering (pure function, no I/O)
│   └── handler.ts      ← GET /api/clusters (protobuf + JSON)
└── images/proxy.ts     ← Image resize proxy with LRU cache + SSRF protection
```

## Key patterns

**Every handler follows this pattern:**

1. Validate input (Zod for body, manual for query params)
2. Do work (call upstream via `getUpstreamCircuit('<endpoint>').fetch(...)`, or read from in-memory store)
3. Validate upstream response (Zod) before forwarding
4. Return typed JSON response with standard error shape `{ code, message }`

**Upstream calls always use:**

- `getUpstreamCircuit('<endpoint-key>').fetch()` — per-endpoint breakers (keys in use: `login`, `verify-email`, `refresh-token`, `logout`, `merchants`, `locations`, `gift-cards`). Never bare `fetch()` from handlers. The per-endpoint split (ADR-004 §Per-endpoint circuit breakers) means a failing endpoint can't trip healthy ones. **Exceptions** (all deliberate — don't replicate elsewhere without a written-down reason):
  - `probeUpstream()` in `app.ts` (`/health`): bare `fetch` to `/status` so the endpoint can detect upstream **recovery** even when the circuit is open for some other endpoint (see `docs/architecture.md §Circuit breaker`).
  - `imageProxyHandler` in `images/proxy.ts`: bare `fetch` of the user-supplied `url` param. Our CTX-keyed breakers are designed for a fixed set of endpoint categories (`login`, `gift-cards`, etc.); image URLs are arbitrary allowlisted hosts — grouping them under one breaker would trip from any single bad host, and the handler already has its own per-request timeout (10s) + a 100 MB / 7-day LRU cache (ADR-005 §5, architecture §Image proxy).
  - `notifyDiscord` in `discord.ts`: the webhook target is Discord, not CTX — not in scope for a CTX-endpoint breaker.
- `upstreamUrl('/path')` — builds full URL from env
- `AbortSignal.timeout()` — every call has a timeout
- Zod validation on response before forwarding

**Error responses always use this shape:**

```json
{ "code": "VALIDATION_ERROR", "message": "human-readable" }
```

Status codes: 400 (validation), 401 (auth), 404 (not found), 429 (rate limit), 502 (upstream error), 503 (circuit open), 500 (internal).

## Recipe: Add a new proxied endpoint

1. Add the handler function in the appropriate module (auth, orders, merchants)
2. Validate request input with Zod
3. Call upstream via `getUpstreamCircuit('<endpoint-key>').fetch(upstreamUrl('/path'), { ... })` — pick an existing key if the call lands on the same upstream endpoint category; add a new key if it's a fresh category (tests: `circuit-breaker.test.ts` exercises registration)
4. Validate upstream response with Zod schema using `.safeParse()`
5. Handle errors. Translate upstream response status — 401 → 401, 404 → 404, any other non-success → 502. Wrap the whole body in `try/catch` and in the catch block handle `CircuitOpenError` → 503 and any other exception → 500 (`{ code: 'INTERNAL_ERROR', ... }`). Skipping the catch-all lets a runtime error fall through as a default Hono response that doesn't match the `{ code, message }` shape — every existing handler follows this pattern for a reason.
6. Register the route in `src/app.ts`
7. Add integration test in `src/__tests__/` or module `__tests__/`
8. Update `docs/architecture.md` API endpoints section and `apps/backend/src/openapi.ts` path registration (declare every status code the handler can return — including 429 if the route is rate-limited and 503 if it proxies to CTX)

## Recipe: Add a new env var

1. Add to Zod schema in `src/env.ts` (use `.optional()` or `.default()`)
2. Add to `.env.example` with comment
3. Add to `.env` for local dev
4. Update `AGENTS.md` (root) env vars section
5. Update `docs/development.md`
6. Update test env mocks in all test files that mock `env.js`

## Testing

Tests import from `src/app.ts` — never from `src/index.ts`.

Every test file mocks: `env.js`, `logger.js`, `circuit-breaker.js`. Test files that test through the Hono app also mock background tasks (`data-store.js`, `sync.js`).

```bash
npm test                     # run all
npm run test:watch           # watch mode
npm run test:coverage        # with coverage report
```
