# Phase 5a — Backend `apps/backend/src/admin/` audit

**Commit SHA:** `450011ded294b638703a9ba59f4274a3ca5b7187` (branch `main`, clean tree except tracked-but-uncommitted edits outside `apps/backend/`).

**Scope:** every non-test file in `apps/backend/src/admin/` (80 source files, 11 042 lines). Tests in `__tests__/` referenced only as coverage pointers. Out of scope: `auth/`, `db/`, `orders/`, `payments/`, `credits/`, `ctx/`, `merchants/`, `images/`, `public/`, `clustering/`, `users/`, `config/`, root `app.ts` (touched only for middleware / rate-limit cross-reference).

**Method:** §5.1 per file + §5.2 per endpoint from `docs/audit-2026-adversarial-plan.md`. No anchoring on prior audit artifacts.

Finding ID range: `A2-500` … `A2-549` (50-slot budget).

---

## 1. Shared primitives

### 1.1 `audit-envelope.ts` (43 lines)

Exports `AdminAuditEnvelope<T>` interface and the `buildAuditEnvelope` builder that wraps every ADR-017 admin mutation in `{ result, audit: { actorUserId, actorEmail, idempotencyKey, appliedAt, replayed } }`. No DB, no logger, no branching — a pure shape transform. Type-safe, no `any`.

Call sites (grep): `credit-adjustments.ts`, `payouts.ts`. Both consumer handlers use it correctly.

Disposition: `audited-clean`.

### 1.2 `idempotency.ts` (99 lines)

Exports `IDEMPOTENCY_KEY_MIN`, `IDEMPOTENCY_KEY_MAX`, `validateIdempotencyKey`, `lookupIdempotencyKey`, `storeIdempotencyKey`.

- `validateIdempotencyKey`: 16..128 char length window. **No character-class check** — hex, base64url, full arbitrary bytes all pass. ADR-017 doesn't require a format but a client sending user-supplied text (e.g. 16 spaces) passes. Low severity (keys are scoped to `(admin_user_id, key)`; worst case is self-collision on bad client code).
- `lookupIdempotencyKey`: swallows JSON parse errors on a corrupted snapshot (returns `null` ⇒ handler treats as fresh write and overwrites). Comment acknowledges the choice. **No 24h TTL enforced in the store itself** — comment at line 40 explicitly defers to the handler, but NO handler actually checks `createdAt`. A retry-with-same-key will replay a 6-month-old snapshot indefinitely. See `A2-500`.
- `storeIdempotencyKey`: uses `ON CONFLICT DO UPDATE` so a crash between commit and store, when retried, cleanly overwrites. Fine.

Call sites (grep): `credit-adjustments.ts`, `payouts.ts` (adminRetryPayoutHandler).

Disposition: `audited-findings-2`.

### 1.3 `discord-notifiers.ts` (30 lines)

Static catalog read of `DISCORD_NOTIFIERS` from `../discord.js`. Zero DB, synchronous, no secrets leak (symbolic channel names only). Disposition: `audited-clean`.

### 1.4 `discord-test.ts` (73 lines)

POST write but intentionally non-idempotent (Discord-side pings are cheap and ops wants to verify repeatedly after env-var rotation). Validates body (`z.enum`), calls `requireAdmin`-populated `user` context (fail-closed 401 if missing). No reason / audit envelope — the ping itself is the audit (embedded in Discord). Rate-limit 10/min matches the `spam = enumeration` guard in the docstring. Disposition: `audited-clean` (conscious ADR-017 exception: ping, not state mutation).

### 1.5 `discord-config.ts` (32 lines)

GET, env-var presence-only (never echoes URL). **`DISCORD_WEBHOOK_ADMIN_AUDIT` is not reported** — only `orders` and `monitoring`. `notifyAdminAudit` / `notifyCashbackConfigChanged` post to `DISCORD_WEBHOOK_ADMIN_AUDIT` (line 437, 494 of `discord.ts`). Admin panel can't render a "admin-audit unconfigured" badge. See `A2-501`.

Disposition: `audited-findings-1`.

### 1.6 `handler.ts` — `listConfigsHandler`, `upsertConfigHandler`, `configHistoryHandler` (139 lines)

- `listConfigsHandler` (GET /merchant-cashback-configs): no try/catch, small table. Low severity — on error, global `onError` returns generic 500 via Sentry.
- **`upsertConfigHandler` (PUT /merchant-cashback-configs/:merchantId): MATERIAL FINDING.** This writes the cashback-split table that drives every order's economics. ADR-017 mandates: actor from context (✓), **idempotency key (✗)**, **reason field (✗)**, **audit envelope response (✗)**, Discord fanout after commit (✓ via `notifyCashbackConfigChanged`). A double-clicked PUT therefore triggers a second write and a second `notifyCashbackConfigChanged` embed — identical values, but the history table's pre-edit trigger still captures a no-op diff and the audit trail is noisier than it needs to be. Much more importantly, this is the single most commercially-sensitive admin surface and it is not ADR-017-compliant at all. See `A2-502`.
- `configHistoryHandler`: no try/catch. Same low-severity comment as above.

Disposition: `audited-findings-1` (A2-502 High).

---

## 2. Per-handler matrix

Column key:

