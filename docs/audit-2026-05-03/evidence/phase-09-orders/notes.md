# Phase 09 - Orders, Procurement, and Redemption

Status: in-progress

Required evidence:

- order state machine map
- legacy and Loop-native order flow trace
- procurement and redemption interaction map
- authz and idempotency review
- web purchase flow reconciliation

Findings:

- A4-015: transient operator-pool outage after `paid -> procuring` claim is not retried; the stuck sweep later marks the order failed.
- A4-016: Loop-native order OpenAPI is stale for read-side `loop_asset` and create-side error statuses.
- A4-017: Loop-native order creation trusts client-side denomination limits before writing payable orders/debits.

Evidence captured:

- `artifacts/order-procurement-files.txt`
- `artifacts/operator-pool-procuring-no-retry.txt`
- `artifacts/loop-openapi-runtime-drift.txt`
- `artifacts/loop-order-denomination-validation.txt`

First-pass observations:

- Legacy CTX-proxy order creation/list/detail, Loop-native order creation/read routes, repository writes, credit-funded transaction path, state transitions, fulfillment, procurement worker, redemption fetch, and procurement tests are under review.
- Existing Phase 05 route-shadow finding directly affects `GET /api/orders/loop` reachability; Phase 09 will keep that cross-reference rather than duplicate it.
- Credit-funded order creation correctly performs insert, balance lock, spend transaction, balance update, and `paid` transition in one transaction.
- Fulfillment captures cashback ledger rows, `user_credits`, and `pending_payouts` in one transaction when cashback is positive and payout conditions are met.
- Procurement's operator-pool-unavailable path has a retryability defect filed as A4-015.
- Loop-native OpenAPI drift was found in read-side `paymentMethod` and create-side response statuses.
- Loop-native create validation does not enforce server-side merchant denomination constraints before payment/debit.
