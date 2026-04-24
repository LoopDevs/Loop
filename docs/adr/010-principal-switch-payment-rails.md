# ADR 010: Principal switch and payment rails

Status: Accepted
Date: 2026-04-21
Implemented: 2026-04-21 onwards (loop-native order surface `POST/GET /api/orders/loop` in orders/loop-handler.ts; order state machine in orders/transitions.ts; CTX treated as supplier rather than customer identity provider)
Related: ADR 009 (credits ledger), ADR 011 (admin panel)

## Context

Under the affiliate model shipped today, Loop never touches the money
in a gift-card purchase:

```
User → [XLM] → CTX deposit address
CTX  → [gift card code] → Loop UI
```

The "savings" the user sees is an immediate discount on CTX's side;
Loop captures zero revenue and nothing flows through our books.

Moving to the cashback product (ADR 009) requires Loop to become the
**merchant of record**. Users pay Loop; Loop procures the card from
CTX; Loop captures the full CTX discount; Loop then splits that
discount between a user-visible cashback credit (into the ledger in
ADR 009) and a Loop margin.

Loop owns CTX, so the server-to-server commercial relationship is
internal — no re-papering required. What we need is the payment-flow
rewiring and the order state machine that supports it.

## Decision

### New order flow

```
User  → [payment]     → Loop-owned address / internal ledger
Loop  → [wholesale]   → CTX (server-to-server, Loop's credentials)
CTX   → [code/PIN]    → Loop → User
Delta: cashback credited to ledger + Loop margin retained
```

The user-facing payment UI offers three payment sources at launch:

1. **XLM** — pay to Loop's deposit Stellar account with an
   order-specific memo.
2. **USDC (Stellar)** — pay the same Loop address, with USDC asset.
   Same memo model.
3. **Loop balance** — pay from the user's credit ledger (ADR 009).
   No on-chain movement; internal ledger operation only.

Plaid / ACH / bank rails are out of scope for this ADR and will be
added when the partner is selected.

### Deposit accounts and memo attribution

- One Loop-controlled Stellar account per currency (initially one for
  XLM + USDC since both live on Stellar).
- Per-order attribution via the Stellar transaction memo — a short
  unique token generated at order creation, stored on the order row.
- A Horizon streaming listener watches the deposit account and
  matches incoming `payment` operations by memo → transitions the
  order from `awaiting_payment` to `paid`.

Memo was chosen over per-order sub-accounts because the attribution
is simpler, there's no trustline / funding overhead, and Stellar's
memo field is purpose-built for this pattern.

### Rate oracle

Quotes (XLM / USDC equivalent of the user's local-currency face
value) are taken from `rates.ctx.com` at order creation and locked
for the payment window (15 minutes, matching the existing expiry).
Loop — which owns CTX — eats any rate drift within that window.
Outside the window, the order expires and the user has to request a
fresh quote.

### Order state machine

```
awaiting_payment ──(xlm/usdc received OR balance debit)────▶ paid
paid             ──(CTX fulfils: code returned)────────────▶ completed
paid             ──(CTX fails / timeout)──────────────────▶ refund_pending
refund_pending   ──(refund settled)────────────────────────▶ refunded
awaiting_payment ──(expiry timer)──────────────────────────▶ expired
```

Idempotency keys are required on every state transition so a repeated
Horizon event or a retry of the CTX call doesn't double-fulfil.

### Order row additions

```sql
ALTER TABLE orders ADD COLUMN face_value_minor      BIGINT NOT NULL;
ALTER TABLE orders ADD COLUMN wholesale_cost_minor  BIGINT NOT NULL;
ALTER TABLE orders ADD COLUMN cashback_amount_minor BIGINT NOT NULL;
ALTER TABLE orders ADD COLUMN loop_margin_minor     BIGINT NOT NULL;
ALTER TABLE orders ADD COLUMN payment_source        TEXT   NOT NULL;  -- 'xlm' | 'usdc' | 'balance'
ALTER TABLE orders ADD COLUMN payment_asset_issuer  TEXT;             -- USDC issuer, nullable
ALTER TABLE orders ADD COLUMN payment_memo          TEXT;             -- Stellar memo, nullable for balance
ALTER TABLE orders ADD COLUMN paid_at               TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN fulfilled_at          TIMESTAMPTZ;
```

The cashback and margin amounts are **pinned at order creation** from
the merchant's admin-configured split (ADR 011), not re-derived at
fulfilment time. This means later changes to cashback policy don't
retroactively alter the books for historical orders.

### Refund path

On a `paid → refund_pending` transition:

- XLM / USDC payments: queue an outbound Stellar payment back to the
  payer's source account from the deposit account. Same memo used
  so the user / accounting can trace the round trip.
- Balance payments: reverse the ledger entries (debit Loop revenue,
  credit the user's balance). No on-chain movement.

## Alternatives considered

1. **Per-order sub-accounts for attribution.** Rejected: trustline /
   funding overhead, more Horizon traffic, no benefit over memos.
2. **Keep CTX as the payment recipient, add a separate Loop-side
   cashback ledger fed by CTX on settlement.** Rejected: Loop
   doesn't control the flow, no ability to accept balance-pays or
   bank rails later, and the cashback timing is at CTX's discretion.
3. **Synchronous CTX call during the payment transaction.** Rejected:
   CTX timeouts would force the user to re-try payments mid-flow.
   Splitting `paid` from `completed` lets us retry CTX silently.
4. **Float rate during the payment window.** Rejected: the user sees
   a moving target and may overpay or underpay. Lock at quote,
   Loop eats drift (internal within the CTX group).

## Consequences

- Loop holds float between "user pays" and "CTX fulfils". Reserve
  budget needed in each treasury currency.
- Horizon streaming listener is a new stateful component; needs a
  supervisor / reconnect policy and unmatched-payment alerting.
- CTX's current public `/gift-cards/:id` path gets shadowed by a
  server-side Loop-credentialed call; CTX's public rate-limit + auth
  no longer sits in the user's request path.
- Pay-from-balance makes the cashback flywheel visible — users accrue
  credit and spend it without any external settlement. Good product
  story; fast to ship once the ledger exists.
- Chargebacks become Loop's problem if we ever add card rails — not
  a concern for XLM / USDC, but reserved for Phase 2 thinking.

## References

- Session transcript 2026-04-21, principal-switch discussion.
- `apps/backend/src/orders/` (current affiliate flow, to be
  rewritten as part of this ADR's implementation).
