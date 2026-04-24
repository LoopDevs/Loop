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
├── discord.ts          ← Webhook senders (orders, health, circuit, payout-failed, below-floor)
├── openapi.ts          ← OpenAPI 3.1 spec (every new handler registers its path + status codes)
├── auth/handler.ts     ← Auth proxy + Loop-native OTP (ADR 013 + ADR 014 social login)
├── admin/              ← Admin-panel handlers (~60 files) grouped by domain:
│   │                     ADR 011 cashback config, ADR 015 treasury + asset
│   │                     drift + settlement lag, ADR 017/018 credit
│   │                     primitives (adjustments / refunds / idempotency /
│   │                     audit envelope), supplier-spend, operator pools,
│   │                     mix-axis matrix (ADR 022), per-merchant / per-user
│   │                     drill-down (ADR 018). Every response shape lives in
│   │                     `@loop/shared/admin-*` (A2-1506) so web + backend +
│   │                     openapi registration compile against one definition.
├── config/handler.ts   ← GET /api/config (feature-flag snapshot — ADR 010)
├── public/             ← ADR 020 Tier-1 unauthenticated never-500 surface:
│   │                     cashback-stats, top-cashback-merchants, cashback-preview,
│   │                     loop-assets, flywheel-stats, merchant-by-id/slug.
│   │                     Shared cache-control + last-known-good fallback.
├── ctx/                ← CTX operator-pool client (ADR 013)
├── credits/
│   ├── payout-asset.ts ← home-currency → LOOP asset code + issuer lookup (ADR 015)
│   ├── payout-builder.ts ← Pure payout-intent decision (pay vs skip) for markOrderFulfilled (ADR 015)
│   ├── pending-payouts.ts ← Pending-payout repo (insert / list / state transitions) (ADR 015/016)
│   └── accrue-interest.ts ← Daily APY accrual primitive on user_credits
├── orders/
│   ├── handler.ts      ← Legacy CTX-proxy order creation
│   ├── loop-handler.ts ← Loop-native order creation with FX-pin (ADR 010 + 015)
│   ├── repo.ts         ← Order INSERT + cashback-split computation
│   ├── transitions.ts  ← markOrderPaid / markOrderProcuring / markOrderFulfilled (writes ledger + pending_payouts inside one txn)
│   └── procurement.ts  ← paid → procuring → fulfilled worker (USDC-default, XLM-floor fallback, ADR 015)
├── payments/
│   ├── watcher.ts      ← Horizon payment watcher (matches inbound deposits, accepts USDC/XLM/LOOP assets)
│   ├── horizon.ts      ← Horizon read client (listAccountPayments, findOutboundPaymentByMemo)
│   ├── horizon-balances.ts ← Horizon /accounts balance reader with 30s cache
│   ├── price-feed.ts   ← XLM + USDC stroops-per-cent + convertMinorUnits FX
│   ├── payout-submit.ts ← @stellar/stellar-sdk sign+submit wrapper with classified error kinds (ADR 016)
│   └── payout-worker.ts ← Outbound LOOP-asset payout worker with memo-idempotent retry (ADR 016)
├── merchants/
│   ├── sync.ts         ← Background sync from upstream /merchants
│   └── handler.ts      ← GET /api/merchants endpoints (from in-memory cache)
├── clustering/
│   ├── data-store.ts   ← Background sync from upstream /locations
│   ├── algorithm.ts    ← Grid-based clustering (pure function, no I/O)
│   └── handler.ts      ← GET /api/clusters (protobuf + JSON)
├── users/handler.ts    ← GET /me + POST /me/home-currency + PUT /me/stellar-address (ADR 015)
├── db/                 ← Drizzle schema + migrations + pool client (ADR 012)
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

## Recipe: Add a DB migration

Migrations in this repo are **hand-written SQL**, not generated by
`drizzle-kit generate`. ADR 012 picked Drizzle for the ORM's
TypeScript story; the `generate` workflow was left behind once
migrations started needing shapes Drizzle's schema diff can't
represent: trigger-based audit tables (ADR 011), partial unique
indexes (migration 0013), column CHECK constraints that reference
other columns. Running `npm run db:generate` against the live
`schema.ts` would now DROP the trigger functions (A2-703) and
re-emit a giant diff against the `0000_snapshot.json` baseline
(A2-412). So we don't run it.

To add a migration:

1. Write a new `apps/backend/src/db/migrations/NNNN_short_slug.sql`
   with the forward-SQL. Match the naming of the prior files and
   include a header comment citing the audit/ADR that motivated it.
2. Update `db/schema.ts` so Drizzle's TypeScript types keep pace
   with the real schema. Add tests under
   `db/__tests__/<table>-schema.test.ts` that pin the mirror of any
   new CHECK or index.
3. Append an entry to `apps/backend/src/db/migrations/meta/_journal.json`
   — `idx` = next integer, `tag` = the filename without `.sql`,
   `when` = the prior entry's `when + 100_000`. Keep `version: "7"`
   and `breakpoints: true` to match the existing entries.
4. `runMigrations()` (apps/backend/src/db/client.ts) reads the
   journal at backend boot and applies pending SQL files in order,
   so no manual `db:migrate` call is needed in production.

The `db:generate` and `db:migrate` scripts are retained for
emergency baselining + local tinkering. Don't invoke them without
coordinating with the team.

## Testing

Tests import from `src/app.ts` — never from `src/index.ts`.

Every test file mocks: `env.js`, `logger.js`, `circuit-breaker.js`. Test files that test through the Hono app also mock background tasks (`data-store.js`, `sync.js`).

```bash
npm test                     # run all
npm run test:watch           # watch mode
npm run test:coverage        # with coverage report
```
