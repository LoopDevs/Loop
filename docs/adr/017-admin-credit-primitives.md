# ADR 017: Admin credit-ledger primitives

Status: Accepted
Date: 2026-04-22
Implemented: across PRs #399 (credit-adjustment), #400 (credit-history), #401 (refund), plus migration 0011 (`credit_transactions.note`) in #399. Open at time of writing; will merge as a stack.
Related: ADR 009 (credits ledger + cashback capture), ADR 010 (principal switch: Loop as merchant of record), ADR 011 (cashback configuration + audit trail), ADR 015 (stablecoin topology)

## Context

ADR 009 built the user-facing ledger: `credit_transactions` (append-only event log) and `user_credits` (materialised balance). Cashback capture on order fulfilment writes both inside one transaction (ADR 009 §"Cashback capture"). Interest accrual (ADR 009 §"Interest accrual") is the only other writer today.

Two operationally-critical paths were missing:

1. **Support adjustments.** When a user contacts support with a legitimate grievance — promised credit that didn't land, manual goodwill credit, clawback after a merchant dispute — ops had no safe primitive. The only options were a raw SQL UPDATE against `user_credits` (no ledger entry, no audit trail) or ignoring the request.

2. **Refunds on failed orders.** Under ADR 010, Loop is the merchant of record. If CTX can't procure the gift card after the user has paid, Loop owes the customer the money back. `credit_transactions.type='refund'` has been in the schema since ADR 009, but nothing wrote it — admins had to cross-reference a failed order against a manual SQL INSERT.

Both are writes that must leave a durable audit trail: _who_ did it, _when_, and _why_. "Why" is the tricky bit — the existing columns (`reference_type`, `reference_id`) encode _what business event_ the row came from (an order, a payout, etc.), not _what a human decided_.

## Decision

### 1. Persist the "why" as `credit_transactions.note`

Migration 0011 adds `note text NULL` on `credit_transactions`. Nullable on purpose — every pre-existing row (cashback / interest / refund / spend / withdrawal) already has full context via `(reference_type, reference_id)`, and forcing a note on those writes would be noise. Adjustments carry their reason in this column; every other row leaves it null.

Backfill is unnecessary: all pre-migration rows were machine-written and their context is on the reference columns.

### 2. `POST /api/admin/users/:userId/credit-adjustments` — signed support write

The adjustment endpoint is the general-purpose ledger write:

- Body: `{ amountMinor (signed bigint-string), currency ('USD'|'GBP'|'EUR'), note (3–500 chars) }`.
- Positive `amountMinor` credits the user; negative debits. Zero is rejected (noise).
- The DB's `credit_transactions_amount_sign` CHECK constraint already permits _any_ non-zero sign for `type='adjustment'` — the type was designed for this use case from ADR 009.
- The user's `home_currency` must match the adjustment's `currency`. Cross-currency writes are rejected (409 `CURRENCY_MISMATCH`) because `user_credits` is keyed `(user_id, currency)` and silently mixing currencies creates a reconciliation gap.
- If the adjustment would push `user_credits.balance_minor` below zero, the handler returns 409 `INSUFFICIENT_BALANCE` before the transaction runs. The DB's `user_credits_non_negative` CHECK backstops a race, but we want the friendly error first.
- Inside one transaction: insert the `credit_transactions` row, then upsert `user_credits` (INSERT for a user with no prior balance in that currency, UPDATE otherwise).

### 3. Audit-trail convention: `reference_type='admin_adjustment'`

On each adjustment row:

- `reference_type = 'admin_adjustment'`
- `reference_id = <admin.id>` (the admin's Loop user UUID)
- `note` = the operator's free-text reason

This is a deliberate re-purposing of the reference columns. On a cashback row, `reference_type='order'` and `reference_id=<order.id>` — the reference points at a business entity. On an adjustment, they point at the _actor_. The index on `(reference_type, reference_id)` makes "show me every adjustment this admin has written" a fast query.

### 4. `POST /api/admin/orders/:orderId/refund` — typed refund path

The refund endpoint is narrower than adjustment because its shape is fully determined by the order row:

- `amountMinor = orders.charge_minor` (what the user paid)
- `currency = orders.charge_currency` (their home currency at order time)
- `type = 'refund'` (positive by ADR 009 CHECK)
- `reference_type = 'order'`, `reference_id = orderId`

Pre-flight guards:

- Order must exist → 404.
- Order must be in `state='failed'` → 409 `ORDER_NOT_REFUNDABLE`. Other states are either not-yet-paid (nothing to refund), fulfilled (user has the card), or expired (payment never arrived).
- No prior refund for this order → 409 `ALREADY_REFUNDED`. Idempotency check keyed on `(reference_type='order', reference_id, type='refund')` — the DB doesn't enforce this as a UNIQUE constraint because other types (cashback on the same order) legitimately co-exist with the same reference pair. A single lookup query before the insert is the guard.

The DB transaction itself is the same shape as adjustment: INSERT the ledger row, upsert `user_credits`.

### 5. `GET /api/admin/users/:userId/credit-history` — admin-scoped ledger view

Mirrors the existing caller-scoped `/api/users/me/cashback-history` but:

- Scoped to any user the admin names (not just the caller).
- Includes the `note` field. End users don't see notes — they're operational context.

Same pagination shape (`?before=<iso>&limit=<n>`, newest first), same CHECK-enforced type enum.

Rendered as a "Recent ledger" table on `/admin/users/:userId` with type-coloured pills (cashback green, withdrawal/spend red, adjustment yellow). The refund + adjustment writes invalidate this query on the web side so newly-written rows appear without a reload.

## Consequences

### What this changes

- Support ops now has a single auditable primitive for every manual ledger write. A future reviewer can read `credit_transactions` for a given user and reconstruct every credit, every debit, every refund, and the admin-typed reason for each adjustment.
- The refund path is idempotent by construction. A double-click on the "Refund" button in `/admin/orders` is a 409, not a double-pay.
- `user_credits.balance_minor` is always the sum of the user's `credit_transactions` for that currency. This invariant held under ADR 009 and survives the new writers — every adjustment and refund goes through the same transaction-wrapped upsert.

### What this deliberately does NOT do

- **No rate-limit on adjustment size.** An admin writing a billion-GBP adjustment will succeed if the user has the balance. We rely on human review + the audit trail (reference_id = admin.id, note required) to catch abuse. A soft cap is a follow-up if the ops team asks for one.
- **No "reverse adjustment" endpoint.** If an adjustment was written in error, the admin writes a second adjustment with the opposite sign. That's intentional: the ledger is append-only by construction (ADR 009), and reversal-as-a-new-row keeps the "what did we believe when" history intact. Both rows survive forever with their notes.
- **No multi-currency adjustments.** A user with GBP home currency can only receive GBP adjustments. Cross-currency support would require a policy on FX rates + source-of-truth; out of scope today.
- **No Stellar-side mirror.** Adjustments land off-chain only — they're support corrections, not user-initiated moves. Withdrawals (which already mirror to Stellar via ADR 015) remain the only path that emits a LOOP-asset payout.
- **No support-specific `type` value.** Adjustments use `type='adjustment'`, which was pre-existing. Adding `type='support_credit'` / `type='support_debit'` would be finer-grained but also noisier — the single type plus the note captures everything a reviewer needs.

### Operational observability

- Every adjustment write logs at `info` level with `{ targetUserId, adminId, currency, amountMinor }`. The note isn't logged (PII risk on a support conversation reference) — it lives on the DB row.
- Every refund write logs at `info` with `{ orderId, userId, adminId, currency, amountMinor }`.
- Neither fires a Discord notification today. Adjustments are low-volume and the admin already sees an inline success banner; refunds are follow-up ops work on a failed order that's already been alerted-on. A future "per-day adjustment totals" Discord digest is a candidate if the volume grows.

### Interaction with ADR 011 (cashback config)

ADR 011's `merchant_cashback_configs` history captures _who changed the cashback split, when, to what_. ADR 017 is the analogous mechanism for _who changed a user's balance_. They use the same audit-trail pattern (admin id + timestamp) but live on different tables because the questions are different: one is "why is Loop's margin on Tesco wrong?", the other is "why did this specific user get £5?".

## Migration path

No migration required beyond 0011. Pre-existing ledger writers (cashback capture on fulfillment, interest accrual) are untouched — they never wrote to `note`, and they still don't.

Admin surface is additive: new endpoints, new web sections, no API contract changes to existing paths.
