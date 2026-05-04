# Phase 09 - Orders, Procurement, Redemption

Status: complete
Owner: lead (Claude)

## Files reviewed

- apps/backend/src/orders/\* (handler, loop-handler, loop-read-handlers, loop-create-checks, loop-create-response, loop-replay-response, repo, repo-credit-order, repo-errors, repo-idempotency, cashback-split, fulfillment, procure-one, procurement, procurement-asset-picker, procurement-redemption, procurement-worker, transitions, transitions-sweeps, barcode-fields, request-schemas)
- apps/backend/src/routes/orders.ts
- apps/web/app/routes/orders.tsx, orders.$id.tsx
- apps/web/app/services/orders-loop.ts, orders.ts

## Findings filed

- A4-007 Medium — order FX-pinned at creation but watcher revalidates at payment time using fresh oracle
- A4-025 Low — `Number(faceValueMinor)` precision risk in procure-one.ts
- A4-026 Medium — order idempotency conflict detected via message substring not pg error code

## No-finding-but-reviewed

- Order state machine: pending_payment → paid → procuring → fulfilled (or failed/expired). Each transition guarded.
- Credit-funded orders are insert + FOR-UPDATE balance debit + state flip in one txn (orders/repo-credit-order.ts).
- Owner-scoped reads return 404 on non-owner access (loop-read-handlers.ts:114-128).
- Idempotency-Key partial unique index `orders_user_idempotency_unique` (schema.ts:568-570).
- Stuck-procurement sweep partial index `orders_procuring_procured_at`.
