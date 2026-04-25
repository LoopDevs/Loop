# ADR 024: Withdrawal writer (USDC cash-out of cashback balance)

Status: Accepted
Date: 2026-04-24
Implemented: 2026-04-25 onwards (migration 0018 generalised pending_payouts; migration 0022 extended `credit_transactions_reference_unique` to include `withdrawal`; `applyAdminWithdrawal` ledger primitive in `apps/backend/src/credits/withdrawals.ts`; `POST /api/admin/users/:userId/withdrawals` admin handler in `apps/backend/src/admin/withdrawals.ts` with full ADR-017 idempotency + audit envelope + Discord fanout)
Related: ADR 009 (credits ledger), ADR 013 (Loop-owned auth), ADR 015 (stablecoin topology), ADR 016 (payout submit worker), ADR 017 (admin write primitives)
Resolves: A2-901 residual (`withdrawal` writer), migration 0013 §28

## Context

The ledger `credit_transactions.type` enum has carried `'withdrawal'`
since day one: the shared type lists it, the `openapi.ts` schema
lists it, the schema CHECK accepts it, and the partial sign-check
requires negative `amount_minor`. **No production writer exists.**
Every path that reduces a user's balance today is either a
`type='spend'` (order-funded) or an admin `type='adjustment'`.

Migration 0013 explicitly called this out:

> 'withdrawal' — no writer exists yet (Phase 2). When it lands the
> uniqueness should be scoped to the payout id, so this migration
> leaves it out.

With the payout infrastructure from ADR 016 shipped (`pending_payouts`
rows, Stellar SDK submit, retry worker, admin retry endpoint), the
last missing piece is the ledger-writer that _creates_ the payout
row in the first place. Without it, cashback balances are
accumulate-only; a user with £42.00 of USDLOOP credit cannot
convert it to USDC on their Stellar wallet.

This ADR pins the contract for that writer. It does **not** extend
user-initiated withdrawal to the app UI yet — that remains Phase 2b.
The initial surface is admin-only (support-mediated withdrawal),
which matches both the current operator workflow and the Phase-1
conservatism of ADR 015.

## Decision

### 1. Admin-only entry point (Phase 2a)

```
POST /api/admin/users/:userId/withdrawals
```

Body:

```jsonc
{
  "amountMinor": "420",
  "currency": "USD",
  "destinationAddress": "G...", // user's Stellar wallet
  "reason": "support ticket #4823 — manual cash-out request",
}
```

Headers:

- `Idempotency-Key` (required, ADR 017)
- standard admin auth headers

Authorization: `requireAdmin`, same as refund.

A user-initiated `POST /api/users/me/withdrawals` is **out of scope
for this ADR.** It requires per-user idempotency scoping, an
in-app confirmation flow, and rate limits that the admin surface
doesn't need. Phase 2b.

### 2. Schema prerequisite — generalise `pending_payouts`

`pending_payouts` today is shaped for order-fulfilment payouts only:

```
order_id  uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT
UNIQUE INDEX pending_payouts_order_unique ON (order_id)
```

A withdrawal has no associated order — the user is cashing out an
aggregate cashback balance, not reversing a specific purchase. The
first implementation PR therefore has to generalise the table before
the ledger primitive can land:

1. `ALTER TABLE pending_payouts ALTER COLUMN order_id DROP NOT NULL`
   — withdrawal rows leave `order_id IS NULL`.
2. `DROP INDEX pending_payouts_order_unique;
CREATE UNIQUE INDEX pending_payouts_order_unique
ON pending_payouts (order_id) WHERE order_id IS NOT NULL;`
   — partial unique, preserves the idempotency guard for order-fulfilment
   payouts without blocking multiple withdrawal rows.
3. `ADD COLUMN kind text NOT NULL DEFAULT 'order_cashback'
CHECK (kind IN ('order_cashback', 'withdrawal'))`
   — explicit discriminator. The default keeps the migration
   backward-compatible for in-flight rows written by the existing
   cashback fulfilment path.
4. `ADD CONSTRAINT pending_payouts_order_required_for_cashback CHECK
((kind = 'order_cashback' AND order_id IS NOT NULL) OR (kind = 'withdrawal' AND order_id IS NULL))`
   — pins the shape contract per kind.

The payout worker (`payments/payout-worker.ts`) is agnostic to how
a row got there — it reads `pending_payouts WHERE state='pending'`
and submits. The only change it needs is to tolerate
`order_id IS NULL` on the read path. That's a two-line touch.