- **Auth**: `A+A` = `requireAuth + requireAdmin` (all admin routes inherit via `app.use('/api/admin/*', ...)` at app.ts:940-941).
- **RL**: rate limit per minute (from app.ts wiring).
- **Idem**: ADR-017 idempotency compliance for writes. `n/a` for reads.
- **OpenAPI**: registered in `apps/backend/src/openapi.ts`.
- **Test**: `__tests__/<name>.test.ts` exists.
- **Find**: finding count in this phase.

| Handler file                      | Route                                          | Method | Auth | RL  | Idem                       | OpenAPI | Test                       | Find                                                              |
| --------------------------------- | ---------------------------------------------- | ------ | ---- | --- | -------------------------- | ------- | -------------------------- | ----------------------------------------------------------------- |
| handler.ts (list)                 | /merchant-cashback-configs                     | GET    | A+A  | 120 | n/a                        | yes     | yes                        | 0                                                                 |
| handler.ts (upsert)               | /merchant-cashback-configs/:merchantId         | PUT    | A+A  | 60  | **NO**                     | yes     | yes                        | **A2-502**                                                        |
| handler.ts (history)              | /merchant-cashback-configs/:merchantId/history | GET    | A+A  | 120 | n/a                        | yes     | yes                        | 0                                                                 |
| configs-history.ts                | /merchant-cashback-configs/history             | GET    | A+A  | 120 | n/a                        | yes     | yes                        | 0                                                                 |
| cashback-configs-csv.ts           | /merchant-cashback-configs.csv                 | GET    | A+A  | 10  | n/a                        | yes     | yes                        | 0                                                                 |
| merchants-catalog-csv.ts          | /merchants-catalog.csv                         | GET    | A+A  | 10  | n/a                        | yes     | yes                        | **A2-503, A2-504**                                                |
| treasury.ts                       | /treasury                                      | GET    | A+A  | 60  | n/a                        | yes     | (indirect via -csv test)   | 0                                                                 |
| treasury-snapshot-csv.ts          | /treasury.csv                                  | GET    | A+A  | 10  | n/a                        | yes     | yes                        | 0                                                                 |
| treasury-credit-flow.ts           | /treasury/credit-flow                          | GET    | A+A  | 60  | n/a                        | yes     | (via -csv)                 | 0                                                                 |
| treasury-credit-flow-csv.ts       | /treasury/credit-flow.csv                      | GET    | A+A  | 10  | n/a                        | yes     | yes                        | 0                                                                 |
| asset-circulation.ts              | /assets/:assetCode/circulation                 | GET    | A+A  | 30  | n/a                        | yes     | yes                        | 0                                                                 |
| asset-drift-state.ts              | /asset-drift/state                             | GET    | A+A  | 120 | n/a                        | yes     | yes                        | 0                                                                 |
| payouts.ts (list)                 | /payouts                                       | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| payouts.ts (detail)               | /payouts/:id                                   | GET    | A+A  | 120 | n/a                        | yes     | yes                        | 0                                                                 |
| payouts.ts (by-order)             | /orders/:orderId/payout                        | GET    | A+A  | 120 | n/a                        | yes     | yes                        | 0                                                                 |
| payouts.ts (retry)                | /payouts/:id/retry                             | POST   | A+A  | 20  | yes                        | yes     | yes                        | 0                                                                 |
| payouts-csv.ts                    | /payouts.csv                                   | GET    | A+A  | 10  | n/a                        | yes     | yes                        | 0                                                                 |
| payouts-by-asset.ts               | /payouts-by-asset                              | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| settlement-lag.ts                 | /payouts/settlement-lag                        | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| top-users.ts                      | /top-users                                     | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| top-users-by-pending-payout.ts    | /users/top-by-pending-payout                   | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| users-recycling-activity.ts       | /users/recycling-activity                      | GET    | A+A  | 60  | n/a                        | **NO**  | yes                        | **A2-505**                                                        |
| users-recycling-activity-csv.ts   | /users/recycling-activity.csv                  | GET    | A+A  | 10  | n/a                        | **NO**  | yes                        | **A2-505**                                                        |
| audit-tail.ts                     | /audit-tail                                    | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| audit-tail-csv.ts                 | /audit-tail.csv                                | GET    | A+A  | 10  | n/a                        | yes     | yes                        | 0                                                                 |
| orders.ts (get)                   | /orders/:orderId                               | GET    | A+A  | 120 | n/a                        | yes     | yes                        | 0                                                                 |
| orders.ts (list)                  | /orders                                        | GET    | A+A  | 60  | n/a                        | **NO**  | yes                        | **A2-506**                                                        |
| merchant-flows.ts                 | /merchant-flows                                | GET    | A+A  | 60  | n/a                        | yes     | yes                        | **A2-507** (no try/catch)                                         |
| discord-config.ts                 | /discord/config                                | GET    | A+A  | 60  | n/a                        | yes     | yes                        | A2-501 (coverage)                                                 |
| user-search.ts                    | /users/search                                  | GET    | A+A  | 60  | n/a                        | yes     | (no test file)             | **A2-507** (no try/catch) + **A2-508** (no test for this handler) |
| user-credits-csv.ts               | /user-credits.csv                              | GET    | A+A  | 20  | n/a                        | **NO**  | (no test file)             | **A2-505** + **A2-508**                                           |
| reconciliation.ts                 | /reconciliation                                | GET    | A+A  | 30  | n/a                        | yes     | yes                        | **A2-507** (no try/catch)                                         |
| orders-activity.ts                | /orders/activity                               | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| payment-method-share.ts           | /orders/payment-method-share                   | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| payment-method-activity.ts        | /orders/payment-method-activity                | GET    | A+A  | 60  | n/a                        | **NO**  | yes                        | **A2-506**                                                        |
| orders-csv.ts                     | /orders.csv                                    | GET    | A+A  | 10  | n/a                        | yes     | yes                        | 0                                                                 |
| stuck-orders.ts                   | /stuck-orders                                  | GET    | A+A  | 120 | n/a                        | yes     | yes                        | 0                                                                 |
| stuck-payouts.ts                  | /stuck-payouts                                 | GET    | A+A  | 120 | n/a                        | yes     | yes                        | 0                                                                 |
| cashback-activity.ts              | /cashback-activity                             | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| cashback-activity-csv.ts          | /cashback-activity.csv                         | GET    | A+A  | 10  | n/a                        | yes     | yes                        | 0                                                                 |
| cashback-realization.ts           | /cashback-realization                          | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| cashback-realization-daily.ts     | /cashback-realization/daily                    | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| cashback-realization-daily-csv.ts | /cashback-realization/daily.csv                | GET    | A+A  | 10  | n/a                        | yes     | yes                        | 0                                                                 |
| cashback-monthly.ts               | /cashback-monthly                              | GET    | A+A  | 60  | n/a                        | **NO**  | yes                        | **A2-506**                                                        |
| payouts-monthly.ts                | /payouts-monthly                               | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| payouts-activity.ts               | /payouts-activity                              | GET    | A+A  | 60  | n/a                        | yes     | (no file; tested via -csv) | 0                                                                 |
| payouts-activity-csv.ts           | /payouts-activity.csv                          | GET    | A+A  | 10  | n/a                        | yes     | yes                        | 0                                                                 |
| supplier-spend-activity-csv.ts    | /supplier-spend/activity.csv                   | GET    | A+A  | 10  | n/a                        | yes     | yes                        | 0                                                                 |
| operators-snapshot-csv.ts         | /operators-snapshot.csv                        | GET    | A+A  | 10  | n/a                        | yes     | yes                        | 0                                                                 |
| merchant-stats.ts                 | /merchant-stats                                | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| merchant-stats-csv.ts             | /merchant-stats.csv                            | GET    | A+A  | 10  | n/a                        | **NO**  | yes                        | **A2-506**                                                        |
| merchants-flywheel-share.ts       | /merchants/flywheel-share                      | GET    | A+A  | 60  | n/a                        | **NO**  | yes                        | **A2-506**                                                        |
| merchants-flywheel-share-csv.ts   | /merchants/flywheel-share.csv                  | GET    | A+A  | 10  | n/a                        | **NO**  | yes                        | **A2-506**                                                        |
| merchant-flywheel-stats.ts        | /merchants/:merchantId/flywheel-stats          | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| merchant-cashback-summary.ts      | /merchants/:merchantId/cashback-summary        | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| merchant-payment-method-share.ts  | /merchants/:merchantId/payment-method-share    | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| merchant-cashback-monthly.ts      | /merchants/:merchantId/cashback-monthly        | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| merchant-flywheel-activity.ts     | /merchants/:merchantId/flywheel-activity       | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| merchant-flywheel-activity-csv.ts | /merchants/:merchantId/flywheel-activity.csv   | GET    | A+A  | 10  | n/a                        | yes     | yes                        | 0                                                                 |
| merchant-top-earners.ts           | /merchants/:merchantId/top-earners             | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| supplier-spend.ts                 | /supplier-spend                                | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| supplier-spend-activity.ts        | /supplier-spend/activity                       | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| operator-supplier-spend.ts        | /operators/:operatorId/supplier-spend          | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| operator-activity.ts              | /operators/:operatorId/activity                | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| operator-stats.ts                 | /operator-stats                                | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| operator-latency.ts               | /operators/latency                             | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| merchant-operator-mix.ts          | /merchants/:merchantId/operator-mix            | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| operator-merchant-mix.ts          | /operators/:operatorId/merchant-mix            | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| user-operator-mix.ts              | /users/:userId/operator-mix                    | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| user-credits.ts                   | /users/:userId/credits                         | GET    | A+A  | 120 | n/a                        | yes     | (no file)                  | **A2-508**                                                        |
| user-credit-transactions.ts       | /users/:userId/credit-transactions             | GET    | A+A  | 120 | n/a                        | yes     | (no file)                  | **A2-508**                                                        |
| user-credit-transactions-csv.ts   | /users/:userId/credit-transactions.csv         | GET    | A+A  | 10  | n/a                        | **NO**  | (no file)                  | **A2-505** + **A2-508**                                           |
| user-cashback-by-merchant.ts      | /users/:userId/cashback-by-merchant            | GET    | A+A  | 60  | n/a                        | **NO**  | (no file)                  | **A2-506** + **A2-508**                                           |
| user-cashback-summary.ts          | /users/:userId/cashback-summary                | GET    | A+A  | 60  | n/a                        | **NO**  | (no file)                  | **A2-506** + **A2-508**                                           |
| user-flywheel-stats.ts            | /users/:userId/flywheel-stats                  | GET    | A+A  | 60  | n/a                        | yes     | (no file)                  | **A2-508**                                                        |
| user-payment-method-share.ts      | /users/:userId/payment-method-share            | GET    | A+A  | 60  | n/a                        | yes     | (no file)                  | **A2-508**                                                        |
| user-cashback-monthly.ts          | /users/:userId/cashback-monthly                | GET    | A+A  | 60  | n/a                        | yes     | (no file)                  | **A2-508**                                                        |
| user-detail.ts                    | /users/:userId                                 | GET    | A+A  | 120 | n/a                        | yes     | (no file)                  | **A2-508**                                                        |
| user-by-email.ts                  | /users/by-email                                | GET    | A+A  | 60  | n/a                        | yes     | (no file)                  | **A2-508**                                                        |
| users-list.ts                     | /users                                         | GET    | A+A  | 60  | n/a                        | yes     | (no file)                  | **A2-508**                                                        |
| credit-adjustments.ts             | /users/:userId/credit-adjustments              | POST   | A+A  | 60  | yes                        | yes     | yes                        | 0                                                                 |
| merchants-resync.ts               | /merchants/resync                              | POST   | A+A  | 2   | **NO (but see note)**      | yes     | yes                        | **A2-509**                                                        |
| discord-notifiers.ts              | /discord/notifiers                             | GET    | A+A  | 60  | n/a                        | yes     | yes                        | 0                                                                 |
| discord-test.ts                   | /discord/test                                  | POST   | A+A  | 10  | n/a (ping, not a mutation) | yes     | yes                        | 0                                                                 |

