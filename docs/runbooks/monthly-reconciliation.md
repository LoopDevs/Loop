# Runbook · Monthly reconciliation (CTX invoice vs Loop ledger)

## When to run

First business day of each month, against the prior calendar month's
data. Runs against UTC month boundaries (`DATE_TRUNC('month', ...)`)
to match the SLO doc and the existing admin month-to-date views.

## Why it matters

Loop is now the merchant of record (ADR 010 / 015) — CTX bills us
wholesale for every gift card we resell. Reconciliation is the
monthly cross-check: **does CTX's invoice match what our `orders`
table says we ordered**?

If it doesn't, one of three things happened:

1. **Loop-side bug** — `orders` rows have wrong `wholesale_minor` /
   `currency` / `face_value_minor`, or the procurement worker
   skipped fulfilment for some rows
2. **CTX-side bug** — CTX is billing for orders that didn't actually
   procure, or the wholesale-rate they're applying differs from
   what we agreed
3. **Edge case** — a refund / chargeback on either side that one
   party hasn't propagated yet

Catching #1 / #2 fast keeps the relationship healthy. Catching #3
informs the support flow.

## Severity

Routine — schedule for the first business day, no on-call ping.
Treat a discrepancy outside ±0.5% as **P2** (open a ticket, work
through during the week). >2% is **P1** (same-day attention).

## Inputs

- The CTX invoice for the prior month (PDF or CSV; CTX emails it
  to the operator address on the 1st)
- Read-only Postgres access via `loop-readonly` role (per
  `docs/log-policy.md` access RBAC)

## Procedure

### 1. Pull the Loop-side numbers

```sql
-- Total wholesale Loop owes CTX, by catalog currency, for the
-- given month. `wholesale_minor` is denominated in the user's
-- home currency (ADR 015 §"Charge currency pin"); for invoice
-- comparison you also want the catalog-currency totals via the
-- `face_value_minor` x `wholesale_pct` recomputation, since CTX
-- bills in catalog currency.
SELECT
  currency AS catalog_currency,
  COUNT(*) AS order_count,
  -- Loop-side bookkeeping wholesale (user-home-currency, what we
  -- pinned at order creation):
  SUM(wholesale_minor) AS wholesale_minor_user_currency,
  -- Catalog-currency wholesale (what CTX actually bills):
  SUM((face_value_minor * wholesale_pct / 100)::bigint) AS wholesale_minor_catalog_currency
FROM orders
WHERE state = 'fulfilled'
  AND fulfilled_at >= DATE_TRUNC('month', NOW() AT TIME ZONE 'UTC') - INTERVAL '1 month'
  AND fulfilled_at <  DATE_TRUNC('month', NOW() AT TIME ZONE 'UTC')
GROUP BY currency
ORDER BY currency;
```

### 2. Pull the per-merchant breakdown

CTX's invoice is line-itemised by merchant — match the same
shape so a discrepancy points at one merchant rather than a
catalog-wide gap.

```sql
SELECT
  merchant_id,
  currency AS catalog_currency,
  COUNT(*) AS order_count,
  SUM(face_value_minor) AS face_value_minor_total,
  SUM((face_value_minor * wholesale_pct / 100)::bigint) AS wholesale_minor_catalog_total
FROM orders
WHERE state = 'fulfilled'
  AND fulfilled_at >= DATE_TRUNC('month', NOW() AT TIME ZONE 'UTC') - INTERVAL '1 month'
  AND fulfilled_at <  DATE_TRUNC('month', NOW() AT TIME ZONE 'UTC')
GROUP BY merchant_id, currency
ORDER BY currency, merchant_id;
```

### 3. Cross-check against CTX's invoice

For each `(merchant_id, catalog_currency)` row in the CTX invoice:

- **Order count matches** — same `n` of orders billed.
- **Face-value total matches** — sum of card denominations.
- **Wholesale total matches** — what CTX is charging us net.

Acceptable drift on each line: ±0.5% rounding, no more. Loop's
bigint flooring (`apps/backend/src/orders/repo.ts::applyPct`) errs
toward Loop, so if anything Loop's number should be slightly LOWER
than CTX's expectation. If Loop's number is HIGHER → procurement
billed for orders that don't exist on CTX's side → red flag.

### 4. Investigate any discrepancy

- **Loop has more orders than CTX**: orders that fulfilled on Loop
  but never landed on CTX. Likely cause: a procurement bug skipped
  the upstream POST, or a manual admin transition flipped state to
  `fulfilled` without procurement. Audit via:

  ```sql
  SELECT id, ctx_order_id, fulfilled_at FROM orders
  WHERE state='fulfilled' AND ctx_order_id IS NULL
    AND fulfilled_at >= DATE_TRUNC('month', NOW() - INTERVAL '1 month')
    AND fulfilled_at <  DATE_TRUNC('month', NOW());
  ```

  Any row here is a phantom — it shouldn't exist. Open a sev-2
  ticket and walk back through `procurement.ts` for that id.

- **CTX has more orders than Loop**: CTX is billing us for orders
  that don't have a matching `orders` row. Two sub-cases:
  - **Pre-Loop-of-record orders** (legacy CTX-direct customers
    using Loop's CTX account before the principal-switch landed) —
    these are pre-2026-04 and should not appear. If they do, the
    CTX-side cutover wasn't clean and you have an ops conversation
    to have.
  - **A `pending_payment` order that procured on CTX without
    advancing to `fulfilled`** — possible if the payment-watcher
    flipped state but the payment-receipt webhook never reached us.
    Check `orders.state='paid'` rows with non-null `ctx_order_id`
    that haven't transitioned.

- **Wholesale-rate disagreement**: CTX's per-merchant rate is the
  one in our agreement; if the invoice is higher, either CTX
  silently changed the rate (escalate) or our `wholesale_pct` row
  in `merchant_cashback_configs` is stale (a recent rate change on
  CTX's side hadn't propagated to admin config). Verify against the
  CTX merchant doc and reconcile.

### 5. Approve + pay

Once reconciled (or the discrepancy is documented + accepted):

- Post a summary to `#deployments` with the totals and "reconciled
  ✅" or "reconciled with $X discrepancy under investigation"
- Forward the invoice to ops for payment
- Tag the audit row in `#admin-audit` with the reconciliation
  number so post-month spot-checks (A2-1924) tie back to the
  closure record

## Resolution

The reconciliation pass is the routine close. Any P2/P1
discrepancies open a separate ticket and proceed independently.

## Post-mortem

- **For any P1 discrepancy** (>2%) — write up cause + remediation.
  Track patterns: if the same merchant disagrees twice, the rate
  agreement needs an explicit re-confirmation with CTX.
- **For repeat zero-discrepancy months** — celebrate but also
  consider tightening the alert threshold; reconciliation on a
  hair-trigger threshold catches drift earlier.

## Related

- ADR 010 — Loop as merchant of record
- ADR 015 §"Charge currency pin" — why catalog and home currencies
  diverge in the data model
- A2-1923 — tax/regulatory reporting (uses the same wholesale
  numbers; do reconciliation FIRST so tax export doesn't propagate
  any month's discrepancy)
- A2-1924 — deployed-state spot-check (a sub-procedure that
  confirms the production query results match the staging copy
  before invoice approval)
