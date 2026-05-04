# Tranche 1 (MVP) launch runbook

The product Tranche 1 ships is a **discounted gift card store** with crypto checkout (**XLM + USDC**, Loop is merchant of record, Loop holds treasury and pays CTX in XLM). Cashback as a post-purchase Stellar wallet emission, the Stellar passkey wallet, and DeFindex yield are all **Tranche 2** and stay disabled behind feature flags.

The cashback split configured in `merchant_cashback_configs` is delivered as an **instant discount at order creation** — the user pays `chargeMinor − userCashbackMinor` instead of full face value, and no on-chain payout is queued. Same money flow as Tranche 2's cashback, just delivered up-front instead of post-purchase. Flipping `LOOP_PHASE_1_ONLY=false` later swaps the delivery channel back to Stellar emission with no schema change.

This document is the operator runbook: env vars to set, smoke tests to run, what users see, and what gets hidden.

---

## What ships in Tranche 1

User-visible:

- Browse merchants (directory + map + search)
- Save N% on gift cards from 100+ merchants — discount displayed via `merchant.savingsPercentage`
- Sign in with email OTP (CTX-proxied — backend forwards `/login` / `/verify-email` to upstream)
- Buy a gift card with XLM
- View order history (`/orders`)
- Open the gift card and redeem at the merchant
- iOS + Android apps via TestFlight + Play Console

User-hidden (gated behind `LOOP_PHASE_1_ONLY=true`):

- `/cashback` rates index → "coming soon" placeholder
- `/cashback/:slug` per-merchant rate page → placeholder
- `/trustlines` LOOP-asset trustline guide → placeholder
- `/settings/wallet` → placeholder
- `/settings/cashback` → placeholder
- Footer "Cashback rates" + "Trustlines" links → omitted
- Navbar "Rates" + "Cashback" links → omitted
- `LinkWalletNudge` (the "earned cashback, link your wallet" prompt) → renders nothing
- Onboarding step 5 (currency picker) and step 7 (wallet intro) → auto-skipped

Inert at the backend level (independent flags, all default off):

- Loop-native auth (`LOOP_AUTH_NATIVE_ENABLED=false`) — `/api/auth/*` proxies to CTX, no Loop-issued JWTs
- Loop-native orders (`LOOP_AUTH_NATIVE_ENABLED && LOOP_WORKERS_ENABLED && LOOP_STELLAR_DEPOSIT_ADDRESS`) — all required, all unset → `loopOrdersEnabled=false`
- Payment watcher / procurement worker / payout worker / asset-drift watcher → not started
- Interest accrual (`INTEREST_APY_BASIS_POINTS=0`) → scheduler off
- LOOP-asset issuance — issuer env vars unset, drift watcher silent

---

## Operator env: Tranche 1 set

```bash
NODE_ENV=production
PORT=8080

# Upstream + storage
GIFT_CARD_API_BASE_URL=https://spend.ctx.com
DATABASE_URL=postgres://…@…/loop
TRUST_PROXY=true                              # Fly.io / CDN edge
IMAGE_PROXY_ALLOWED_HOSTS=spend.ctx.com,ctx-spend.s3.us-west-2.amazonaws.com

# Tranche 1 UI gate
LOOP_PHASE_1_ONLY=true

# Loop-native auth + orders (required for USDC support — Loop is
# merchant of record; users pay Loop's deposit address; Loop's
# procurement worker pays CTX in XLM)
LOOP_AUTH_NATIVE_ENABLED=true
LOOP_WORKERS_ENABLED=true
LOOP_JWT_SIGNING_KEY=                         # 48+ random bytes; openssl rand -base64 48
LOOP_STELLAR_DEPOSIT_ADDRESS=G…               # Loop treasury account (where users send XLM/USDC)
LOOP_STELLAR_OPERATOR_SECRET=S…               # Operator signing key (pays CTX from treasury)
LOOP_STELLAR_USDC_ISSUER=GA5ZSEJYB37JRC5AVCIA7VBRVRWWZBMXWXZAHYBRQHGSZHGCASCHV3VW   # Centre USDC mainnet
LOOP_STELLAR_USDC_FLOOR_STROOPS=1000000000    # 100 USDC — XLM-fallback floor

# Email provider (required because LOOP_AUTH_NATIVE_ENABLED=true)
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_…
EMAIL_FROM_ADDRESS=noreply@loopfinance.io     # domain must be DKIM-verified at Resend
EMAIL_FROM_NAME=Loop

# Observability
SENTRY_DSN=…
LOOP_ENV=production
DISCORD_WEBHOOK_ORDERS=…
DISCORD_WEBHOOK_MONITORING=…
DISCORD_WEBHOOK_ADMIN_AUDIT=…
DISCORD_WEBHOOK_DEPLOYMENTS=…

# Probe gating (production policy: 404 when unset)
METRICS_BEARER_TOKEN=…                        # 32+ random chars
OPENAPI_BEARER_TOKEN=…
```

**Explicitly NOT set in Tranche 1** — these belong to Tranche 2's cashback emission / yield surface and stay off:

```bash
LOOP_STELLAR_USDLOOP_ISSUER=                  # unset — no LOOP-asset issuance
LOOP_STELLAR_GBPLOOP_ISSUER=                  # unset
LOOP_STELLAR_EURLOOP_ISSUER=                  # unset
INTEREST_APY_BASIS_POINTS=0                   # default — no daily interest
LOOP_INTEREST_POOL_ACCOUNT=                   # unset — no pool
```

