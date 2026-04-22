# ADR 021 — Merchant-catalog eviction policy

**Status:** Accepted
**Date:** 2026-04-22
**Depends on:** ADR 011 (admin cashback config), ADR 013 (CTX as supplier), ADR 015 (stablecoin topology), ADR 019 (admin data model), ADR 020 (public API surface)

## Context

The backend's in-memory merchant catalog (`merchants/sync.ts`) is refreshed every `REFRESH_INTERVAL_HOURS` (6h default) from upstream CTX. Each refresh replaces the full map — a merchant removed upstream between syncs disappears from the in-memory catalog silently.

Meanwhile Postgres holds durable references to merchant ids:

- `orders.merchant_id` — orders are historical records; face-value amounts, cashback splits, and ledger events are already pinned in the row. A user's £50 Amazon fulfilment stays £50 Amazon even if Amazon leaves the catalog.
- `merchant_cashback_configs.merchant_id` — the cashback split admin maintains. Admin may still want to edit these for historical auditing even after upstream removal.
- `merchant_cashback_config_history.merchant_id` — audit log of the above, never rewritten.
- `credit_transactions.reference_id` (when `reference_type='order'`) — points through `orders.merchantId` indirectly.

During the ~15 public/admin endpoints added in the cashback-app pivot we made small, local decisions about "what if the catalog doesn't have this merchant?" at each surface. Three distinct behaviours emerged. They're all defensible — but they need to be written down so new endpoints land correctly and so reviewers can cite a policy.

## Decision

Every surface that references the in-memory catalog when rendering `merchant_id`-bearing rows from the DB follows one of three rules. Which rule applies depends on the audience.

### Rule A — Admin surfaces: fall back to merchantId

Any `/api/admin/*` endpoint that renders a merchant row falls back to showing the bare `merchant_id` as the "name" when the catalog has evicted the row.

**Why.** Admin is working from a list — they can still act on the id (look it up in CTX support, cross-reference with logs, inspect the config, delete the config). A row that's invisible would be worse than a row with a raw id.

**Where.** `AdminOrderView` (admin/orders), admin user drill-downs, `/api/admin/merchants/:merchantId/stats`, `/admin/users/top-by-cashback`, cashback-configs CSV, config history feed, Discord audit notifiers.

### Rule B — Public / marketing surfaces: drop the row

Any `/api/public/*` endpoint that references the catalog drops rows whose merchant has been evicted, rather than surfacing the id.

**Why.** The public audience can't act on a bare id. Partial data is worse than none — a landing-page list item reading "m-f3a7b: 18% cashback" degrades trust more than having one fewer entry in the list.

**Where.** `GET /api/public/top-cashback-merchants` (dropped rows; overshoots DB fetch 4× to still fill `?limit=`). Same rule will apply to future public merchant-listing endpoints.

### Rule C — Historical records: pin the merchant_id forever

`orders`, `credit_transactions`, `merchant_cashback_config_history` — rows that capture a past event — never clear their `merchant_id` even if the catalog evicts the merchant. The user's ledger and the audit trail remain intact.

**Why.** These rows are the source of truth for what happened. An Amazon fulfilment in January is still an Amazon fulfilment in June, and the credit_transactions ledger depends on that being stable. Clearing or updating would destroy history and break reconciliation (ADR 009).

**Consequence.** Admin surfaces reading these rows apply Rule A to render the name; the underlying `merchant_id` is untouched.

## What to do on each kind of write

The rule above is for _reads_. For writes, three policies apply:

1. **Order creation** (`POST /api/orders`) — reject if the merchant is not in the in-memory catalog (404 Merchant not found). An order can only be placed against a merchant upstream currently serves. No fallback.
2. **Cashback-config upsert** (`PUT /api/admin/merchant-cashback-configs/:merchantId`) — **allowed** even when the merchant is absent from the catalog. Admin may be pre-configuring a merchant upstream hasn't synced yet, or editing a config for a historically-served merchant. The Discord notifier falls back to `merchantId` as the name in the audit embed per Rule A.
3. **Order state transitions** (procure, fulfill, fail, refund) — **unaffected** by catalog presence. The row's `merchant_id` is pinned at creation; procurement proceeds via the CTX order already created.

## Consequences

### Positive

- **Consistent reviewer expectation.** A PR that drops a catalog-evicted row on an admin surface now violates Rule A — easy to catch.
- **Ledger integrity.** Rule C protects the reconciliation contract (ADR 009 / 019) — no future code change can accidentally clear `merchant_id` from a historical row.
- **Marketing pages stay clean.** Rule B is why `/public/top-cashback-merchants` overshoots its fetch — the policy justifies the 4× cost.

### Negative / open issues

- **"Fallback to id" is audience-dependent, not just endpoint-dependent.** A future hybrid endpoint (say, a public merchant detail page that also shows admin controls for admins) needs to render differently per caller. No such endpoint exists today; if one's added, the handler switches on `isAdmin`.
- **Merchant rename** — this ADR doesn't cover the case where upstream CTX renames a merchant but keeps the id. The in-memory catalog will simply have the new name; historical orders render with the new name, which is usually correct but can be confusing in audit trails. If this becomes a real problem, we can snapshot `merchant_name` into `orders` at creation time — deferred until the need is concrete.
- **Catalog reload races.** Between two sync refreshes, a just-evicted merchant briefly appears as Rule A on admin + dropped on public. Inconsistent within a single page render if it straddles a refresh boundary. Acceptable — the window is ≤one request — and documented here so it's not mistaken for a bug.

## Non-goals

- **Not a data-retention policy.** How long we keep `orders` / `credit_transactions` after a merchant leaves the catalog is a separate compliance question and stays ADR 009's domain.
- **Not a merchant-directory re-architecture.** The in-memory catalog is the agreed design (ADR 013, README merchants/sync.ts). This ADR doesn't revisit that.
- **Not a CTX integration change.** We don't ask CTX to retain evicted merchants; that's their call.

## Rollout

- Descriptive: the three rules describe what the codebase already does. The existing endpoints cited above match the stated policy.
- New endpoints must pick a rule explicitly in the handler comment — "Catalog eviction: Rule A / B / C" — so reviewers can confirm it matches the audience.
- Deviations need a handler-level comment explaining why (e.g. a diagnostic endpoint that always wants the raw id regardless of audience).
