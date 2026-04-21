# ADR 015: Stablecoin topology and payment rails

Status: Proposed
Date: 2026-04-21
Related: ADR 009 (credits ledger), ADR 010 (principal switch), ADR 011 (admin panel), ADR 013 (Loop-owned auth + CTX operator pool)

## Context

The code currently treats USDC as "the" stablecoin, XLM as a second
payment option, and Loop credits as an off-chain balance. ADRs 009
and 010 stayed silent on the broader treasury model — what assets
Loop holds, what assets the user can send, what assets CTX receives,
and how cashback actually lands in a user's hands.

In practice the topology is richer, and getting it wrong at the
ledger + handler layer is a painful retrofit. This ADR documents
the three-sided flow of assets so later slices can cite it directly
rather than re-deriving it in code comments.

Three flows exist:

```
(1) User → Loop  (order payment)
(2) Loop → User  (cashback payout + withdrawals)
(3) Loop → CTX   (wholesale gift-card procurement)
```

Each flow uses a different asset set, and the reasons are not
interchangeable.

## Decision

### Loop issues three branded Stellar assets

We issue and operate three 1:1-backed fiat stablecoins on Stellar:

- **USDLOOP** — redeemable 1:1 for USD reserves Loop holds
- **GBPLOOP** — redeemable 1:1 for GBP reserves Loop holds
- **EURLOOP** — redeemable 1:1 for EUR reserves Loop holds

These are the asset a user's Loop credit balance is denominated in
from a Stellar perspective. The off-chain `user_credits` ledger
(ADR 009) remains the source of truth; the Stellar side is the
**payout rail** for user withdrawals and is what powers the
"cashback paid to your Stellar wallet" story.

Issuance, backing, and reserve custody are an operations /
compliance concern documented separately (treasury-runbook, not
this ADR). What matters for engineering: these three assets are
first-class in the payment watcher's asset-match guard alongside
USDC, and the cashback engine picks between them based on the
user's region.

### Asset matrix

| Flow                    | Assets accepted                                | Why                                                                                                                                                                                        |
| ----------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (1) User payment → Loop | `USDC`, `XLM`, `USDLOOP`, `GBPLOOP`, `EURLOOP` | A user paying with the same-currency Loop asset is the fastest + cheapest path; USDC is the universal fallback; XLM works via the oracle. Future: ACH / Plaid adds fiat-rails to this set. |
| (2) Cashback → user     | One of `USDLOOP`, `GBPLOOP`, `EURLOOP`         | Always paid in the user's **home-currency** LOOP asset (see below). The order's catalog price may be in another currency — we convert at order creation and pin it.                        |
| (3) Loop → CTX          | **`USDC`** (default), `XLM` (fallback)         | CTX accepts both, but we pay in USDC whenever we can — USDC is the asset we want to hold for yield (see treasury section). XLM is the break-glass path when USDC liquidity is tight.       |

`credit` (Loop balance debit) remains a zero-rail payment path for
users who already have Loop cashback sitting in their account.

### Home currency — assigned at signup, drives denomination end-to-end

Every Loop user has exactly one **home currency** (`USD`, `GBP`, or
`EUR`) set at account creation. It is stored on `users.home_currency`
and changes rarely (support-mediated for MVP — a later self-serve
settings flow is a separate slice).

Home currency drives three things, in lockstep:

