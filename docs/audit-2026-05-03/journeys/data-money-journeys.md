# Data and Money Journeys

## DMJ-001: Order to Ledger to Pending Payout

- Trigger: user order reaches fulfilled state.
- Path: order repo, transitions, cashback split, credit transaction, user credits, pending payouts, shared order/payout types, admin views.
- Required checks: transaction boundary, idempotency, duplicate fulfillment, refund impact, liability math, tests.

## DMJ-002: Inbound Payment Match

- Trigger: Horizon watcher observes payment.
- Path: Horizon client, watcher, memo match, order transition, procurement scheduling, observability.
- Required checks: asset validation, memo parsing, duplicate observation, stale payment, wrong amount, wrong asset, wrong source, retry.

## DMJ-003: Procurement and Redemption

- Trigger: paid order selected by procurement worker.
- Path: procurement worker, CTX operator pool, asset picker, CTX gift card order, fulfillment, redemption storage.
- Required checks: worker concurrency, upstream validation, partial success, duplicate procurement, operator exhaustion, runbook.

## DMJ-004: Pending Payout to Stellar Submission

- Trigger: pending payout worker.
- Path: pending payout repo, payout builder, payout submit, Horizon outbound lookup, state transition, Discord alert.
- Required checks: trustline, memo idempotency, secret handling, retry classification, permanent failure, compensation, reconciliation.

## DMJ-005: Refund, Withdrawal, and Compensation

- Trigger: admin or worker action.
- Path: admin write route, credits primitive, pending payout transition, ledger transaction, audit envelope, admin UI.
- Required checks: double-spend prevention, unique constraints, reason, actor, idempotency, negative balances, tests.

## DMJ-006: Interest Accrual

- Trigger: daily scheduler or manual primitive.
- Path: interest scheduler, accrue-interest, user credits, credit transactions, reporting.
- Required checks: date cursor, duplicate day, rounding, currency, zero/negative balances, transaction boundaries, docs.

## DMJ-007: Reconciliation and Drift

- Trigger: admin dashboard or watcher.
- Path: treasury snapshot, asset drift watcher, circulation, Horizon balances, ledger liabilities, Discord alerts, runbooks.
- Required checks: stale external data, cache, threshold, alert dedupe, false positives, missing assets, tests.