Note: `merchants-resync` triggers an upstream CTX re-sync that mutates the in-memory catalog store; the underlying `forceRefreshMerchants` has an internal mutex so concurrent calls coalesce, but the POST itself has no `Idempotency-Key` header contract. A botched retry doesn't double-credit anyone, but it does double-load CTX at the 2/min rate ceiling. `A2-509` Low.

Total endpoints: 80 unique (count excludes `app.use('/api/admin/*', ...)` prefixes).

---

## 3. CSV handler matrix (Tier-3, ADR 018)

All CSV handlers checked for: RFC 4180 escape, `text/csv; charset=utf-8`, `Cache-Control: private, no-store`, `Content-Disposition: attachment`, row cap with `__TRUNCATED__` sentinel + log-warn on overflow, rate limit 10/min (20/min for `user-credits.csv`).

| File                              | Row cap                                                | Sentinel   | Cache-Control    | Content-Type | RFC4180 | Findings           |
| --------------------------------- | ------------------------------------------------------ | ---------- | ---------------- | ------------ | ------- | ------------------ |
| audit-tail-csv.ts                 | 10 000                                                 | yes        | private,no-store | ok           | ok      | 0                  |
| cashback-activity-csv.ts          | 10 000                                                 | yes        | ok               | ok           | ok      | 0                  |
| cashback-configs-csv.ts           | 10 000                                                 | yes        | ok               | ok           | ok      | 0                  |
| cashback-realization-daily-csv.ts | 10 000                                                 | yes        | ok               | ok           | ok      | 0                  |
| merchant-flywheel-activity-csv.ts | 10 000                                                 | yes        | ok               | ok           | ok      | 0                  |
| merchant-stats-csv.ts             | 10 000                                                 | yes        | ok               | ok           | ok      | 0                  |
| merchants-catalog-csv.ts          | 10 000                                                 | see A2-503 | ok               | ok           | ok      | **A2-503, A2-504** |
| merchants-flywheel-share-csv.ts   | 10 000                                                 | yes        | ok               | ok           | ok      | 0                  |
| operators-snapshot-csv.ts         | 10 000                                                 | yes        | ok               | ok           | ok      | 0                  |
| orders-csv.ts                     | 10 000                                                 | yes        | ok               | ok           | ok      | 0                  |
| payouts-activity-csv.ts           | 10 000                                                 | yes        | ok               | ok           | ok      | 0                  |
| payouts-csv.ts                    | 10 000                                                 | yes        | ok               | ok           | ok      | 0                  |
| supplier-spend-activity-csv.ts    | 10 000                                                 | yes        | ok               | ok           | ok      | 0                  |
| treasury-credit-flow-csv.ts       | 10 000                                                 | yes        | ok               | ok           | ok      | 0                  |
| treasury-snapshot-csv.ts          | — (in-mem fan-out of treasury snapshot, not row-based) | n/a        | ok               | ok           | ok      | 0                  |
| user-credit-transactions-csv.ts   | 10 000                                                 | yes        | ok               | ok           | ok      | 0                  |
| user-credits-csv.ts               | 10 000                                                 | yes        | ok               | ok           | ok      | 0                  |
| users-recycling-activity-csv.ts   | 10 000                                                 | yes        | ok               | ok           | ok      | 0                  |

