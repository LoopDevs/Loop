# Runbook · Deployed-state spot-check

## Why this exists

Three flows depend on production query results being trustworthy:

1. **Monthly CTX reconciliation** ([`monthly-reconciliation.md`](./monthly-reconciliation.md)) —
   per-merchant wholesale totals against CTX's invoice
2. **Tax / regulatory reporting** (A2-1923) — quarterly cashback-paid
   and gift-card-volume exports filed with HMRC / IRS
3. **Admin month-to-date dashboards** — the `/admin` numbers
   stakeholders read each Monday

A bug in `merchant_cashback_configs`, a mid-month rate change with
incomplete propagation, or schema drift on a backfill can silently
corrupt the underlying query without throwing — the SQL still
returns numbers, just wrong ones. This runbook is the **before-
trusting-the-numbers** routine that catches that.

## When to run

- **Always before any of the three flows above.** No invoice
  approved, no tax figure filed, no Monday number celebrated
  without it.
- **After any migration that touches `orders` / `user_credits` /
  `credit_transactions` / `merchant_cashback_configs` / `pending_payouts`.**
- **When a stakeholder reports a number that doesn't match their
  expectation.** The spot-check either confirms the discrepancy
  is real or rules out a query bug.

## Procedure (15 minutes)

### 1. Schema drift check

```sql
-- Confirm migrations match the journal at the live commit. The
-- _journal.json carries the canonical list (entries 0000-NNNN).
-- Compare to:
SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 5;
```

If the latest migration row doesn't match `apps/backend/src/db/migrations/meta/_journal.json`'s
last entry → migrations didn't apply cleanly. **STOP.** No
invoice / report / dashboard is trustworthy. Re-deploy or
investigate.

### 2. Row-count sanity

```sql
SELECT
  (SELECT COUNT(*) FROM users)               AS users,
  (SELECT COUNT(*) FROM orders)              AS orders,
  (SELECT COUNT(*) FROM credit_transactions) AS tx,
  (SELECT COUNT(*) FROM user_credits)        AS balances,
  (SELECT COUNT(*) FROM pending_payouts)     AS payouts,
  (SELECT COUNT(*) FROM merchant_cashback_configs) AS configs;
```

Expectations (rough orders-of-magnitude — adjust as Loop scales):

| Table                       | Phase-1 floor      | Phase-1 ceiling                     |
| --------------------------- | ------------------ | ----------------------------------- |
| `users`                     | ≥ 1                | unbounded                           |
| `orders`                    | ≥ 0                | unbounded                           |
| `credit_transactions`       | ≥ orders × 1       | ≤ orders × 5 (cashback + spend + …) |
| `user_credits`              | ≤ users × 3        | (one per active home currency)      |
| `pending_payouts`           | ≤ orders           | (one per fulfilment, max)           |
| `merchant_cashback_configs` | = active merchants | matches admin catalog count         |

A wildly-wrong number (zero users, more `pending_payouts` than
`orders`, etc.) signals deeper corruption.

### 3. Ledger invariant

```bash
npm --workspace=@loop/backend run check:ledger
```

Output is `OK: ledger reconciled` or a per-(user, currency) drift
listing. Any non-zero drift → STOP, run [`ledger-drift.md`](./ledger-drift.md).

### 4. Asset-drift one-shot

```bash
curl -sS -H "Authorization: Bearer $METRICS_BEARER_TOKEN" \
  "$LOOP_BACKEND_URL/api/admin/asset-drift" | jq '.'
```

Each asset (`USDLOOP` / `GBPLOOP` / `EURLOOP`) returns
`{ onChainStroops, ledgerLiabilityMinor, driftStroops, withinThreshold }`.

`withinThreshold: false` for any asset → STOP, run
[`asset-drift-alert.md`](./asset-drift-alert.md). The reconciliation
or report would propagate the drift.

### 5. Recent migration smoke

If a migration landed in the last 7 days:

- Pick the most recent `orders` / `pending_payouts` / `credit_transactions`
  row and confirm it matches the new schema:
  ```sql
  SELECT * FROM orders ORDER BY created_at DESC LIMIT 1;
  ```
- Run the migration's smoke if one exists (e.g. `0023_orders_idempotency_key.sql`
  smoke = "any row created post-deploy has `idempotency_key` set
  by the loop client" — query for the most recent + assert).

### 6. Spot-check against staging

If staging is healthy (cross-ref A2-1913 — staging environment is
operator-side, may not be live):

- Run the same query against staging and prod
- Confirm shapes match (column count + types)
- A diverging shape → schema drift between envs → block
- Counts will obviously differ; relative ratios should not (e.g. if
  prod's `orders` ÷ `users` is wildly different from staging's, the
  user-pattern has shifted in a way that warrants a thinking-pause)

## Pass / fail

- **All six checks clean** → green-light the dependent flow.
  Document the timestamp + the staging / prod commit SHA pair in
  whichever artifact you're producing (invoice approval, tax line,
  dashboard screenshot).
- **Any check fails** → STOP. The downstream flow is unsafe. Fix
  root cause first, re-spot-check, then proceed.

## Resolution

The spot-check is gating, not remediating. Failures route into the
existing per-failure runbooks:

- migration drift → re-deploy / investigate
- ledger drift → [`ledger-drift.md`](./ledger-drift.md)
- asset drift → [`asset-drift-alert.md`](./asset-drift-alert.md)
- recent-migration shape mismatch → revert + re-test in staging

## Related

- [`monthly-reconciliation.md`](./monthly-reconciliation.md) — the
  flow that mandates this spot-check (A2-1914)
- [`ledger-drift.md`](./ledger-drift.md) — branch when step 3 fails
- [`asset-drift-alert.md`](./asset-drift-alert.md) — branch when
  step 4 fails
- A2-1913 — staging environment (operator-side gap; until staging
  exists, step 6 is "skip" rather than fail)
- A2-1923 — quarterly tax reporting (uses the same spot-check
  before exporting)
