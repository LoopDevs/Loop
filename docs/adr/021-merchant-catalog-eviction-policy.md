# ADR 021: Merchant-catalog eviction policy

Status: Accepted
Date: 2026-04-22
Related: ADR 009 (credits ledger), ADR 011 (admin panel / cashback config), ADR 013 (CTX operator pool), ADR 018 (admin panel architecture), ADR 020 (public API surface)

## Context

The in-memory merchant catalog (built by `refreshMerchants()` in
`apps/backend/src/merchants/sync.ts`) is the authoritative view of
"which merchants can Loop transact with right now". It's refreshed
every 6h from the upstream CTX `/merchants` endpoint, and an admin
can force a resync on-demand (ADR 011 manual-resync endpoint).

Postgres holds long-lived `merchant_id` foreign-keys in three places:

- `orders.merchant_id` — pinned at order creation.
- `credit_transactions.reference_id` (when `reference_type = 'order'`
  indirectly via the order row) — the ledger trail.
- `merchant_cashback_configs.merchant_id` — the admin's commercial
  terms (ADR 011).

When upstream CTX evicts a merchant — retires a brand, flags one
disabled, or just has a transient sync failure — the in-memory
catalog shrinks while the Postgres rows persist. Two things can
happen:

- A lookup (admin drill-down, landing-page tile, per-user stats
  aggregate) happens AGAINST the Postgres-side id and needs to render
  a name. The catalog can't answer.
- A write (new order, config upsert, state transition) happens and
  needs to decide whether to honour a reference the catalog no longer
  knows about.

During the cashback-app pivot, ~15 endpoints each made a small local
decision about how to handle this. Three distinct behaviours
emerged. This ADR names them so the next contributor cites "Rule A /
B / C" on review instead of re-deriving the stance per slice.

## Decision

### The three read rules

| Rule              | Audience                                             | Behaviour                                    |
| ----------------- | ---------------------------------------------------- | -------------------------------------------- |
| **A** — fall back | Admin surfaces (`/api/admin/*`)                      | Use `merchantId` as the display name.        |
| **B** — drop      | Public surfaces (`/api/public/*`)                    | Drop the row entirely from the response.     |
| **C** — pin       | Historical records (`orders`, `credit_transactions`) | Keep `merchant_id` forever; never overwrite. |

### Why each is defensible

**Rule A (admin fall-back).** Support can still act on a raw
`merchant_id` — cross-reference with CTX, delete the config row,
audit a historical order. Hiding the row would be worse: the admin
couldn't triage the ghost. The page header is enough to disambiguate
(the admin knows they're in the merchant-config surface), so
rendering the id as the name is honest and actionable.

**Rule B (public drop).** Public visitors can't act on a merchant
id. Showing "m-f3a7b: 18% cashback" on the landing page degrades
trust more than one fewer tile — the row was never going to convert
anyway, since the user couldn't buy a gift card for an unknown
merchant. Dropping aligns with ADR 020's "never show a broken
marketing surface" discipline.

**Rule C (historical pin).** The reconciliation contract in ADR 009
assumes `orders.merchant_id` is stable forever — an audit replay must
be able to reproduce the historical state regardless of whether
upstream CTX still acknowledges the merchant. Rewriting to null or
a different id would destroy history. Orders + credit_transactions
rows therefore carry the merchant_id at the time of the write, and
later evictions are silently absorbed.

### Write-side companion rules

- **Order creation rejects** with 404 when the target merchant is
  absent from the catalog at the time of the POST. No "ghost orders"
  get written with an id Loop can't fulfill.
- **Cashback-config upsert is allowed** even when the merchant is
  absent. Admins pre-configure new merchants before they land in the
  catalog sweep, and post-configure historical merchants for
  back-dated margin adjustments. The config row is just a pct triple
  keyed on the id — it doesn't depend on a catalog entry to be
  meaningful.
- **Order state transitions are unaffected.** The merchant_id pinned
  at row creation stays stable through `pending_payment → paid →
procuring → fulfilled`. Eviction between creation and fulfillment
  doesn't block progression (the gift card is already procured from
  CTX; we're just tracking its state).

### How to apply

On a new endpoint or card:

1. **Is the caller admin or public?** Admin → Rule A. Public → Rule B.
2. **Is the field a merchant display name or a pinned historical
   reference?** Display → Rule A or B (as above). Historical → Rule C
   (never touch the stored id).
3. **Is the operation a write?** Apply the companion rule that
   matches the write kind (order vs. config vs. state transition).

## Consequences

**Positive.**

- Clear precedent for the next merchant-touching endpoint. Reviewers
  cite "Rule A" or "Rule B" instead of re-litigating.
- Public surfaces stay resilient — a transient CTX sync gap doesn't
  brown out the landing page.
- History is stable. SAR / compliance exports can reproduce any
  state regardless of catalog drift.

**Negative.**

- **Two display paths.** Admin UI code handles the `merchant_id`-as-
  name case everywhere; tests for merchant-joining admin endpoints
  now include an "evicted merchant" case. The cost is real but low,
  and centralised in the `admin/*` handlers that already do other
  merchant joins.
- **Catalog-resync blind spot.** A merchant that was in the catalog
  at order creation time but gets evicted before the user looks at
  `/orders/:id` will see a bare id. Acceptable — the alternative
  (refusing to render the order) is worse UX.

## Open issues

- **Soft-eviction signal.** Upstream CTX doesn't send a "retired"
  notification; we only learn from the next sync. A flag or webhook
  would let us preserve a display name on the Postgres side at
  eviction time instead of fall-back rendering. Out of scope for
  Phase 1; revisit if CTX adds the signal.
- **Multi-region catalog divergence.** Currently one Fly region = one
  merchant catalog. If we scale horizontally, the three rules stay
  the same but the per-pod LKG of Rule B gains the same incoherence
  window ADR 020 already named.

## Related

- **ADR 009** — credits ledger — fixes Rule C as the historical
  contract.
- **ADR 011** — admin panel / cashback config — wrote the
  upsert-without-catalog-entry path that Rule-A/B depend on.
- **ADR 013** — CTX operator pool — the sync's upstream source.
- **ADR 018** — admin panel architecture — Rule A aligns with the
  admin read-tier's "fall back rather than refuse" discipline.
- **ADR 020** — public API surface — Rule B is the catalog-eviction
  specialisation of ADR 020 Rule 5.