Truncation sentinels: all files use `csvRow(['__TRUNCATED__'])` (quoted-empty in the remaining columns) except `user-credits-csv.ts` line 75 which writes the bare string `'__TRUNCATED__'` without `csvRow` wrapping. This is consistent-enough but subtly divergent: a consumer filtering on the sentinel sees 8 cells on one CSV and 1 cell on another. See `A2-510`.

---

## 4. Notifier catalog (external calls from admin handlers)

| Source                                           | Webhook env                   | Called from                       | Blocking?                              | Leaks PII?                                                                                      |
| ------------------------------------------------ | ----------------------------- | --------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `notifyAdminAudit` (`discord.ts:394`)            | `DISCORD_WEBHOOK_ADMIN_AUDIT` | credit-adjustments.ts, payouts.ts | fire-and-forget via `void sendWebhook` | **Yes — full `actorEmail`** in embed field. Low: Discord-channel members are staff. See A2-511. |
| `notifyCashbackConfigChanged` (`discord.ts:465`) | `DISCORD_WEBHOOK_ADMIN_AUDIT` | handler.ts upsertConfigHandler    | fire-and-forget                        | No email — `actorUserId` truncated to last 8 chars. OK.                                         |
| `notifyWebhookPing`                              | caller-chosen channel         | discord-test.ts                   | fire-and-forget                        | Last 8 of admin id only. OK.                                                                    |