The admin CSV + drill-down at `/admin/payouts` adds a `kind` column
filter so treasury can separate the two flows visually.

### 3. Atomic two-row write

Inside a single DB transaction:

1. `SELECT … FROM user_credits WHERE (user_id, currency) FOR UPDATE`
   — lock the balance row.
2. Reject if `balanceMinor < amountMinor` with 400
   `INSUFFICIENT_BALANCE`.
3. `INSERT INTO pending_payouts (…) RETURNING id` — writes the
   payout queue row first so we have its id to reference.
4. `INSERT INTO credit_transactions (type='withdrawal',
amount_minor = -amountMinor, reference_type='payout',
reference_id=<payout id>, reason=<body.reason>)`.
5. `UPDATE user_credits SET balance_minor = balance_minor -
amountMinor WHERE …` — uses the FOR UPDATE-locked row.

The _payout first, credit-tx second_ order matters: if step 4 or 5
fails, the payout row is orphaned but invisible (no credit-tx
references it, worker's `listPendingPayouts` will pick it up and
submit anyway). Orphaned orders are easier to reconcile than
orphaned credit-txs with no payout (which would be the shape of
the ledger with reversed order).

Actually, to avoid an orphan entirely, we do payout + credit-tx +
balance decrement in the same `db.transaction(async (tx) => …)`
block — all-or-nothing. The "payout first" ordering is just within
the txn, for the reference-id dependency.

### 4. Partial unique index on `(type='withdrawal', reference_type='payout', reference_id)`

A new migration extends the 0013 partial unique index to cover
withdrawals:

```sql
DROP INDEX credit_transactions_reference_unique;
CREATE UNIQUE INDEX credit_transactions_reference_unique
  ON credit_transactions (type, reference_type, reference_id)
  WHERE type IN ('cashback', 'refund', 'spend', 'withdrawal')
    AND reference_type IS NOT NULL
    AND reference_id IS NOT NULL;
```

Semantics: at most one withdrawal credit-tx per payout id. A retry
of the admin endpoint with the same `Idempotency-Key` replays via
ADR-017; a concurrent second admin accidentally issuing a parallel
withdrawal for the same payout would hit the DB layer.

`pending_payouts.id` is a fresh UUID per call, so "same payout
twice" is not a naturally-occurring concern — the index exists to
catch operator-error retries that bypass the idempotency layer.

### 5. Compensation on permanent payout failure

If the payout worker marks `pending_payouts.state = 'failed'` with
`failure_kind = 'permanent'` (e.g. destination account does not
exist, operator lacks trustline, Horizon rejected with a non-retryable
`op_*` error), the user's ledger is still net-negative by the
withdrawal amount — their USDLOOP is gone but they never got USDC.

We compensate with a `type='adjustment'` row rather than a
`type='refund'`:

- `refund` is scoped to orders per the refund writer (ADR 017
  implementation; migration 0013 §15) and the partial unique index
  key is `(type='refund', reference_type='order', reference_id)`.
  Reusing `refund` would mean either broadening the index (bad —
  loses the per-order at-most-once invariant) or leaving the
  reference fields null (bad — breaks the reconciliation story).
- `adjustment` is already the "anything not covered by the other
  types" escape hatch. Migration 0013 §20 explicitly keeps
  `adjustment` out of the partial unique index because admin
  adjustments are intentionally repeatable.

The compensation row references the same payout id with
`reference_type='payout'`, which is inert from the index's point
of view (the index only constrains `refund`, `cashback`, `spend`,
and — post-this-ADR — `withdrawal`).

Compensation is triggered by a scheduled job, not automatically
from the worker, so finance has a chance to review before the
adjustment lands. Initial implementation: admin fires
`POST /api/admin/payouts/:id/compensate` after the failure. A
future ADR can automate the scheduled sweep.

### 6. Response envelope mirrors the refund handler

Same shape as `RefundResponse` (ADR 017) so the admin UI can share
the post-action renderer:

```ts
interface WithdrawalResponse {
  id: string; // credit_transactions.id
  payoutId: string; // pending_payouts.id
  userId: string;
  currency: string;
  amountMinor: string; // unsigned minor-units; the stored row is negative
  destinationAddress: string;
  priorBalanceMinor: string;
  newBalanceMinor: string;
  createdAt: string;
}
```

The envelope is wrapped by `buildAuditEnvelope` and stored in
`admin_idempotency_keys` for replay.

### 7. Error ladder

