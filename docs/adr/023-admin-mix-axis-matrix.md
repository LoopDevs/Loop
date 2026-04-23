# ADR-023: Admin mix-axis matrix for attribution endpoints

- **Status**: Accepted
- **Date**: 2026-04-23
- **Deciders**: Engineering
- **Supersedes**: —
- **Superseded by**: —

## Context

Three concrete endpoints shipped in sequence during the CTX-supplier
pivot (#689 → #694 → #697) realised they were all instances of the
same pattern — a **mix-axis matrix** asking _"how do entity-A rows
fan out across entity-B?"_:

| Endpoint                                            | Answers                                   |
| --------------------------------------------------- | ----------------------------------------- |
| `GET /api/admin/merchants/:merchantId/operator-mix` | Which operators carry THIS merchant?      |
| `GET /api/admin/operators/:operatorId/merchant-mix` | Which merchants does THIS operator carry? |
| `GET /api/admin/users/:userId/operator-mix`         | Which operators carry THIS user?          |

All three aggregate `orders` by (scope-field, target-field) and
return the target-field rows. They differ only in `WHERE scope-field
= :id` and the tuple of count columns. Rather than treating them as
three bespoke endpoints, we name the pattern so the fourth axis
(e.g., `asset × operator`, `user × merchant`) ships in one slice
with a known contract.

This is distinct from ADR-022 (drill-triplet pattern). ADR-022 covers
**vertical expansion** of a single metric across fleet / per-merchant
/ per-user / self viewports. This ADR covers **horizontal
intersection** between two entity axes (e.g., merchant × operator).
A fully-covered metric has both — ADR-022 says _"ship all four
viewports"_, this ADR says _"if the metric crosses two entities,
ship both intersection directions"_.

## Decision

For any new admin attribution endpoint that aggregates orders (or a
ledger table) by a second entity, default to:

### URL shape

```
GET /api/admin/<scope-entity-plural>/:<scopeId>/<target-entity>-mix
```

Examples:

- `/api/admin/merchants/:merchantId/operator-mix`
- `/api/admin/operators/:operatorId/merchant-mix`
- `/api/admin/users/:userId/operator-mix`

The scope-entity is the path param; the target-entity is in the
URL suffix. The grammar always reads as _"the {target}s that fan out
from this {scope}"_.

### Request shape

- `path`: `{scopeId}` — the entity the aggregation is scoped to
- `query`: `?since=<iso-8601>` — lower bound on `createdAt`
  - Default: 24h ago
  - Cap: 366 days (matches ADR-013 operator-stats window for
    directly comparable numbers)

Scope-id validation must be tight:

| Scope        | Validator                                        |
| ------------ | ------------------------------------------------ |
| `merchantId` | `/^[A-Za-z0-9._-]+$/`, ≤128 chars (catalog slug) |
| `operatorId` | `/^[A-Za-z0-9._-]+$/`, ≤128 chars (alnum slug)   |
| `userId`     | UUID regex (users are UUID-primary-keyed)        |

### Response shape

```json
{
  "<scopeEntity>Id": "<scopeId>",
  "since": "<iso-8601>",
  "rows": [
    {
      "<targetEntity>Id": "...",
      "orderCount": 42,
      "fulfilledCount": 40,
      "failedCount": 2,
      "lastOrderAt": "<iso-8601>"
    }
  ]
}
```

Rows are sorted `orderCount DESC, <targetEntity>Id ASC` (stable
tie-break). bigint-backed count columns must go through
`db.execute<T extends Record<string, unknown>>` — the strictness
requirement has bitten three PRs in sequence.

### Status codes

| Code      | Meaning                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------- |
| 200       | Success, including zero-mix (`rows: []`) — "scope exists but has no attribution yet" is valid, **not** 404 |
| 400       | Malformed scope-id or `?since` (bad regex / not ISO-8601 / > 366 days ago)                                 |
| 401 / 403 | Standard `requireAdmin` responses                                                                          |
| 429       | 120/min per IP (mix endpoints are drill pages, not dashboards)                                             |
| 500       | Aggregate failure                                                                                          |

### Attribution filter invariant

Mix endpoints aggregate only rows where the target-entity column is
**non-null**. For operator-mix variants, that means
`isNotNull(orders.ctxOperatorId)` — pre-procurement orders have no
operator attribution and would pollute the list with a `null` group.
The same rule applies to any future axis: if the target column can
be null, filter it out at the aggregate level.

### UI pairing

Each mix endpoint gets a card on the corresponding drill page:

| Endpoint                      | Card                      | Drill page             |
| ----------------------------- | ------------------------- | ---------------------- |
| `/merchants/:id/operator-mix` | `MerchantOperatorMixCard` | `/admin/merchants/:id` |
| `/operators/:id/merchant-mix` | `OperatorMerchantMixCard` | `/admin/operators/:id` |
| `/users/:id/operator-mix`     | `UserOperatorMixCard`     | `/admin/users/:id`     |

Cards follow the same table layout: `Target | Orders | Fulfilled |
Failed | Success | Last order`. The `Target` cell links into the
per-entity detail page; the `Failed` cell (when > 0) links into
`/admin/orders?state=failed&<scopeField>=...&<targetField>=...` for
direct triage.

## Consequences

**Positive**:

- Fourth-axis additions get a checklist: slug validation, window
  contract, sort order, 200-empty vs 404 rules, UI card shape, failed
  triage deep-link.
- `AggRow extends Record<string, unknown>` lesson is captured in the
  ADR so it doesn't recur in CI for the fifth time.
- OpenAPI registration has a template to follow.

**Negative**:

- The pattern locks us into fairly generic row shapes. Metrics that
  legitimately need different columns (e.g., settlement latency
  percentiles per merchant × operator) don't fit without extending
  the schema or breaking the convention.

**Explicitly out of scope**:

- Metrics that don't aggregate orders (e.g., user × merchant
  cashback-earned, which reads the ledger rather than orders).
  Those can follow the pattern if useful but aren't obligated to.
- Non-admin axes (e.g., a public `/cashback/merchants/:slug/summary`
  already exists and doesn't fit this shape — it's a different
  surface with different auth + never-500 rules per ADR-020).

## How to add a fourth axis

Example: "which assets does this operator route cashback for?"
(`asset × operator` intersection):

1. `GET /api/admin/operators/:operatorId/asset-mix` — operator-scoped
   per-asset aggregate of `pending_payouts` grouped by `asset_code`.
2. Response rows: `{ assetCode, payoutCount, stroopsTotal, lastPayoutAt }`.
   Same sort (`orderCount DESC, assetCode ASC`).
3. Validation: operatorId slug regex, `?since` 366d cap.
4. 200 with `rows: []` for zero-payout operators.
5. UI card on `/admin/operators/:id` next to the other mix cards.
6. Tests: 400 paths, 200 empty, row mapping, `{ rows }` envelope, 500.
7. OpenAPI: register schemas + path + every status code (ADR-018
   rule).

A single PR covering all of the above is the unit of work.