1. **Order denomination.** A user with `home_currency = GBP`
   browsing a $50 USD Amazon US gift card sees the order's
   `currency` pinned as `GBP` at checkout, with the GBP minor-unit
   face value derived from the upstream catalog price using the
   Frankfurter FX feed (#328). The user always pays in pence and
   always sees prices in pence; cross-border FX is a one-shot at
   checkout, not a runtime surprise.
2. **Cashback payout asset.** Cashback is paid in the LOOP asset
   that matches the user's home currency — `USDLOOP`, `GBPLOOP`,
   or `EURLOOP`. This is the same as the order's `currency`
   because of rule 1, but the source of truth is
   `user.home_currency` — if we ever diverge the two (see
   "Future: multi-balance users" below), cashback still follows
   the user, not the order.
3. **Credit ledger currency.** `user_credits.balance_minor`
   (ADR 009) is denominated in the home currency's minor unit.
   A £ user's balance is pence; a $ user's balance is cents. No
   per-user FX math at spend time.

Why assign at signup rather than let the user pick per-order:

- **Zero FX friction on the happy path.** 95% of users buy in
  their own region; denominating everything in their currency
  means the balance they see in the app matches the balance they
  can spend against the next order.
- **No "ask at the wrong moment" UX.** Picking a currency at
  checkout or fulfillment would block the buying flow behind a
  modal; picking at signup folds cleanly into the existing
  region/country step of onboarding.
- **One FX conversion, pinned.** Doing the catalog→home FX once
  at order creation and pinning it means the user's receipt, the
  watcher's size check, and the cashback math all agree on the
  same minor-unit face value — no drift between the price on
  screen and the amount debited.

The home→LOOP-asset map is static and lives in one place:
`apps/backend/src/credits/payout-asset.ts` (to be written). Home
currencies without a LOOP asset (a future JPY user, say) fall
back to off-chain cashback accrual only — the `user_credits` row
and `credit_transactions` entry still get written, the
Stellar-side payout doesn't fire until we issue the matching
asset.

### Future: multi-balance users, on-chain LOOP-asset swap

Single-home-currency is right for MVP, but we will outgrow it.
The likely expansion in order of probability:

- **Traveller case.** A UK user spends a month in the US and
  wants to buy US gift cards with US cashback to avoid double-FX.
- **Remittance / gifting.** A user earns EUR cashback from their
  day-to-day and wants to convert it to GBPLOOP to spend on a
  UK merchant.
- **Speculation / diversification.** A user who believes USD will
  strengthen wants to move their GBPLOOP balance into USDLOOP.

To make that expansion non-breaking, the MVP design already bakes
in two things:

- **`user_credits` is keyed by `(user_id, currency)`**, not just
  `user_id`. The MVP always writes one row per user (matching
  their home currency), but the schema already tolerates a user
  having a USD row _and_ a GBP row. Adding a second row later is
  a write, not a migration.
- **LOOP assets are mutually tradable on Stellar DEX.** Because
  USDLOOP/GBPLOOP/EURLOOP are all Stellar assets, a user with an
  external wallet can already swap between them on-chain via any
  SDEX pathway — we don't need a Loop-operated conversion service
  for that. A future in-app "convert GBPLOOP → USDLOOP" button is
  a UX layer over path-payment, not new rails.

What we are explicitly **not** building in MVP: an in-app
swap/convert feature, per-user multiple-home-currency preferences,
or cross-ledger rebalancing. If a launch user needs to hold two
currencies simultaneously, they do it by withdrawing to a Stellar
wallet and swapping on SDEX.

### Treasury strategy: USDC for yield, LOOP assets for liability

Loop's balance sheet has two classes of Stellar asset:

- **USDC held as operating treasury.** We want this pile to be
  as large as we can safely run — it's the asset [defindex](https://defindex.io/)
  and other Stellar DeFi vaults accept as deposit collateral
  for yield. The 4% APY (or whatever the going rate is) on our
  USDC reserves is a material revenue line alongside the
  merchant-margin slice (ADR 011).
- **USDLOOP / GBPLOOP / EURLOOP circulating outside Loop.** These
  are liabilities — every circulating LOOP-asset token is a claim
  on Loop's fiat reserves held in a regulated bank account. We
  don't earn yield on them directly; they earn yield via whatever
  the underlying fiat account pays.

Procurement (flow 3) pays CTX in **USDC by default** because it
keeps our yield-earning pile from being drained for gift-card
flow. XLM is available as a fallback for when USDC liquidity on
the operator account is tight — we'd rather burn XLM at the
going rate than stall procurement — but every XLM outflow is an
ops-flagged event in `admin/treasury` so we can top USDC back up.

### Two independent oracles

Size-checks require two different rate feeds (both already exist
as of #327, #328):

- **XLM→USD/GBP/EUR** (CoinGecko-shaped) — for user XLM payments.
- **USD→GBP/EUR** (Frankfurter-shaped) — for USDC against non-USD
  orders.

LOOP-asset size-checks are **1:1 with their matching fiat**: a
GBPLOOP payment against a £50 order is 5000 pence of GBPLOOP —
no feed needed. This is the same logic that makes them usable
as a payment rail in the first place.

Plaid / open-banking rails (flow 1, future) carry their own
amount semantics — a GBP bank payment for a £50 order is 5000
pence directly, no Stellar math. The ACH slice will add a
rails-specific matcher alongside the Stellar watcher rather than
going through it.

### What doesn't change

- Off-chain `user_credits` ledger (ADR 009) stays authoritative.
  The LOOP assets are the payout rail, not a second source of
  truth — credits can be earned, held, and spent entirely off-
  chain without ever touching Stellar.
- Pinned cashback split (ADR 011) stays pinned at order creation.
  The payout asset is a post-fulfillment concern; no additional
  pinning is required.
- Order state machine (ADR 010) — no new states. Payout just
  slots in as a side effect of the existing `procuring → fulfilled`
  transition's ledger write.

## Consequences

### Positive

- Users see cashback in their own currency, payable to any Stellar
  wallet — matches the product's retail story end-to-end.
- Single FX event per order (catalog → home currency at order
  creation). The watcher, receipt, ledger, and payout all agree
  on one pinned minor-unit value; no drift surface.
- Treasury can chase USDC yield aggressively without compromising
  the user-facing payout UX, because the two asset pools are
  intentionally distinct.
- Payment matcher has a single extension point for adding each new
  accepted asset (LOOP-branded or external) — the watcher's
  `isMatchingIncomingPayment` already takes an asset/issuer pair.
- `user_credits` composite-key design absorbs future multi-home-
  currency support as an additive change, not a migration.

### Negative

- Three LOOP assets = three issuer accounts, three trustlines per
  user who wants on-chain payouts, three audit surfaces. Ops
  overhead is real, and a SEP-24 / wallet-side friction that the
  product must absorb.
- Home currency is effectively immutable for MVP. A user who
  signs up in the wrong region must contact support to switch,
  and support has to reason about any outstanding balance in the
  old currency. Acceptable for launch volume; a scaling pain
  later.
- Regulatory surface is larger: issuing branded fiat stablecoins
  triggers money-transmitter / e-money licensing in most
  jurisdictions. Documented in the treasury-runbook; engineering
  doesn't gate shipping on this but operators must resolve it.
- Yield on USDC is opportunity-sensitive — a defindex rate cut
  below operating cost means we'd want to move reserves; tracked
  in `admin/treasury` (ADR 011) with a future defindex integration.

### Deferred

- **Multi-home-currency users.** A single user holding USDLOOP
  _and_ GBPLOOP _and_ EURLOOP balances simultaneously. The
  schema already accommodates it (`user_credits` keyed by
  `(user_id, currency)`); the UX to pick-and-switch doesn't
  exist yet. Launch users hold one home currency.
- **In-app LOOP-asset swap.** Convert GBPLOOP → USDLOOP without
  leaving the app. A UX layer over Stellar path-payment — not
  new rails. Out-of-scope for MVP; users who want it today
  withdraw + swap on SDEX.
- **Self-serve home-currency change.** Settings-side "change my
  home currency from GBP to USD" flow. For MVP, changing
  requires a support ticket so ops can sanity-check that the
  user's outstanding GBP balance is consumed first (or
  explicitly swept).
- **Plaid / ACH rails** for flow 1. Adds a fiat-native matcher
  alongside the Stellar watcher.
- **Defindex deposit automation.** Today the operator manually
  parks idle USDC reserves in defindex. Future: a scheduled job
  that rebalances a target USDC-held-in-hot-wallet vs.
  USDC-in-defindex ratio based on forecasted procurement volume.
- **SEP-24 / withdrawal UX** for taking LOOP assets off-platform
  into an external Stellar wallet. Covered by the general
  Stellar withdrawal roadmap, not this ADR.

## Rollout checklist

Engineering work this ADR unblocks:

- [ ] `users.home_currency` column — `text NOT NULL`, check
      constraint `IN ('USD','GBP','EUR')`, defaulted by a migration
      off existing country signal (or `USD` if unknown) for pre-
      existing rows. Schema lives in `apps/backend/src/db/schema.ts`.
- [ ] `user_credits` keyed by `(user_id, currency)` — primary key
      (or unique constraint) on the pair, not just `user_id`. MVP
      writes one row per user; the composite key is pure future-
      proofing for multi-balance users (see "Future" section).
- [ ] Order creation — denominate the order's pinned
      `face_value_minor` + `currency` in the user's home currency
      via the Frankfurter FX feed (#328). Receipt, watcher size
      check, and cashback math all key off this pinned value.
- [ ] `credits/payout-asset.ts` — static `homeCurrency →
  loopAssetCode` mapping + issuer addresses (env-configured).
- [ ] Extend `markOrderFulfilled` (or a payout worker adjacent to
      it) to emit a Stellar payment of the matching LOOP asset to
      the user's linked Stellar address, if one is on file.
- [ ] Onboarding UX — an explicit "pick your home currency" step
      (or inference from locale + confirmation), stored on the
      user row before first order creation.
- [ ] Watcher: extend `isMatchingIncomingPayment` allowlist to
      include the three LOOP asset codes + their Loop-issuer account
      (user paying us in their own currency via LOOP asset).
- [ ] Procurement worker: default CTX payment to USDC; fall back
      to XLM only when the USDC operator balance is below a
      configurable floor (future env var).
- [ ] Admin treasury: split the outstanding-balance card into
      "Loop liabilities (LOOP assets outstanding)" vs.
      "Loop assets (USDC held, XLM held)" so the operator sees
      the yield-earning pile distinctly. Break liabilities down
      by asset (USDLOOP / GBPLOOP / EURLOOP) to mirror the
      per-currency reserve accounts.
- [ ] Env vars:
      `LOOP_STELLAR_USDLOOP_ISSUER`,
      `LOOP_STELLAR_GBPLOOP_ISSUER`,
      `LOOP_STELLAR_EURLOOP_ISSUER`,
      `LOOP_STELLAR_USDC_FLOOR_STROOPS` (operator-pool USDC
      reserve below which procurement falls back to XLM).

## Open questions

- **LOOP asset liquidity bootstrap.** Launching the three assets
  means seeding some initial circulating supply + a liquidity
  pool so users can swap between them on-chain. Scope for the
  treasury-runbook, not this ADR.
- **Which defindex strategy?** Lending-based vaults have clean
  risk profiles; AMM-based have higher yield but impermanent-loss
  exposure. Operator call.
- **Home-currency defaulting for existing users.** Every user row
  on the DB today predates this ADR. The migration needs a
  sensible default: infer from the user's CTX profile / country
  (if set), else `USD`, else require a one-time pick on next
  login. Operator-flagged edge cases get corrected manually.
