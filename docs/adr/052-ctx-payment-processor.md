# ADR 052: CTX is the payment processor — retire the ADR 010 money-in rails

Status: Accepted
Date: 2026-08-28
Supersedes: ADR 010 (money-in half: deposit watcher, procurement,
CTX settlement, payment-method rails); ADR 015 §payment-rail
sections (deposit watcher allowlist, FX-pin at order creation,
USDC-first supplier settlement); executes ADR 039 (legacy CTX-proxy
create retired — its read handlers survive for historical rows)
Related: ADR 051 (single operator API key — the credential this flow
rides on), ADR 011 (admin panel — cashback config reshaped here),
ADR 013 (Loop-owned auth — unchanged)

## Context

ADR 010 made Loop the merchant of record: customers paid Loop's
Stellar deposit address (or their Loop credit balance), a Horizon
watcher flipped orders `paid`, a procurement worker bought the card
wholesale from CTX and settled CTX in XLM, and Loop funded cashback
out of the captured wholesale margin. That inverted the actual
business relationship. Loop is an **operator** (reseller) in the CTX
namespace: CTX handles the customer's payment directly, fulfils the
card, and owes Loop commission — Loop never touches the money-in
leg.

Two CTX-side capabilities (landed with the interop work, ADR 051)
make the correction mechanical:

- **Act-as purchases**: `POST /gift-cards` with the company API key
  plus `X-User-Id` / `X-Client-Id` creates a card as the customer;
  the response carries CTX's payment instructions (crypto address,
  amount, payment URLs, payment id). `operatorReference` round-trips
  Loop's order id.
- **Native operator economics**: each card snapshots
  `operatorDiscountBasisPoints` / `userDiscountBasisPoints` /
  `operatorProfitShareBasisPoints`. The customer pays
  `face − userDiscount`; commission
  (`spread × profitShare`, floored per step) accrues into a
  per-currency ledger on paid+fulfilled, keyed back to Loop via
  `operatorReference`, and is read via
  `GET /companies/:id/commission[/entries|/settlements]`.

## Decision

**CTX is the money-in rail. Loop keeps a mirror, not a machine.**

1. `POST /api/orders/loop` creates the card at CTX acting-as the
   customer (forwarding the originating platform's client id —
   `loopweb` / `loopios` / `loopandroid`, never a silent default) and
   relays CTX's payment instructions. `cryptoCurrency` is
   client-chosen against the `LOOP_CTX_PAYMENT_CURRENCIES` allowlist
   (default `XLM`). Payment expiry is CTX's (`GET /payments/:id`);
   Loop invents no window of its own.
2. The local `orders` row is a **mirror** of CTX `displayStatus`:
   `unpaid | paid | fulfilled | rejected | refunded` plus loop-local
   `expired`. It advances via the `/ws` `giftcard` topic
   (`ctx/giftcard-ws-maintainer.ts`) with an advisory-locked sweep
   (`orders/ctx-mirror-sweep.ts`) as belt-and-braces: card re-reads,
   orphan rejection, economics retry, and expiry off CTX's payment
   window. Fulfilment fetches + encrypts the redemption payload
   exactly as before.
3. **Economics are logged, not enforced**: each order records
   `user_cashback_minor` (CTX's checkout discount) and
   `expected_commission_minor`
   (`(operatorBp − userBp) × face × profitShareBp`, floors, null =
   unknown never zero) from the operator-scope read-back. The
   ctx-commission proxy (`/api/admin/ctx-commission*`) is the
   authoritative money surface.
4. **Cashback is one knob**: `merchant_cashback_configs` collapses
   to a single `user_cashback_pct` — the share of Loop's margin
   given to the customer (0 = Loop keeps the spread, 100 = all of it
   to the customer). Delivered as CTX's native user discount:
   admin saves (and the hourly catalog-sweep reconcile) push
   `userDiscountBasisPoints = floor(operatorDiscountBp × pct / 100)`
   onto Loop's merchant link via bulk `PUT /merchant-links`
   (`merchants/ctx-links.ts`). CTX enforces user ≤ operator.
5. **Hard cut**: the deposit watcher, procurement worker, CTX
   settlements, price/FX feeds, operator-float reconciliation,
   payment-method rails (`xlm|usdc|credit|loop_asset`), deposit
   refunds, order redrive/refund, and their admin surfaces are
   deleted — code, routes, tables (migration 0076), env, Discord
   notifiers, docs. Historical order rows keep face/charge history;
   in-flight pre-052 rows were mapped (`pending_payment|paid|
procuring → expired`, `failed → rejected`). Migration 0077
   reshapes the cashback config.

**Money-out is explicitly deferred.** The credit ledger, payouts,
vaults, and interest machinery stay in-tree in their current dormant
state; how CTX commission eventually funds user-facing money-out is
a future bridge ADR. The `order_redeem` vault-redemption source is
retired (the settle branch now throws); `LOOP_STELLAR_DEPOSIT_ADDRESS`
survives only as the operator account identity for the payout/vault
side.

## Consequences

- Loop holds no customer crypto and quotes no prices — pricing,
  underpayment, overpayment, refunds, and payment expiry are CTX's
  problems. The entire class of watcher/procurement incidents
  (stuck-in-paid, skipped deposits, float drift, settlement lag)
  disappears with their ~10k LOC.
- Loop's revenue recognition moves from "captured margin per order"
  to "commission receivable from CTX", reconciled against
  `expected_commission_minor` and settled manually CTX-side for now.
- The mirror can lag CTX briefly (ws gap → sweep backstop); surfaces
  reading the mirror tolerate that, and the unpaid detail read
  overlays a live CTX card read.
- The web purchase flow is a single ctx-payment screen (address +
  QR + open-in-wallet + CTX expiry countdown); Loop-balance payment
  died with the money-in rails.

## Verification

- `npm run verify` green (typecheck, lint, prettier, docs route
  parity, shared-type + openapi parity, dead-flags, money
  invariants, unit suites).
- spend-api: act-as purchase test, operator-created-user
  verification skip, X-Client-Id fast-fail (`staging` 01ca90e).
- End-to-end against staging CTX: create → pay → ws `paid` /
  `fulfilled` events → redemption fetch → commission entry visible
  under `GET /companies/:id/commission/entries` with the
  `operatorReference`.
