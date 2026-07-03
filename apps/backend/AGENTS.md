# Backend — Agent Guide

> Read this before modifying anything in `apps/backend/`.

## Structure

```
src/
├── app.ts              ← Hono app, middleware, all routes (import this in tests)
├── index.ts            ← Server startup + background tasks only (never import in tests)
├── env.ts              ← Zod env composer + parseEnv (fields live in env/sections/*, D2 split)
├── logger.ts           ← Pino logger
├── upstream.ts         ← upstreamUrl() helper
├── circuit-breaker.ts  ← Shared circuit breaker for upstream calls
├── discord.ts          ← Webhook senders (orders, health, circuit, payout-failed, below-floor)
├── openapi.ts          ← OpenAPI 3.1 spec (every new handler registers its path + status codes)
├── auth/handler.ts     ← Auth proxy + Loop-native OTP (ADR 013 + ADR 014 social login)
├── auth/auth-row-purge.ts ← Retention sweep deleting expired/consumed OTP rows + dead refresh-token rows past LOOP_AUTH_ROW_RETENTION_DAYS (CF-26 / X-PRIV-07/08; gated on LOOP_WORKERS_ENABLED; runbooks/dsr.md)
├── csv/csv-escape.ts   ← Shared CSV cell escaper (RFC 4180 + formula-injection guard; CF-26 / X-PRIV-11). admin/csv-escape.ts re-exports it; user + tax-script exporters import it directly
├── auth/signer.ts      ← Pluggable JWT signer — RS256 (kid = RFC 7638 thumbprint) preferred
│                         when LOOP_JWT_RSA_PRIVATE_KEY is set, HS256 fallback (ADR 030 Phase A)
├── auth/jwks-publish.ts ← GET /.well-known/jwks.json handler — Loop's public RSA JWKS
│                          (publisher side; auth/jwks.ts is the Google/Apple consumer side)
├── auth/require-staff.ts ← ADR 037 staff gate factory — requireStaff('support'|'admin'):
│   │                     staff_roles resolution + users.is_admin legacy shim,
│   │                     404-not-403 concealment, sets `user` + `staffRole` on
│   │                     context. `auth/require-admin.ts` is now the
│   │                     requireStaff('admin') alias (zero behavioral change).
├── admin/              ← Admin-panel handlers (~60 files) grouped by domain:
│   │                     ADR 011 cashback config, ADR 015 treasury + asset
│   │                     drift + settlement lag, ADR 017/018 credit
│   │                     primitives (adjustments / refunds / idempotency /
│   │                     audit envelope), supplier-spend, operator pools,
│   │                     mix-axis matrix (ADR 022), per-merchant / per-user
│   │                     drill-down (ADR 018). Every response shape lives in
│   │                     `@loop/shared/admin-*` (A2-1506) so web + backend +
│   │                     openapi registration compile against one definition.
│   │                     ADR 037 adds: staff-roles.ts (role mgmt writes),
│   │                     watcher-skips.ts (skip browser + reopen),
│   │                     user-wallet.ts (wallet card + reprovision),
│   │                     order-refetch-redemption.ts, lookup.ts (reverse
│   │                     lookup); routes in routes/admin-staff.ts +
│   │                     routes/admin-support-ops.ts.
├── config/handler.ts   ← GET /api/config (feature-flag snapshot — ADR 010)
├── public/             ← ADR 020 Tier-1 unauthenticated never-500 surface:
│   │                     cashback-stats, top-cashback-merchants, cashback-preview,
│   │                     loop-assets, flywheel-stats, merchant-by-id/slug.
│   │                     Shared cache-control + last-known-good fallback.
├── ctx/                ← CTX operator-pool client (ADR 013)
├── credits/
│   ├── payout-asset.ts ← home-currency → LOOP asset code + issuer lookup (ADR 015)
│   ├── payout-builder.ts ← Pure payout-intent decision (pay vs skip) for markOrderFulfilled (ADR 015)
│   ├── pending-payouts.ts ← Pending-payout repo (insert / list / state transitions / in-flight burn sum) (ADR 015/016/036)
│   ├── emissions.ts    ← Admin emission queue primitive — no mirror debit (ADR 024 re-scoped by ADR 036)
│   ├── payout-compensation.ts ← Compensation for LEGACY debited emissions only (ADR 024 §5 / ADR 036)
│   ├── accrue-interest.ts ← LEGACY daily APY accrual primitive on user_credits (off-chain
│   │                     only — hard-gated off while LOOP_INTEREST_ONCHAIN_ENABLED=true)
│   └── interest-mint.ts ← ADR 031/036 Phase D nightly ON-CHAIN interest: UTC-day periods
│                         (watcher_cursors name='interest_mint'), Horizon balance snapshots
│                         → interest_mint_snapshots (migration 0041, sub-minor carry),
│                         mirror credit + kind='interest_mint' payout in one txn per user
├── orders/
│   ├── handler.ts      ← Legacy CTX-proxy order creation
│   ├── loop-handler.ts ← Loop-native order creation with FX-pin (ADR 010 + 015)
│   ├── repo.ts         ← Order INSERT + cashback-split computation
│   ├── transitions.ts  ← markOrderPaid (loop_asset: mirror debit + issuer-return burn enqueue, ADR 036) / markOrderProcuring / markOrderFulfilled (writes ledger + pending_payouts inside one txn)
│   ├── procurement.ts  ← paid → procuring → fulfilled worker (USDC-default, XLM-floor fallback, ADR 015)
│   ├── procurement-redemption.ts ← CTX gift-card detail fetch + waitForRedemption (SSE-first, polling fallback)
│   ├── redeem.ts        ← POST /api/orders/loop/:id/redeem — embedded-wallet LOOP redemption (ADR 036 term): user-signed inner payment + operator fee-bump; watcher settles downstream (ADR 030 C3 / ADR 036)
│   ├── redemption-backfill.ts ← Sweeper re-fetching redemption payloads for fulfilled orders that persisted nulls (migration 0034; pages ops after 10 attempts → runbooks/redemption-backfill-exhausted.md) + refetchOrderRedemption one-shot for the ADR 037 admin action
│   ├── redeem-crypto.ts ← AES-256-GCM envelope for redeem_code/redeem_pin at rest (CF-25; LOOP_REDEEM_ENCRYPTION_KEY; encrypt-on-write, decrypt-on-read, legacy-plaintext passthrough)
│   └── ctx-settlements.ts ← Durable operator→CTX settlement record (hardening A4): one row per order, tx hash persisted before submit (CF-18 pattern) so pay-ctx idempotency uses the authoritative Horizon point lookup, not a bounded memo scan
├── payments/
│   ├── watcher.ts      ← Horizon payment watcher (matches inbound deposits, accepts USDC/XLM/LOOP assets)
│   ├── skipped-payments.ts ← Skipped-deposit retry ledger — persists skips before cursor advance, sweeps each tick (audit CRIT #1/#2)
│   ├── horizon.ts      ← Horizon read client (listAccountPayments, findOutboundPaymentByMemo)
│   ├── horizon-balances.ts ← Horizon /accounts balance reader with 30s cache
│   ├── price-feed.ts   ← XLM + USDC stroops-per-cent + convertMinorUnits FX
│   ├── payout-submit.ts ← @stellar/stellar-sdk sign+submit wrapper with classified error kinds (ADR 016)
│   ├── issuer-signers.ts ← ADR 031 per-asset issuer keypairs (LOOP_STELLAR_*_ISSUER_SECRET,
│   │                     boot-validated against the issuer address) for interest-mint signing
│   └── payout-worker.ts ← Outbound LOOP-asset payout worker with memo-idempotent retry (ADR 016);
│                         kind='interest_mint' rows sign with the ISSUER keypair (mint), all
│                         other kinds with the operator key (ADR 031)
├── wallet/             ← ADR 030 — provider-agnostic embedded wallet.
│   │                     OFF by default (LOOP_WALLET_PROVIDER='').
│   ├── provider.ts     ← WalletProvider interface + getWalletProvider() env factory
│   │                     + WalletProviderError (transient/terminal taxonomy)
│   ├── privy.ts        ← Privy REST adapter — plain fetch + Zod (no SDK dep);
│   │                     query-before-create idempotency on external_id
│   ├── user-signer.ts  ← Verify + attach user-wallet ed25519 signature, then
│   │                     submit via payout-submit's classify path
│   └── provisioning.ts ← Phase C1 — none→wallet_created→activated state machine
│                         (migration 0037): createWallet + ONE operator-sponsored
│                         activation tx (createAccount 0 XLM + LOOP trustlines,
│                         user-signed via the bridge); fire-and-forget signup hook
│                         + 60s backoff sweeper (pages ops after 10 attempts →
│                         runbooks/wallet-provisioning-stuck.md)
├── merchants/
│   ├── sync.ts         ← Background sync from upstream /merchants
│   └── handler.ts      ← GET /api/merchants endpoints (from in-memory cache)
├── clustering/
│   ├── data-store.ts   ← Background sync from upstream /locations
│   ├── algorithm.ts    ← Grid-based clustering (pure function, no I/O)
│   └── handler.ts      ← GET /api/clusters (protobuf + JSON)
├── users/handler.ts    ← GET /me + POST /me/home-currency + PUT /me/stellar-address (ADR 015)
├── users/wallet-handler.ts ← GET /api/me/wallet — embedded-wallet balances, never-500 last-known-good (ADR 030 C4)
├── db/                 ← Drizzle schema + migrations + pool client (ADR 012);
│   │                     schema.ts is a barrel over schema/*.ts per-domain
│   │                     modules (users/credits/merchants/auth/orders/payments/
│   │                     admin/reconciliation — D2 split); add tables to the
│   │                     domain module, not one giant file.
│   │                     staff-roles.ts — ADR 037 role repo (resolution, list,
│   │                     grant/revoke under a fixed advisory lock with
│   │                     last-admin protection + is_admin mirror)
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

1. Add to the Zod field-map for the var's domain in `src/env/sections/` —
   `core.ts` (runtime/upstream/rate-limit/db/admin-identity), `auth.ts`
   (JWT/step-up/social/email/stellar-keys), or `infra.ts`
   (workers/interest/kill-switches/drift). `src/env.ts` spreads these into
   `EnvSchema`, so it stays a thin composer + `parseEnv`. Use `.optional()`
   or `.default()`. (D2 split: env vars no longer live in one giant file.)
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
2. Update the Drizzle types in the table's domain module under
   `db/schema/` (users / credits / merchants / auth / orders / payments /
   admin / reconciliation) — `db/schema.ts` is now a barrel re-exporting
   those (D2 split), so `import { ... } from '../db/schema.js'` call sites
   and drizzle-kit are unchanged. Add tests under
   `db/__tests__/<table>-schema.test.ts` that pin the mirror of any
   new CHECK or index.
3. Append an entry to `apps/backend/src/db/migrations/meta/_journal.json`
   — `idx` = next integer, `tag` = the filename without `.sql`,
   `when` = the prior entry's `when + 100_000`. Keep `version: "7"`
   and `breakpoints: true` to match the existing entries.
4. `runMigrations()` (apps/backend/src/db/client.ts) reads the
   journal at backend boot and applies pending SQL files in order,
   so no manual `db:migrate` call is needed in production.
5. Run `npm run check:migration-parity -w @loop/backend` against a
   disposable postgres (the docker-compose dev DB works). The script
   (`src/scripts/check-migration-parity.ts`) replays the full
   migration chain into one scratch DB, materialises `schema.ts`
   into another via drizzle-kit, and diffs the catalogs — so a
   step-2 omission (schema.ts lagging the SQL) fails here and in
   CI's flywheel-integration job. Shapes Drizzle's DSL cannot
   represent (the ADR-011 triggers, divergent auto-generated
   constraint names) live in `scripts/migration-parity-allowlist.json`
   at the repo root; never allowlist a real column/constraint/index
   divergence.

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
