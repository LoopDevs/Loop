# Admin Journeys

## AJ-001: Admin Access and Navigation

- Actor: admin/operator.
- Entry points: admin route index, require-admin component, backend admin auth middleware.
- Audit surfaces: admin identification, route guards, service auth, unauthorized states, logs.
- Required checks: authz, session expiry, no client-only protection, tests, docs.

## AJ-002: Credit Adjustment

- Actor: admin modifying user credits.
- Entry points: credit adjustment form, admin write envelope, backend credit writes, credits adjustments, DB audit tables.
- Required checks: actor, reason, idempotency key, transaction, daily caps, concurrency, audit log, OpenAPI, tests, docs.

## AJ-003: Refund and Withdrawal

- Actor: admin refunding or withdrawing credits.
- Entry points: admin user detail, withdrawal form, backend admin routes, credit withdrawal/refund primitives, pending payouts.
- Required checks: negative balance prevention, unique withdrawal linkage, compensation, audit envelope, payout queue, runbooks.

## AJ-004: Payout Retry and Compensation

- Actor: admin recovering stuck or failed payout.
- Entry points: admin payouts pages, payout detail, backend payout admin routes, payout worker transitions.
- Required checks: state preconditions, duplicate retry safety, memo idempotency, failure classification, audit trail, Discord alerts, tests.

## AJ-005: Cashback Configuration

- Actor: admin changing merchant cashback rates.
- Entry points: admin cashback route, config history card, backend cashback config handlers, audit trigger.
- Required checks: validation, actor and reason, effective dates, history, cache invalidation, public surface effects, tests.

## AJ-006: Treasury, Assets, and Reconciliation

- Actor: admin reviewing balances and liabilities.
- Entry points: admin treasury/assets routes, backend treasury/assets handlers, Horizon balances, ledger aggregation.
- Required checks: liability math, asset circulation, drift state, settlement lag, stale external balances, CSV/report consistency.

## AJ-007: Users, Merchants, Operators, Orders, and Audit Tail

- Actor: support/admin operator.
- Entry points: admin users, merchants, operators, orders, stuck orders, audit routes.
- Required checks: pagination, filtering, sensitive data, per-user authz, CSV, drill-down query correctness, N+1 or resource exhaustion, tests.

## AJ-008: Discord and Operational Notifiers

- Actor: admin toggling or reviewing notifier behavior.
- Entry points: Discord notifier admin card, backend notifier catalog, webhook sender code.
- Required checks: webhook secrecy, message redaction, rate limiting, failure handling, docs, runbooks.