The discount path doesn't emit on-chain LOOP-asset, so leaving the LOOP issuers unset is correct (and the asset-drift watcher stays inert because `configuredLoopPayableAssets()` returns an empty list). When Tranche 2 lands you'll set the issuer envs + flip `LOOP_PHASE_1_ONLY=false`, and the cashback amount that's currently delivered as a discount will start emitting as a Stellar payout instead.

For the web build:

```bash
VITE_API_URL=https://api.loopfinance.io
VITE_SENTRY_DSN=…
VITE_SENTRY_RELEASE=$(git rev-parse HEAD)
VITE_LOOP_ENV=production
```

The web client reads `phase1Only` from `GET /api/config` at runtime, so flipping this flag does NOT require an app store resubmission.

---

## Tranche 1 deliverable acceptance check

Per the deliverable roadmap:

> Download and install from app stores / testflight  
> Purchase a discounted giftcard with XLM/USDC  
> Redeem giftcard at merchant (in-store/online)

Smoke test:

1. **Install**
   - iOS: TestFlight → install build → opens to splash → onboarding (Welcome / How it works / Brands / Email / OTP / Biometrics / Welcome-in — currency + wallet steps auto-skipped)
   - Android: APK or Play Internal Testing → same
   - Web: `https://loopfinance.io` → home page loads, Navbar shows Directory / Map / Orders only (no Rates / Cashback)

2. **Sign up**
   - Tap email → enter address → receive OTP via CTX → enter code → land on home
   - Order history tab: empty state

3. **Buy with XLM**
   - Pick merchant (e.g. Amazon US showing "Save 4%")
   - Pick amount (say $25 face value)
   - Confirm → see Loop's deposit address + XLM amount (≈$24 worth, the discounted charge) + memo
   - Send XLM from any wallet to that address with the memo
   - Order moves: `pending_payment → paid → procuring → fulfilled`
   - Gift card code + barcode appear
   - Verify in `/admin/orders/:id` that `userCashbackMinor=0` and the row's `chargeMinor` reflects the discounted price

4. **Buy with USDC** (parallel run, second user)
   - Same flow but pay USDC instead of XLM
   - Watcher should still match by memo + asset (USDC matches via the configured `LOOP_STELLAR_USDC_ISSUER`)
   - Verify `/admin/treasury` shows the USDC inflow before procurement debits it
   - Verify procurement still pays CTX in XLM (USDC stays in treasury until below-floor)

5. **Operator-side verification**
   - `/health` returns `200`, `databaseReachable: true`, all required workers `running: true` (payment_watcher, procurement_worker, payout_worker, asset_drift_watcher), interest_scheduler `disabled` (APY=0 by design)
   - `/admin/orders/:id` shows the order with `paymentMethod=xlm|usdc`, `chargeMinor=<discounted>`, `userCashbackMinor=0`, `wholesaleMinor=<CTX share>`
   - `/admin/treasury` reconciles: XLM in/out match payout submissions, USDC inflow visible
   - Discord `#orders` posted "Order created" + "Order fulfilled"
   - Discord `#monitoring` is silent for normal traffic (only fires on USDC-below-floor, payout-failed, etc.)
   - Sentry has zero unhandled errors during the smoke test

---

## How USDC works in Tranche 1

Loop is the merchant of record (ADR 010). Money flow per order:

1. User selects a $100 face-value gift card carrying a 5% discount config.
2. Loop creates the order with `chargeMinor = 100 − 5 = $95`, no `pending_payouts` queued.
3. Loop returns its own deposit address + memo + the $95 amount to the client.
4. User pays $95 worth of USDC (or XLM) to that deposit address.
5. Payment watcher observes the deposit, marks order `paid`.
6. Procurement worker calls CTX `/gift-cards` paying CTX's wholesale share **in XLM** (USDC reserves are kept and only spent down to the configured floor; below floor, procurement also pays CTX in XLM).
7. Loop pockets the spread between $95 charge and CTX wholesale.
8. CTX returns gift card code → Loop forwards to user.

The treasury reconciliation lives at `/admin/treasury` (admin-only) — USDC + XLM holdings, payout state counts, recent below-floor alerts. The drift watcher stays silent because no LOOP-asset issuers are configured.

---

## What flipping the flag back does (Tranche 1 → Tranche 2)

When you're ready for Tranche 2 (Stellar passkey wallet + on-chain cashback + DeFindex yield):

```bash
LOOP_PHASE_1_ONLY=false                       # web client immediately shows Phase 2 surfaces
LOOP_STELLAR_USDLOOP_ISSUER=G…                # Loop's USDLOOP issuer pubkey
LOOP_STELLAR_GBPLOOP_ISSUER=G…
LOOP_STELLAR_EURLOOP_ISSUER=G…
INTEREST_APY_BASIS_POINTS=350                 # 3.5% APY (or whatever the operator chooses)
LOOP_INTEREST_POOL_ACCOUNT=G…                 # forward-mint pool (or leave unset → defaults to operator account)
```

Effect on the order pricing model:

- Tranche 1 (`LOOP_PHASE_1_ONLY=true`): user pays `chargeMinor − userCashbackMinor`, no on-chain emission.
- Tranche 2 (`LOOP_PHASE_1_ONLY=false`): user pays full `chargeMinor`, `pending_payouts` queues the cashback amount for on-chain LOOP-asset emission.

Same `merchant_cashback_configs` rows; the env flag swaps the delivery channel. Existing orders aren't migrated — Tranche 1 orders stay as discounted, Tranche 2 orders going forward earn cashback to the user's Stellar wallet.

Web + mobile clients pick up the flag flip on the next `GET /api/config` (10-min cache). Mobile clients re-fetch on app foreground. **No app store resubmission required.**
