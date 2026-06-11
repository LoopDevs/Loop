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
- `LinkWalletNudge` (the "earned cashback, link your wallet" prompt) → renders nothing in T1; **fully retired in T2** by ADR 030 (Privy auto-provisions; no link UX needed)
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
LOOP_STELLAR_USDC_ISSUER=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN   # Centre USDC mainnet
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
LOOP_STELLAR_GBPLOOP_ISSUER=                  # unset — no GBPLOOP issuance in T1
INTEREST_APY_BASIS_POINTS=0                   # default — no nightly interest mint
LOOP_INTEREST_POOL_ACCOUNT=                   # unset — no pool
PRIVY_APP_ID=                                 # unset — Privy not integrated until T2 (ADR 030)
LOOP_USD_VAULT_ADDRESS=                       # unset — DeFindex curator vault not deployed until T2 (ADR 031)
LOOP_EUR_VAULT_ADDRESS=                       # unset — same
```

USDLOOP and EURLOOP issuer envs are gone entirely — those assets are retired by ADR 031 (users hold LOOPUSD/LOOPEUR vault shares directly, not Loop-issued 1:1 stablecoin wrappers).

The discount path doesn't emit on-chain assets, so leaving these unset is correct. When Tranche 2 lands the operator: deploys LOOPUSD/LOOPEUR vaults + sets vault env vars; configures GBPLOOP issuer + `INTEREST_APY_BASIS_POINTS=300` for 3% APY; signs Privy production contract + sets `PRIVY_APP_ID`; flips `LOOP_PHASE_1_ONLY=false`. Cashback that's currently delivered as a discount starts emitting to user wallets via the appropriate per-currency mechanism.

For the web build:

```bash
VITE_API_URL=https://api.loopfinance.io
VITE_SENTRY_DSN=…
VITE_SENTRY_RELEASE=$(git rev-parse HEAD)
VITE_LOOP_ENV=production
```

The web client reads `phase1Only` from `GET /api/config` at runtime, so flipping this flag does NOT require an app store resubmission.

---

## Release sequence — Phase 1 acceptance path

How to get from repo-state to TestFlight + APK + demo video. Five
tracks; three of them parallelize once Track 3 (Apple Developer
approval) is filed. Detailed mechanics live in `docs/deployment.md`
and per-package AGENTS.md guides — this section is the linear
checklist.

### Track 1 — Backend deploy (`loopfinance-api`)

The Fly app exists and is healthy, but its currently-deployed binary
pre-dates the Tranche-1 surface (`/api/config` returns 404, no
Loop-native auth path) and has only five secrets set
(`DISCORD_WEBHOOK_*`, `GIFT_CARD_API_KEY/SECRET`, `SENTRY_DSN`).
Tranche 1 needs the full env block from "Operator env" above.

> **Read first:** `docs/phase-1-redeploy-audit.md` — every change
> between the deployed 2026-04-20 binary and current `main`. Lists
> all the boot-time gates that have been added since (DATABASE_URL,
> EMAIL_PROVIDER=resend, etc), the 33 SQL migrations that will run
> on first deploy, and the four operator action items the
> preflight script does NOT catch on its own.

Set secrets via:

```bash
# Required for Tranche 1 acceptance flow
flyctl secrets set -a loopfinance-api \
  LOOP_PHASE_1_ONLY=true \
  LOOP_AUTH_NATIVE_ENABLED=true \
  LOOP_WORKERS_ENABLED=true \
  LOOP_JWT_SIGNING_KEY="$(openssl rand -base64 48)" \
  LOOP_STELLAR_DEPOSIT_ADDRESS=G… \
  LOOP_STELLAR_OPERATOR_SECRET=S… \
  LOOP_STELLAR_USDC_ISSUER=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN \
  EMAIL_PROVIDER=resend \
  RESEND_API_KEY=re_… \
  EMAIL_FROM_ADDRESS=noreply@loopfinance.io \
  EMAIL_FROM_NAME=Loop \
  METRICS_BEARER_TOKEN="$(openssl rand -base64 32)" \
  OPENAPI_BEARER_TOKEN="$(openssl rand -base64 32)" \
  DATABASE_URL=postgres://…

flyctl deploy -a loopfinance-api --config apps/backend/fly.toml
```

Verify: `curl https://loopfinance-api.fly.dev/api/config` returns the
runtime config (not 404), `/health` reports
`upstreamReachable:true` + every required worker `running:true`.
Once `api.loopfinance.io` DNS lands (Track 2), repeat against the
canonical hostname.

### Track 2 — Web deploy (`loopfinance-web` — first time)

`apps/web/fly.toml` is configured but the app does not exist on Fly
yet. First-time bootstrap:

```bash
flyctl apps create loopfinance-web
flyctl secrets set -a loopfinance-web   # nothing required at runtime, but Sentry DSN goes here
flyctl deploy -a loopfinance-web --config apps/web/fly.toml \
  --build-arg VITE_SENTRY_DSN=… \
  --build-arg VITE_LOOP_ENV=production \
  --build-arg VITE_SENTRY_RELEASE=$(git rev-parse HEAD)
```

DNS:

| Hostname             | Target                  | Notes                                         |
| -------------------- | ----------------------- | --------------------------------------------- |
| `loopfinance.io`     | loopfinance-web Fly app | Apex — Fly issues TLS automatically.          |
| `www.loopfinance.io` | loopfinance-web Fly app | CNAME or apex-flatten depending on registrar. |
| `api.loopfinance.io` | loopfinance-api Fly app | CNAME `loopfinance-api.fly.dev`.              |

The web client reads `VITE_API_URL` from build args (currently
`https://api.loopfinance.io`), so the api hostname must be live before
the production web bundle is shipped or the SPA can't reach the
backend.

### Track 3 — Apple Developer + bundle ID + TestFlight

The long pole — Apple Developer enrollment can take 3–7 days for a
personal account, longer if D-U-N-S verification is needed for an
Organization account. **File this on Day 1.**

While waiting:

- Register bundle ID `io.loopfinance.app` in the dev portal (post-approval).
- Create the App Store Connect app entry (metadata only; no submission
  for review yet — TestFlight internal testing skips Beta App Review).
- Privacy policy URL: point at `https://loopfinance.io/privacy`. The
  page is wired with placeholder copy; legal review can land before the
  public App Store submission.

Once approved, build + archive:

```bash
cd apps/web && npm run build:mobile
cd ../.. && npm run mobile:sync         # wraps cap sync + apply-native-overlays.sh
cd apps/mobile && npx cap open ios
```

In Xcode:

1. Project navigator → App target → Signing & Capabilities → set Team.
2. Project navigator → App target → Build Settings → Configurations →
   Release → set `baseConfigurationReference` to `release.xcconfig`
   (one-time; `cap sync` does not regenerate the .pbxproj so the
   reference survives. Pins `CAPACITOR_DEBUG = false` for App-Store
   builds — see ADR comment in `apps/mobile/native-overlays/ios/release.xcconfig`).
3. Set marketing version (`1.0.0`) and build number (CI run number — see
   "Version-bump discipline" in `docs/deployment.md`).
4. Product → Archive → Distribute App → App Store Connect → Upload.

In App Store Connect → TestFlight tab:

- Wait for processing (~15min — DKIM-style background).
- Add internal testers (up to 100, no Beta App Review needed).
- Reviewers receive an email invite and install via the TestFlight app.

### Track 4 — Android signed APK

The repo now ships a `signing.gradle` overlay that injects
`signingConfigs.release` into the Capacitor-generated build.gradle
when a `keystore.properties` file is present.

One-time keystore generation (back this up — losing the keystore means
losing Play Store package identity permanently):

```bash
cd apps/mobile/android
keytool -genkeypair -v \
  -keystore loop-release.keystore \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias loop
# Answer the prompts for cert details + passwords.
# Back up loop-release.keystore + the passwords to 1Password (sealed) +
# offline cold storage.

cp keystore.properties.example keystore.properties
# Edit keystore.properties and fill in the passwords + alias.
# Both keystore.properties AND loop-release.keystore are gitignored
# (apps/mobile/android/ is ignored at the repo root).
```

Build the signed APK:

```bash
cd apps/web && npm run build:mobile
cd ../.. && npm run mobile:sync
cd apps/mobile && npx cap open android
```

In Android Studio:

- Build → Generate Signed Bundle / APK → APK → Release variant.
- Output: `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`.
- For Play Store submission later, switch to AAB. APK is sufficient for
  the Phase 1 sideload deliverable (direct link, Drive, Diawi).

If `keystore.properties` is absent, `signing.gradle` logs a Gradle
warning and the release variant builds unsigned — useful for local
smoke tests but not shippable.

### Track 5 — Demo video

Cost ≈ one real gift-card purchase. Use $5–$10 denomination if
available; the test wallet (`reference_test_wallet.md`) is funded for
this. Script:

1. Install — TestFlight on iOS, APK sideload on Android.
2. First-run onboarding — splash → welcome → "How it works" → email →
   OTP → biometric setup → home (currency + wallet steps auto-skipped
   under `LOOP_PHASE_1_ONLY=true`).