| Code                        | Status | Condition                                                    |
| --------------------------- | ------ | ------------------------------------------------------------ |
| `VALIDATION_ERROR`          | 400    | body shape / UUID / destination-address format               |
| `IDEMPOTENCY_KEY_REQUIRED`  | 400    | missing or malformed header                                  |
| `INSUFFICIENT_BALANCE`      | 400    | `balanceMinor < amountMinor` at FOR-UPDATE read              |
| `UNAUTHORIZED`              | 401    | not an admin (shouldn't happen — middleware rejects earlier) |
| `USER_NOT_FOUND`            | 404    | userId does not resolve                                      |
| `WITHDRAWAL_ALREADY_ISSUED` | 409    | partial unique index violation — matches the refund ladder   |
| `INTERNAL_ERROR`            | 500    | unexpected DB / transaction failure                          |

The 409 is vestigial in the admin path (Idempotency-Key catches
retries) but becomes load-bearing once Phase 2b adds user-initiated
withdrawals.

## Consequences

**Positive**

- Closes the A2-901 residual cleanly — every `credit_transactions.type`
  has a production writer.
- Admin-treasury operational story is complete: cashback in (order →
  spend + cashback), cashback adjusted (admin adjustment), cashback
  refunded (admin refund per ADR 017), cashback out (this ADR).
- Reuses ADR 017 primitives (Idempotency-Key, audit envelope, Discord
  notify, storeIdempotencyKey snapshot) — no new write-side invariants
  to audit.
- Reuses ADR 016 payout infrastructure — the submit worker doesn't
  care _how_ a `pending_payouts` row got there, just that one exists.

**Negative**

- Third partial-unique-index variant (`cashback`/`order`,
  `refund`/`order`, `spend`/`order`, `withdrawal`/`payout`) — the
  reconciliation report needs a small extension.
- Requires one new migration (index broadening) — first migration
  since 0017.
- Compensation path is admin-triggered for now; a user whose payout
  permanently fails waits on support. Acceptable for Phase 2a.

**Deferred (Phase 2b)**

- User-initiated withdrawal from the mobile/web app (needs per-user
  idempotency keyed on device + server-issued nonce).
- Automatic compensation sweep for `failed.permanent` payouts.
- Min / max withdrawal caps (Phase 2a uses the same 10,000,000 minor
  cap as refund/adjustment — enough for manual operator use).
- Multi-asset support (USDLOOP / GBPLOOP / EURLOOP currently all
  settle to USDC on Stellar; ADR 015's Phase 3 will split them).

## Implementation plan

PR 1 — **Schema prerequisite** (self-contained, merges first):

- Migration: generalise `pending_payouts` per §2 — nullable
  `order_id`, partial unique index, `kind` discriminator column,
  per-kind shape CHECK.
- Migration: extend `credit_transactions_reference_unique` to
  include `withdrawal` rows per §4.
- One-line tolerate-null on `payments/payout-worker.ts`
  `listPendingPayouts` read path.
- Schema tests: `kind='withdrawal' AND order_id IS NOT NULL`
  rejected by CHECK; two `kind='withdrawal'` rows coexist (partial
  unique does not constrain); existing order-cashback behaviour
  unchanged.

PR 2 — **Ledger primitive**:

- `src/credits/withdrawals.ts` — `applyAdminWithdrawal` txn, parallel
  to `applyAdminRefund`, with the balance-check and the atomic
  two-row insert per §3.
- Unit tests: happy path, insufficient-balance, FOR UPDATE race
  between two concurrent withdrawals, partial-unique-index catch.

PR 3 — **Admin handler + openapi + tests**:

- `src/admin/withdrawals.ts` — handler with Idempotency-Key,
  buildAuditEnvelope, notifyAdminAudit, error-ladder.
- `src/app.ts` route registration.
- `src/openapi.ts` schema + error-ladder.
- Handler tests mirroring `admin/refunds.test.ts`.

PR 4 — **Admin UI**:

- Withdraw button on the user-drill page, behind a confirm modal.
- Renders the same envelope as refund, with the payout ID linked to
  the payouts drill-down.
- `/admin/payouts` drill-down gets a `kind` column filter per §2 so
  treasury can separate order-cashback from withdrawal flows.

PR 5 — **Compensation endpoint** (small, follow-up):

- `POST /api/admin/payouts/:id/compensate` — writes a `type='adjustment'`
  row referencing the failed payout with the same
  `abs(amount_minor)` positive.

Phase 2b (separate ADR): user-initiated withdrawal.
