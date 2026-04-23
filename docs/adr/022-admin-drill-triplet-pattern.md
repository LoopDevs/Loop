# ADR-022: Admin drill-triplet pattern for cashback metrics

- **Status**: Accepted
- **Date**: 2026-04-23
- **Deciders**: Engineering
- **Supersedes**: —
- **Superseded by**: —

## Context

During the cashback-flywheel pivot work (PRs #620–#656), multiple
admin endpoints and UI surfaces got built to answer the same kind of
question — "where does cashback flow?" — along different axes:

- Fleet-wide: "how much cashback does Loop mint per month?"
- Per-merchant: "how much does Amazon drive?"
- Per-user: "how much does Alice earn?"
- User-facing self-view: "how much do I earn?"

Every time a new metric shipped (flywheel share, rail mix, monthly
cashback, cashback-summary), the natural expansion was to ship the
same metric on every available axis. When only one axis got built,
ops came back asking for the others — sometimes across multiple PRs
as three separate asks.

A recognisable pattern has emerged that we should name so future
additions don't rediscover it by reviewer asks.

## Decision

For any new admin cashback / flywheel / ledger metric, default to
shipping **all four viewports in the same slice**, or at minimum
acknowledge in the PR which viewports are deliberately deferred:

1. **Fleet-wide** — `GET /api/admin/<metric>`
2. **Per-merchant** — `GET /api/admin/merchants/:merchantId/<metric>`
3. **Per-user (admin)** — `GET /api/admin/users/:userId/<metric>`
4. **User-facing self-view** — `GET /api/users/me/<metric>`

Where the UI pairs:

- Fleet card on `/admin/treasury` or `/admin/cashback`
- Per-merchant card on `/admin/merchants/:merchantId`
- Per-user card on `/admin/users/:userId`
- User self-view card on `/settings/cashback` or `/orders`

Shape parity across the four: same response field names, same
`bigint-as-string` conventions, same `?state=fulfilled` defaults
where applicable. A frontend helper (percentage formatter, currency
renderer) should be shared across all four UI callers rather than
duplicated — see `PaymentMethodShareCard.fmtPct` + `fmtPctBigint`,
reused by `MerchantRailMixCard`, `UserRailMixCard`, `RailMixCard` on
the user self-view.

## Shape conventions

- **Zero-volume targets return 200** with zero values, not 404.
  A merchant with no orders yet or a user with no fulfilled cashback
  is a valid row, just an empty one. 404 is reserved for "this
  id doesn't exist".
- **`bigint-as-string`** on every money field wider than
  `Number.MAX_SAFE_INTEGER` (`chargeMinor`, `cashbackMinor`,
  `paidStroops`).
- **Sorted, stable tie-break** for ranked responses — e.g.
  `ORDER BY cashback_minor DESC, email ASC` on `top-earners` so the
  list doesn't reshuffle on refresh.
- **User-facing self-view is home-currency locked** — the user's
  `home_currency` scopes both numerator and denominator so the
  displayed ratio has a coherent denomination.
- **Admin cross-currency views are multi-row** — per-merchant
  `cashback-summary` returns one row per currency because
  per-merchant volume spans user home currencies.

## Rate-limit + rate-CSV conventions

- Per-user / per-merchant JSON endpoints: **120 requests / minute**
  (admin UI polls, but rarely; generous for debugging).
- Per-user / per-merchant CSVs: **10 requests / minute** (Tier-3,
  ADR 018).
- Fleet JSON endpoints: **60 requests / minute**.
- Fleet CSVs: **10 requests / minute**.

## Trade-offs

**Why four instead of three.** The user-facing self-view is strictly
not an admin surface, but shipping it alongside the per-user admin
version keeps the shape identical and eliminates a duplication later
("admin got `paidStroops`, user-side returns `paid_stroops` —
which is right?"). One endpoint pair, one migration to keep in
sync.

**Why zero-volume doesn't 404.** Silent-hiding empty rows breaks
the admin UI's ability to distinguish "nothing yet" from "component
crashed". User-facing surfaces self-hide; admin surfaces render a
neutral "no data yet" line. `UserFlywheelChip` (user-facing) hides
on zero-recycled; `AdminUserFlywheelChip` (admin) renders "no
recycled orders yet" — same data, different presentation rule.

**Why not generate all four from one schema.** Considered a
codegen step that emits fleet + per-merchant + per-user + self
from a single declaration. Rejected: the handlers diverge on enough
points (auth gate, join shape, home-currency scoping, pagination
defaults) that the generator would accumulate special cases faster
than handwritten code saves boilerplate. Prefer hand-rolled
handlers that share patterns by convention.

## Consequences

- New cashback / flywheel / ledger metrics should bring a checklist:
  "have I shipped fleet / per-merchant / per-user / self?" If only
  one or two viewports are in the slice, the PR description must
  call out which follow-ups land the rest and link their PRs.
- Frontend percentage / currency helpers live in the surface that
  ships first and get re-exported from there (not duplicated).
  `@loop/shared` hosts them only when a third consumer emerges
  (ADR 019 three-part rule).
- CSV siblings (`/endpoint.csv`) are an opt-in addition — not every
  metric needs a Tier-3 CSV, but when finance or BD needs one, the
  body shape should match the JSON 1:1 with flat columns and empty
  strings for null.

## Status of this pattern at time of writing

Shipped quartets (fleet / per-merchant / per-user-admin / self):

- `payment-method-share` (#585 / #627 / #629 / #643)
- `flywheel-stats` (/ scalar) (#609 user-self / #623 merchant / ad
  hoc for fleet via `/cashback-stats`)

Shipped triplets (fleet / per-merchant / per-user-admin, no self):

- `cashback-monthly` (#592 / #635 / #633)
- `cashback-activity` + `payouts-activity` (fleet only so far — no
  per-user/per-merchant variants because they'd duplicate
  `cashback-monthly` at finer resolution)

Shipped per-axis singletons (documented here as likely candidates
for future expansion):

- `merchant-top-earners` (#655) — per-merchant only; a user-axis
  counterpart ("which merchants does this user earn most at?") is
  served by `user-cashback-by-merchant` already, so the triplet
  is complete via a near-sibling rather than a same-named endpoint.
- `flywheel-activity` (#641) — per-merchant only; a per-user
  counterpart is useful for support drills and should follow this
  pattern when shipped.