3. Browse + map + search.
4. Pick merchant → amount → confirm → see Loop's deposit address +
   memo + discounted XLM/USDC amount.
5. Pay from external wallet to that address with the memo.
6. Watch order: `pending_payment → paid → procuring → fulfilled`.
7. Reveal gift card code + barcode.
8. Redeem at the merchant (in-store scan or online code paste).

Recording: iOS Control Center → Screen Recording; Android Quick
Settings → Screen Record. Voiceover added later in QuickTime / video
editor. Target ~10–15 minutes.

### Critical-path order

- **Day 1:** File Apple Developer enrollment (Track 3 is the long pole);
  start Track 1 (backend redeploy) and Track 2 (web first-deploy + DNS) in
  parallel.
- **Day 2–7 (waiting on Apple):** Generate keystore + build signed APK
  (Track 4); smoke-test Tranche 1 acceptance against the redeployed
  backend with the test wallet.
- **Apple approves:** Configure signing in Xcode, archive, upload to
  TestFlight, add reviewers as internal testers.
- **+1 day:** Verify both binaries install + run on fresh devices.
- **+1 day:** Record the demo video (Track 5).

Total: ~5 days if Apple Developer is already approved on a team Loop
controls; ~10 days if approval is the long pole.

### Out of Phase-1 scope (deferred)

- Privacy/terms copy review — placeholder copy is wired into both
  routes; legal review before the public App Store submission, not
  before TestFlight internal testing.
- Sentry / Discord plumbing — DSNs go in Fly secrets when ready; code
  is wired and gated on env presence (silent if unset).
- Real-CTX e2e tests in CI — mocked-CTX suite gates main; real-upstream
  contract check stays PR-only.
- Play Console submission ($25 one-time, AAB upload, internal-testing
  track) — APK + Diawi is sufficient for the Phase 1 reviewer flow.

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

## What Tranche 2 looks like (post-2026-05-05 design — ADR 030 + 031)

**The earlier "Stellar passkey wallet" framing for Tranche 2 is retired** — see decision-history sections of ADR 030 (wallet model) and ADR 031 (per-currency yield architecture). The actual T2 surface is:

- **Privy-provisioned embedded wallet** (with dfns as documented fallback) keyed on Loop's user_id. Cross-platform identity-bound; single auth login also authenticates Privy via Custom Auth Provider.
- **LOOPUSD and LOOPEUR**: Loop-curated DeFindex vault shares (Soroban). User's wallet holds the vault share token directly. Vault routes USDC/EURC into Blend lending pools. 0% mgmt + 50% perf fee captures Loop's revenue on-chain.
- **GBPLOOP**: 1:1-backed Stellar classic asset. 3% APY paid as **nightly on-chain GBPLOOP mints** to holders. Loop's treasury invests GBP backing wherever yields best (UK base rate, MMF, gilts) and pockets the spread.
- **USDLOOP and EURLOOP retired**: users hold native vault shares (LOOPUSD/LOOPEUR) instead of Loop-issued 1:1 stablecoins for USD/EUR. Only GBPLOOP remains as a Loop-issued 1:1-backed token.
- **APY display**: past-30-day realised rate per asset with "no guarantee of future performance" disclaimer. No yield-source/strategy disclosure to users.

Effect on the order pricing model on flag flip:

- Tranche 1 (`LOOP_PHASE_1_ONLY=true`): user pays `chargeMinor − userCashbackMinor`, no on-chain emission, cashback delivered as instant discount.
- Tranche 2 (`LOOP_PHASE_1_ONLY=false`): user pays full `chargeMinor`, cashback emitted to user's Privy wallet as the home-currency LOOP-asset (LOOPUSD vault share, LOOPEUR vault share, or GBPLOOP).

Same `merchant_cashback_configs` rows; the env flag swaps the delivery channel. Existing T1 orders aren't migrated — they stay as discounted; T2-and-after orders earn cashback to the user's Privy wallet.

Web + mobile clients pick up the flag flip on the next `GET /api/config` (10-min cache). Mobile clients re-fetch on foreground. **No app store resubmission required.**

Critical-path DD before T2 ships:

1. Privy Soroban token custody — verify before signing the Privy contract (or fall back to dfns)
2. DeFindex curator vault audit — $30–80k, 4–8 weeks
3. ~~UK GBP custodian/BaaS partner for GBPLOOP backing~~ **Resolved**: Revolut Business. Treasury yield product selection (Flexible Cash Funds vs gilts vs other) + Revolut Business API integration for Faster Payments off-ramp still need scoping but are below DD-blocker level.
4. Multi-jurisdictional regulatory review (bundled): vault curation + GBPLOOP issuance + Privy custody — 4–6 weeks counsel