Envelope timing: both ADR-017 notifiers fire AFTER the DB commit in `credit-adjustments.ts` and `payouts.ts`. Discord failure cannot revert the write. Consistent with the ADR.

---

## 5. Input-validation summary

- UUID-regex for user/payout ids: defined locally in 10+ handlers, each a copy of `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`. Same value, drift-prone. `A2-512` Low.
- merchantId shape: `/^[A-Za-z0-9._-]+$/`, length ≤128. Used in `orders.ts`, `merchant-top-earners.ts`. Not consistently applied — several merchant-scoped endpoints (e.g. `merchant-cashback-summary.ts`, `merchant-flywheel-stats.ts`, `merchant-flywheel-activity.ts`, `merchant-cashback-monthly.ts`, `merchant-payment-method-share.ts`, `merchant-operator-mix.ts`) pass the raw `:merchantId` into a parameterised query without any shape check. pg parameterisation prevents SQL injection, but a pathological 10 KB merchantId would happily issue a bounded-ok but wasteful query and cache-miss. `A2-513` Low.
- Date parsing for `?since` / `?before`: every callsite uses `new Date(raw)` + `Number.isNaN(d.getTime())` guard. `new Date('2024-13-40')` returns a valid Date (JS rolls over). Accepted as documented quirk but the handlers then happily issue a query against a nonsense month. Low.

---

## 6. Error-envelope / information-leak summary

- All handlers use `{ code, message }` envelope consistently for 4xx/5xx.
- Global `onError` (app.ts:1529-1535) returns `{ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId }` with 500 for any uncaught throw. Stack is NOT echoed to the client — captured to Sentry.
- Handlers lacking try/catch (asset-drift-state.ts — synchronous-only; discord-config.ts — no awaits; discord-notifiers.ts — static; handler.ts listConfigsHandler/configHistoryHandler; merchant-flows.ts; user-search.ts; reconciliation.ts) fall through to the global 500. Client sees `INTERNAL_ERROR` instead of the handler-specific `Failed to X` code used elsewhere. Cosmetic only. `A2-507` Low.
- The merchant-catalog fallback `merchantsById.get(merchantId)?.name ?? merchantId` (handler.ts:107, cashback-configs-csv.ts:105, configs-history.ts:86, merchants-catalog-csv.ts n/a) follows ADR-021 Rule A. OK.

---

## 7. Dead / unreferenced / abandoned

Every exported handler in `admin/` is imported and mounted in `app.ts`. No orphans.

`idempotency.ts`'s `IdempotencySnapshot.createdAt` field is returned from `lookupIdempotencyKey` but NO caller uses it. A future-TTL check is stubbed out in the docstring but never wired. Reinforces `A2-500`.

---

## 8. OpenAPI drift — admin endpoints in app.ts but missing registration

Cross-checked `app.ts` route registration list against `apps/backend/src/openapi.ts`. Mounted admin endpoints with **no corresponding** `registerPath({ path: '/api/admin/...' })`:

1. `GET /api/admin/cashback-monthly` → cashback-monthly.ts
2. `GET /api/admin/merchant-stats.csv` → merchant-stats-csv.ts
3. `GET /api/admin/merchants/flywheel-share` → merchants-flywheel-share.ts
4. `GET /api/admin/merchants/flywheel-share.csv` → merchants-flywheel-share-csv.ts
5. `GET /api/admin/orders` → orders.ts adminListOrdersHandler
6. `GET /api/admin/orders/payment-method-activity` → payment-method-activity.ts
7. `GET /api/admin/user-credits.csv` → user-credits-csv.ts
8. `GET /api/admin/users/{userId}/cashback-by-merchant` → user-cashback-by-merchant.ts
9. `GET /api/admin/users/{userId}/cashback-summary` → user-cashback-summary.ts
10. `GET /api/admin/users/{userId}/credit-transactions.csv` → user-credit-transactions-csv.ts
11. `GET /api/admin/users/recycling-activity` → users-recycling-activity.ts
12. `GET /api/admin/users/recycling-activity.csv` → users-recycling-activity-csv.ts

12 admin endpoints not exposed in the generated spec. Filed as `A2-505` (CSVs — their fields can leak PII like email without spec disclosure) and `A2-506` (non-CSVs — cosmetic / client-SDK miss). AGENTS.md rule "API response shape or field → schema in `openapi.ts`" applies.

