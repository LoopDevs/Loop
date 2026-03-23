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
├── auth/handler.ts     ← Auth proxy (login, verify, refresh → upstream CTX)
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
2. Do work (call upstream via `upstreamCircuit.fetch`, or read from in-memory store)
3. Validate upstream response (Zod) before forwarding
4. Return typed JSON response with standard error shape `{ code, message }`

**Upstream calls always use:**

- `upstreamCircuit.fetch()` — not bare `fetch()` (circuit breaker protection)
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
3. Call upstream via `upstreamCircuit.fetch(upstreamUrl('/path'), { ... })`
4. Validate upstream response with Zod schema using `.safeParse()`
5. Handle errors: 401 → 401, 404 → 404, circuit open → 503, other → 502
6. Register the route in `src/app.ts`
7. Add integration test in `src/__tests__/` or module `__tests__/`
8. Update `docs/architecture.md` API endpoints section

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
