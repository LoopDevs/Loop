# ADR 019 — Admin panel three-tier data model

**Status:** Accepted
**Date:** 2026-04-22
**Depends on:** ADR 009 (credit ledger), ADR 011 (admin cashback config), ADR 015 (stablecoin topology), ADR 017 (admin credit primitives), ADR 018 (Discord operational visibility)

## Context

By 2026-04-22 the admin surface has grown to ~20 endpoints across orders, payouts, merchants, users, treasury, and reconciliation. Endpoints shipped ad-hoc in response to specific ops needs — no named pattern — and the shape drift was starting to show:

- three endpoints returned "counts by state" with three different JSON envelopes
- two returned "CSV of rows filtered by state" with different column orders
- one pair of lookups returned `{ order: ... }` vs `{ orders: [...] }` with the same underlying row type

The recent PRs (#423 admin orders summary, #425 stuck-orders, #426 payouts summary, #428 merchant-stats, #429 top-users) converged on a common structure without it being written down. This ADR names the pattern so new admin endpoints land in the right shape by default, and callers (mostly the admin UI) can rely on envelope consistency.

## Decision

Every admin data surface falls into exactly one of three tiers. The tier determines the envelope, pagination, caching, and rate-limit posture.

### Tier 1 — Snapshot

A single aggregated view, meant for the "chip strip" or "card" at the top of an admin page. Single DB round-trip, no pagination, no filters beyond what's implicit in the entity.

**Shape:** domain-specific object with nested count/total records keyed by a natural dimension (state, currency, chargeCurrency). Zero-filled across every known enum value so the UI renders a stable layout even on a cold table.

**Conventions:**

- One handler, one GROUP BY. No follow-up queries. If a snapshot needs data from two tables, it's a JOIN, not a pair of awaits.
- Bigint columns wire as strings (bigint-safe). Timestamps as ISO-8601 or null.
- No query parameters unless they scope the snapshot itself (e.g. `?minutes=30` on stuck-orders).
- Rate limit: 60/min. Snapshots are polled by the dashboard and should be cheap.
- No `Cache-Control` — snapshots are authoritative "now" data, caching belongs at the TanStack Query layer on the client.
- Response envelope: the snapshot object directly, _not_ wrapped in `{ snapshot: ... }`.

**Examples:**

| Endpoint                                     | Domain                                                               |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `GET /api/admin/treasury`                    | LoopAsset balance + cashback exposure                                |
| `GET /api/admin/orders/summary`              | Per-state counts + per-currency fulfilled totals                     |
| `GET /api/admin/orders/stuck`                | Orders paid-but-not-procured past threshold                          |
| `GET /api/admin/payouts/summary`             | Per-state counts + oldest-queued timestamps                          |
| `GET /api/admin/merchants/:merchantId/stats` | Per-currency fulfilled aggregates for one merchant                   |
| `GET /api/admin/users/top-by-cashback`       | Ranked user leaderboard                                              |
| `GET /api/admin/reconciliation`              | Drift between `orders.user_cashback_minor` and `credit_transactions` |

### Tier 2 — Drill

Paginated row-level list, meant for the main scrollable area of an admin page. Each row is a full-shaped view — enough to answer follow-up questions without a second fetch. Reached from a snapshot by clicking into a count, or from a detail endpoint.

**Shape:** `{ <entity>s: Row[] }` (plural). Row shapes are exported TypeScript interfaces (`AdminOrderView`, `AdminPayoutView`, …) so the client and tests share one declaration.

**Conventions:**

- Filters via query string: `?state=`, `?userId=`, `?merchantId=`, `?before=<iso>`.
- Cursor pagination via `?before=<iso>` + `?limit=<N>` (never offset). Default limit 20, cap 100. List endpoints never total-count — ops doesn't need "page 47 of 200", they need "newer / older / narrow it down".
- 400 on bad filters (bad UUID, unknown state, bad timestamp) — the client should render an inline error, not a stale list.
- 500 on db errors — distinguishable from 404 because 404 is for _missing entity on single-row lookup_, not for "filter matched nothing" (empty array is the correct empty answer).
- Rate limit: 60/min. 120/min acceptable for high-traffic ops surfaces (stuck-orders triage, single-order detail).
- Detail endpoints (`GET /:id`) are part of this tier and use the wrapped envelope `{ <entity>: Row }`. 404 when the id matches nothing. 400 on malformed id.
- No `Cache-Control` — same as Tier 1.

**Examples:**

| Endpoint                                                       | Domain                                  |
| -------------------------------------------------------------- | --------------------------------------- |
| `GET /api/admin/orders`                                        | Filtered orders list                    |
| `GET /api/admin/orders/:orderId`                               | Single order detail                     |
| `GET /api/admin/payouts`                                       | Filtered payouts list                   |
| `GET /api/admin/users/search`                                  | Substring search over users             |
| `GET /api/admin/users/:userId`                                 | Single user detail (balance + counters) |
| `GET /api/admin/users/:userId/credit-history`                  | Per-user ledger tail                    |
| `GET /api/admin/merchant-cashback-configs`                     | All configs                             |
| `GET /api/admin/merchant-cashback-configs/:merchantId/history` | Config audit log                        |

### Tier 3 — Export

Bulk CSV dump for offline analysis. Never paginated — admins want "everything that matches" in one file. Hard-capped at 10k rows with a warning log when the cap is hit.

**Shape:** `text/csv`, RFC 4180 escape rules on every field, `Content-Disposition: attachment; filename="loop-<entity>-<filter>.csv"`.

**Conventions:**

- Same filter query string as the matching Tier 2 list (so admins can refine in Tier 2, then export the same slice).
- `Cache-Control: private, no-store` — exports can contain user-identifying data; never cache at the edge.
- Rate limit: 20/min. Lower than Tier 2 because exports are expensive.
- Column order: stable, documented in the handler, matches the order the Tier 2 row shape declares its fields. Adding a column is backwards-compatible; renaming or reordering is a breaking change.
- Row cap 10k. When reached, append a final row containing only the marker `__TRUNCATED__` and emit a `log.warn` — UI should surface "showing first 10k rows" above the download link.

**Examples:**

| Endpoint                                 | Domain                                         |
| ---------------------------------------- | ---------------------------------------------- |
| `GET /api/admin/orders.csv`              | Filterable orders dump                         |
| `GET /api/users/me/cashback-history.csv` | Personal ledger export (user-scoped — ADR 017) |

## Consequences

### Positive

- **New admin endpoints land correctly by default.** A contributor adding "stats for merchant enable/disable events" knows it's a Tier 1 snapshot, knows the envelope, knows the rate limit — without asking.
- **Admin UI caching is predictable.** TanStack Query keys follow the tier: `['admin', 'snapshot', 'orders']`, `['admin', 'list', 'orders', filters]`, `['admin', 'export', 'orders', filters]`. Invalidation after admin writes (refund, adjustment, config update) invalidates only the relevant tier's keys.
- **OpenAPI stays consistent.** Generated clients get predictably-shaped responses per tier — no surprise `{ order }` vs `order` envelopes.
- **Tests share helpers.** The drizzle-execute mock pattern in `orders/__tests__/orders.test.ts` and `admin/__tests__/payouts.test.ts` is identical because both handlers are Tier 1 snapshots.

### Negative / open issues

- **Legacy drift.** A few endpoints predate this ADR and partially break tier rules. Specifically:
  - `GET /api/admin/treasury` (Tier 1) embeds per-operator pool telemetry that would normally live in a Tier 2 detail endpoint. Left as-is — the coupling is cheap (in-memory) and splitting it would cost a round-trip.
  - `GET /api/admin/merchant-cashback-configs` (Tier 2) returns _everything_ without pagination. Fine while the merchant catalog is small (<1k); revisit if we ever cross that.
- **No Tier 4 for mutations.** Admin POST/PUT/DELETE endpoints (refund, adjustment, payout retry, config upsert, merchants resync) aren't covered here because they're not data-model endpoints — they're actions. Their conventions live in ADR 017 (credit primitives) and ADR 018 (Discord signals).
- **Merchant-scoped lookups are dual-tiered.** `/api/admin/merchants/:merchantId/stats` is Tier 1 (aggregated), but a future `/api/admin/merchants/:merchantId/orders` would be Tier 2 (paginated list). Naming is the URL prefix pattern `/merchants/:id/<resource>` — the tier is determined by whether `<resource>` pluralizes (drill) or is a domain-specific aggregate (snapshot).

## Non-goals

- **Not a TanStack Query cache-invalidation spec.** The client is free to structure its keys however it likes; the backend contract is the tier, not the cache key.
- **Not a UI framework.** The admin web app (`apps/web/app/routes/admin.*.tsx`) renders these tiers on its own schedule. Some admin pages render two snapshots + one drill on the same route (e.g. `/admin/payouts` combines `/payouts/summary` + `/payouts` list).
- **Not a permission model.** Every admin endpoint is gated by `requireAdmin` middleware; tiering doesn't refine that.

## Rollout

- This ADR is descriptive: it names the pattern that has already emerged, it does not propose migrating legacy endpoints. New admin endpoints must follow it; existing ones stay as they are.
- Reviewers should cite this ADR when a new admin endpoint deviates from the tier conventions — "this looks like a Tier 1 but has pagination; pick a tier".
- If a future endpoint doesn't fit any tier, that is a signal to either fold it into an existing tier (the usual outcome) or extend this ADR with a new tier (a real decision, not a drive-by addition).