---

## 9. Findings

### A2-500 — Admin idempotency snapshots never expire (Medium)

**Files:** `apps/backend/src/admin/idempotency.ts` (entire file).

**Evidence:** Line 40-41 docstring: "The caller is responsible for the 24h TTL check — we return whatever the row has and let the handler decide". No handler (`credit-adjustments.ts`, `payouts.ts`) checks `prior.createdAt`. There's no scheduled cleanup job referenced in the scheduler. A 6-month-old snapshot will replay on an identical (admin, key) POST indefinitely.

**Impact:** Operator runbook collision. If an admin re-uses a bookmarked URL from last quarter (Idempotency-Key in JS-client-side persistent state), they get the six-month-old response replayed with `replayed:true` instead of a fresh credit adjustment. Audit channel sees a "🔁 replayed" embed that correlates to no real-world retry. Also an unbounded growth surface on `admin_idempotency_keys` — no TTL, no sweep.

**Remediation:** Implement the TTL either as (a) a `WHERE created_at >= NOW() - INTERVAL '24 hours'` filter in `lookupIdempotencyKey`, returning `null` on expired rows so they're overwritten on the next write, or (b) a nightly `DELETE FROM admin_idempotency_keys WHERE created_at < NOW() - INTERVAL '30 days'` sweeper. Document the chosen TTL in ADR-017.

---

### A2-501 — `admin/discord/config` omits `DISCORD_WEBHOOK_ADMIN_AUDIT` (Medium)

**Files:** `apps/backend/src/admin/discord-config.ts:27-32`, `apps/backend/src/discord.ts:437, 494`.

**Evidence:** Handler returns only `orders` and `monitoring` channel status. `notifyAdminAudit` and `notifyCashbackConfigChanged` both fire at `env.DISCORD_WEBHOOK_ADMIN_AUDIT`. If that env var is missing the admin panel cannot surface "your admin-write audit trail is going to /dev/null" — ops sees writes succeed in the UI, but no Discord trail lands.

**Impact:** Silent loss of audit-channel signal on a deploy where `DISCORD_WEBHOOK_ADMIN_AUDIT` is unset. Compliance-sensitive (SOC-2 control: "admin writes generate contemporaneous audit trail").

**Remediation:** Add `adminAudit: statusOf(env.DISCORD_WEBHOOK_ADMIN_AUDIT)` to `AdminDiscordConfigResponse`. Update openapi.ts schema and any consuming client.

---

### A2-502 — `PUT /merchant-cashback-configs/:merchantId` bypasses ADR-017 (High)

**Files:** `apps/backend/src/admin/handler.ts:43-124`, `apps/backend/src/app.ts:968-972`.

**Evidence:** `upsertConfigHandler` mutates `merchant_cashback_configs` (the source of truth for every subsequent order's wholesale/cashback/margin split per ADR 011). It has:

- Actor from context (✓).
- No `Idempotency-Key` header requirement.
- No `reason` field in the body schema.
- Response shape is `{ config: row }`, NOT the ADR-017 `{ result, audit }` envelope.
- Discord fanout via `notifyCashbackConfigChanged` (separate channel from `notifyAdminAudit`), but no `notifyAdminAudit` call either.

Compare with `credit-adjustments.ts` (210 lines, fully ADR-017-compliant) and `payouts.ts adminRetryPayoutHandler` (also compliant). This is the oldest admin-write handler and hasn't been uplifted.

**Impact:** A double-click on the admin panel's "save config" button at the 60/min rate ceiling triggers a second PUT, a second upsert (no-op at DB level because values match), a second history-table row (because the DB trigger captures the pre-edit row which is now the first-commit's values — so diff is zero but the history row still lands), and a second Discord embed. More importantly, without `reason`, the audit channel lacks the "why did you change this" narrative that ADR 017 makes invariant for adjustment and retry. Pre-launch: high risk because this table drives every order's economics.

**Remediation:** Uplift to ADR-017 — require `Idempotency-Key`, add `reason: string.min(2).max(500)` to `UpsertBody`, call `lookupIdempotencyKey` / `storeIdempotencyKey`, wrap response in `buildAuditEnvelope`, and fire `notifyAdminAudit` alongside the existing `notifyCashbackConfigChanged`.

---

### A2-503 — `merchants-catalog-csv` truncates on the wrong side (Low)

**Files:** `apps/backend/src/admin/merchants-catalog-csv.ts:94-121`.

**Evidence:** The handler computes `total = merchants.length` (in-memory catalog size) and truncates that. The DB side (`merchantCashbackConfigs`) has no cap — it pulls every row and joins in-memory. Opposite of the contract the other CSV handlers follow (DB-side `LIMIT ROW_CAP + 1`). With the current catalog at hundreds of rows, the cap is inoperative. If someone later loads a 20 000-row `merchant_cashback_configs` table (regression scenario: a bulk-importer slice adds rows without deleting), this handler's SELECT is unbounded.

**Impact:** Latent OOM / slow-query risk if config-table size balloons. Pre-launch: the code isn't load-bearing yet, but every other CSV handler gates on the DB result, and this one breaks the pattern silently.

