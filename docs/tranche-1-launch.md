# Tranche 1 (MVP) launch runbook

The product Tranche 1 ships is a **discounted-gift-card store** with crypto checkout (XLM-only at launch; USDC requires Tranche 2 rails — see "USDC and Tranche 1" below). Cashback, the Stellar passkey wallet, on-chain LOOP-asset emission, and DeFindex yield are all **Tranche 2** and stay disabled behind feature flags.

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

# Required for Tranche 1
GIFT_CARD_API_BASE_URL=https://spend.ctx.com
DATABASE_URL=postgres://…@…/loop
TRUST_PROXY=true                              # Fly.io / CDN edge
IMAGE_PROXY_ALLOWED_HOSTS=spend.ctx.com,ctx-spend.s3.us-west-2.amazonaws.com

# Tranche 1 launch gate (UI side)
LOOP_PHASE_1_ONLY=true

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

# Rate-limit + auth secrets
LOOP_JWT_SIGNING_KEY=                         # NOT set in Tranche 1 — native auth disabled
```

**Explicitly NOT set in Tranche 1** (defaults are correct):

```bash
LOOP_AUTH_NATIVE_ENABLED=false                # default
LOOP_WORKERS_ENABLED=false                    # default
LOOP_STELLAR_DEPOSIT_ADDRESS=                 # unset
LOOP_STELLAR_OPERATOR_SECRET=                 # unset
LOOP_STELLAR_USDLOOP_ISSUER=                  # unset
LOOP_STELLAR_GBPLOOP_ISSUER=                  # unset
LOOP_STELLAR_EURLOOP_ISSUER=                  # unset
LOOP_STELLAR_USDC_ISSUER=                     # unset
INTEREST_APY_BASIS_POINTS=0                   # default
LOOP_INTEREST_POOL_ACCOUNT=                   # unset
EMAIL_PROVIDER=                               # unset (refused in production by getEmailProvider, that's correct)
```

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

3. **Buy**
   - Pick merchant (e.g. Amazon US showing "Save 4%")
   - Pick amount (say $25)
   - Confirm → see deposit address + XLM amount + memo
   - Send XLM from any wallet
   - Order moves: `pending_payment → paid → procuring → fulfilled`
   - Gift card code + barcode appear

4. **Redeem**
   - Tap "Reveal code" → copy code or scan barcode at merchant
   - Confirm balance lands on merchant's app/site

5. **Operator-side verification**
   - `/health` returns `200`, `databaseReachable: true`, no degraded workers
   - `/admin` (admin-only) shows the order in `/admin/orders`
   - Discord `#orders` channel posted "Order created" + "Order fulfilled"
   - Sentry has zero unhandled errors during the smoke test

---

## USDC and Tranche 1

The deliverable says "Purchase a discounted giftcard with **XLM/USDC**". USDC support requires Loop-native rails (Loop is merchant of record; USDC arrives at Loop's deposit address; Loop pays CTX in XLM after FX). The legacy CTX-proxy flow is XLM-only.

Realistic options:

1. **Tranche 1a (XLM-only) + Tranche 1b (USDC)** — ship XLM first, add USDC behind a follow-up flag (LOOP_AUTH_NATIVE_ENABLED + workers + a real email provider). USDC is a v1.0.x update, not a rebuild.
2. **Wire USDC at launch** — requires standing up a real email provider (currently only the `console` stub exists, refused in production), funding the operator account, and configuring USDC issuer env vars. Material extra operator setup.

**Recommendation:** ship 1a, then 1b within a few weeks. The deliverable text reads "XLM/USDC" but the acceptance criteria say "Purchase a discounted giftcard with XLM/USDC" — XLM-only meets one of those at launch, USDC follows.

---

## What flipping the flag back does

When you're ready for Tranche 2 (Stellar passkey wallet + cashback + DeFindex):

```bash
LOOP_PHASE_1_ONLY=false                       # web client immediately shows Phase 2 surfaces
```

Then independently turn on:

```bash
LOOP_AUTH_NATIVE_ENABLED=true
LOOP_WORKERS_ENABLED=true
LOOP_STELLAR_DEPOSIT_ADDRESS=G…
LOOP_STELLAR_OPERATOR_SECRET=S…
LOOP_STELLAR_USDLOOP_ISSUER=G…
# (etc.)
INTEREST_APY_BASIS_POINTS=350                 # 3.5% APY
EMAIL_PROVIDER=resend                         # or whichever real provider lands first
```

Web client picks up the flag flip on the next `GET /api/config` (10-min cache). Mobile clients re-fetch on app foreground.

No app store resubmission required.