**Remediation:** Move `limit(ROW_CAP + 1)` onto the SELECT, truncate on the merged row count, not on `merchants.length`.

---

### A2-504 — Useless `where` clause in merchants-catalog-csv (Low)

**Files:** `apps/backend/src/admin/merchants-catalog-csv.ts:87-89`.

**Evidence:**

```
.where(
  eq(merchantCashbackConfigs.merchantId, merchantCashbackConfigs.merchantId),
)
```

Self-comparison of the column to itself. Postgres optimises this away, but the code is confused — it looks like a copy-paste of a template where a real predicate got lost. No functional impact, pure code rot.

**Remediation:** Remove the `.where(...)` call. If the intent was `IS NOT NULL` on `updatedBy`, state it.

---

### A2-505 — CSV admin endpoints not in openapi.ts (Medium)

**Files:**

- `apps/backend/src/admin/user-credits-csv.ts` → `/api/admin/user-credits.csv`
- `apps/backend/src/admin/user-credit-transactions-csv.ts` → `/api/admin/users/:userId/credit-transactions.csv`
- `apps/backend/src/admin/users-recycling-activity-csv.ts` → `/api/admin/users/recycling-activity.csv`

**Evidence:** grepped `registerPath` invocations in `apps/backend/src/openapi.ts`; none of the three paths are registered. CSV exports leak email/PII into finance spreadsheets; the generated spec should document this so downstream client generators emit the typed attachment contract (Content-Disposition, Cache-Control: private,no-store).

**Impact:** Generated clients (web / future mobile) may miss the Content-Disposition / no-store header contract. AGENTS.md §"Documentation update rules" violated: "An API endpoint (add/remove/modify) → `apps/backend/src/openapi.ts` registration".

**Remediation:** Register all three paths with Tier-3 CSV metadata per ADR 018.

---

### A2-506 — Non-CSV admin endpoints not in openapi.ts (Medium)

**Files / paths:**

- `cashback-monthly.ts` → `/api/admin/cashback-monthly`
- `merchants-flywheel-share.ts` → `/api/admin/merchants/flywheel-share`
- `orders.ts adminListOrdersHandler` → `/api/admin/orders`
- `payment-method-activity.ts` → `/api/admin/orders/payment-method-activity`
- `user-cashback-by-merchant.ts` → `/api/admin/users/:userId/cashback-by-merchant`
- `user-cashback-summary.ts` → `/api/admin/users/:userId/cashback-summary`
- plus the CSV siblings at A2-505 and `merchant-stats-csv.ts`.

**Evidence:** See §8 diff. 9 distinct JSON paths are served in `app.ts` but absent from `openapi.ts`. These are not trivial — `GET /api/admin/orders` in particular is the base list view for the admin orders page.

**Impact:** Generated-client drift. Schemas in `packages/shared` for these responses exist only in the handler's `export interface` — not consumable by the web app via the generated-SDK path. AGENTS.md documentation-update rule breached.

**Remediation:** Register all 9 paths with their status-code inventory and schemas.

---

### A2-507 — Four admin handlers lack explicit try/catch (Low)

**Files:** `handler.ts` (listConfigsHandler, configHistoryHandler), `merchant-flows.ts`, `user-search.ts`, `reconciliation.ts`.

**Evidence:** grep for `try {` returned zero matches in each of these handlers. Exceptions propagate to the global `onError` in `app.ts:1529` which produces a generic 500 `INTERNAL_ERROR`. Every other admin handler catches explicitly and logs with handler-scoped context (`log.error({ err, userId }, 'Admin X lookup failed')`).

**Impact:** On-call dashboards filter Pino logs by `{handler: 'admin-X'}` child-logger keys. An uncaught throw in these four handlers logs from the global error hook instead, losing the handler-scoped bindings. Diagnosis takes longer. No client-facing leak.

**Remediation:** Wrap each DB call chain in try/catch, log with the child logger, return `{ code: 'INTERNAL_ERROR', message: 'Failed to X' }` at 500 — match the pattern used elsewhere.

---

### A2-508 — Thirteen admin handler files have no matching **tests** file (Medium)

**Files:** user-credits.ts, user-credit-transactions.ts, user-credit-transactions-csv.ts, user-cashback-by-merchant.ts, user-cashback-summary.ts, user-flywheel-stats.ts, user-payment-method-share.ts, user-cashback-monthly.ts, user-detail.ts, user-by-email.ts, users-list.ts, user-credits-csv.ts, user-search.ts.

**Evidence:** `comm -23` of `admin/*.ts` basenames against `admin/__tests__/*.test.ts` basenames shows these 13 files have no paired test file. Several are the ADR-017/018 surfaces that display PII (email) or support-sensitive data. Most of the matrix shows a `(no file)` note.

**Impact:** The per-handler regression baseline for these user-drill handlers is zero. Changes to shape or SQL go out without a test ever having asserted them. Given the admin panel is the primary way ops inspects a user's financial state pre-launch, this is higher-risk than pure coverage.

**Remediation:** Add per-handler tests covering: (1) happy path, (2) 404 on unknown userId, (3) 400 on malformed userId, (4) at least one PII-redaction or bigint-as-string assertion on the wire shape.

---

### A2-509 — `POST /api/admin/merchants/resync` lacks Idempotency-Key (Low)

**Files:** `apps/backend/src/admin/merchants-resync.ts:37-57`, `apps/backend/src/app.ts:1505`.

**Evidence:** POST with no body, no reason, no idempotency. The downstream `forceRefreshMerchants` has a mutex that coalesces concurrent calls, so the double-click case doesn't double-load CTX in-process. But nothing stops two admins at the same moment from both thinking they triggered the resync — the one that loses the mutex race gets `triggered: false` with the same `loadedAt`, which is informative but not audit-trail-bearing.

**Impact:** Low. No audit trail of "Alice resynced at T0, Bob tried at T0+2s and coalesced". Non-actionable today; becomes relevant if Phase 2+ adds a paid-CTX-tier where force-resync has a cost dimension.

**Remediation:** Either (a) accept that resync is idempotent by construction and document it in ADR 017 as an explicit exception, or (b) add Idempotency-Key + reason + audit envelope for consistency with other admin writes.

---

### A2-510 — `user-credits-csv` truncation sentinel row shape diverges (Low)

**Files:** `apps/backend/src/admin/user-credits-csv.ts:75`.

**Evidence:** Every other CSV handler emits `lines.push(csvRow(['__TRUNCATED__']))` — a one-cell row followed by `(HEADERS.length - 1)` empty commas. This handler does `lines.push('__TRUNCATED__')` — a single token with no trailing commas.

**Impact:** Spreadsheet parsers that expect a constant column count over all rows will flag the sentinel row as malformed. Consumers that only grep for `__TRUNCATED__` are unaffected.

**Remediation:** Call `csvRow(['__TRUNCATED__'])` for consistency.

---

### A2-511 — `notifyAdminAudit` posts actor email in full to Discord (Low)

**Files:** `apps/backend/src/discord.ts:407` (in `apps/backend/src/admin/` scope via the two callers that inject `actorEmail`).

**Evidence:** Embed field `Actor` renders as `` `${actorTail}` ${actorEmail} `` — full email. `actorUserId` is truncated to last 8 chars (the ADR-018 convention), but the email is passed through unredacted. Discord channel members are Loop staff, so this is acceptable by intent — but the ADR-018 convention "tail only" is inconsistent.

**Impact:** If the admin-audit webhook URL is ever leaked or re-purposed, the full admin email addresses in recent history are exposed. A mitigation would be redacting to `a****@example.com`.

**Remediation:** Optional — either redact the email to `<first-2>****@domain` in the Discord embed and keep the full email in the DB-side snapshot, or document in ADR 018 that the admin-audit channel is an authenticated-staff-only surface and full email is intended.

---

### A2-512 — UUID regex duplicated in ~10 admin handlers (Low)

**Files:** credit-adjustments.ts, orders.ts, payouts.ts, stuck-orders.ts (implicit via schema), user-by-email.ts (none, exact-match path), user-cashback-by-merchant.ts, user-cashback-monthly.ts, user-cashback-summary.ts, user-credits.ts, user-credit-transactions.ts, user-credit-transactions-csv.ts, user-detail.ts, user-flywheel-stats.ts, user-operator-mix.ts, user-payment-method-share.ts.

**Evidence:** Each file defines `const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;` as a local const. Drift-prone.

**Impact:** If a future change needs to accept UUIDv7 strictness differently, every handler has to be updated in lockstep. Low.

**Remediation:** Hoist to `apps/backend/src/admin/uuid.ts` or to `packages/shared` as `UUID_PATTERN` + `isUuid(s)` helper. Replace all call sites.

---

### A2-513 — merchantId shape not validated on several merchant-scoped endpoints (Low)

**Files:** merchant-cashback-summary.ts, merchant-flywheel-stats.ts, merchant-flywheel-activity.ts, merchant-flywheel-activity-csv.ts, merchant-cashback-monthly.ts, merchant-payment-method-share.ts, merchant-operator-mix.ts.

**Evidence:** Each reads `c.req.param('merchantId')` and passes it directly to an `eq(orders.merchantId, merchantId)` or parameterised `sql` template. No length-cap, no charset check. Compare with `orders.ts` list handler (line 162-170) and `merchant-top-earners.ts` (line 97) which do enforce `/^[A-Za-z0-9._-]+$/` with a 128-char cap.

**Impact:** pg parameterisation prevents SQL injection, but a 16 MB merchantId would happily round-trip through Hono (no body, 1 MB path-param cap from Node defaults) and issue a query. Cache-miss amplification on a single client. Near-zero exploit value today.

**Remediation:** Hoist the `/^[A-Za-z0-9._-]+$/` + length-128 pair to a shared helper and apply to every handler that reads `:merchantId` from the path.

---

## 10. Admin path coverage

Enumerated in §2. Every admin path in `app.ts` is covered by exactly one source file in `admin/`. No stub handlers, no dead code.

---

## 11. Blocked / out of scope notes

- Actual Sentry behaviour of the global `onError` not verified at runtime; relied on source reading only.
- `requireAdmin` itself is in `apps/backend/src/auth/` — scope of another phase; noted here only for the `c.get('user')` contract it provides.
- Did not re-run the full admin test suite; test files inspected for shape only.

Counts — 14 findings total (A2-500 through A2-513): 0 Critical, 1 High, 5 Medium, 8 Low.
