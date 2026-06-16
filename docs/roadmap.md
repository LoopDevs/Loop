# Roadmap

What remains to ship Loop and what comes after.

The original migration plan (now at `docs/archive/migration.md`, historical only) covered getting the monorepo to a working state. This document tracks what's left to reach production and beyond.

## Deliverable tranches

The contract-level deliverables are tracked as three tranches:

- **Tranche 1 — MVP.** Cross-platform mobile app for crypto gift card purchases. Discounted gift cards (NOT cashback). Crypto checkout. US/Europe/Canada/UK coverage. Acceptance: install from app stores/TestFlight, purchase a discounted gift card with XLM (USDC follow-on, see runbook), redeem at merchant. Operator runbook + flag matrix in [`tranche-1-launch.md`](./tranche-1-launch.md).
- **Tranche 2 — Testnet.** Integrated Stellar passkey wallet, gift cards award cashback (replacing the discount model), Defindex testnet yield. Acceptance: install testnet build, purchase mock gift card, verify cashback to Stellar testnet wallet, verify yield from held funds.
- **Tranche 3 — Mainnet.** Plaid SDK for open-banking USD/GBP/EUR/CAD payments, mainnet, virtual cashback Visa/Mastercard, full Stellar passkey wallet (Secp256r1 / derived Ed25519). Acceptance: real bank/crypto purchase, real gift-card redemption, verify cashback + USDC yield receipt.

The Phase 1 / Phase 2 / Phase 3 sections below are the engineering-level decomposition that backs those tranches — same code, finer-grained granularity. Tranche 1 ≈ Phase 1; Tranche 2 ≈ Phase 2; Tranche 3 ≈ extended Phase 2 + Phase 3. The web client gates Phase 2 surfaces behind `LOOP_PHASE_1_ONLY=true` so Tranche 1 launches without a Tranche 2 surface bleed; flipping to `false` later is server-side only, no app-store resubmission.

Known limitations we are **consciously not fixing** in the current phase are tracked separately in [ADR-005 — Known Limitations](adr/005-known-limitations.md). Check there before filing a bug for Stellar, barcode redemption, `eslint-plugin-react`, distributed rate limiting, DNS rebinding, probe timeouts, jsdom coverage, proto drift, metrics scraping, third-party fonts / tile hosts, or upstream token passthrough.

---

## Audit remediation (in flight)

The 2026-06-11 comprehensive audit ([`docs/comprehensive-audit-2026-06-11.md`](./comprehensive-audit-2026-06-11.md)) is the live findings register; its **Part IV** is the sequenced remediation plan currently in execution. Roadmap items below defer to Part IV's sequencing where they overlap (notably the ADR 035 order-path work and the redemption-null backfill).

## Orphaned-work register (2026-06-11)

Items flagged in past sessions or audits that previously had **no home in any forward-looking document**. Each stays here until it is either scheduled (move into a phase/tranche checklist with an owner) or explicitly declined (record the decision, dated).

- [ ] **Redemption-null backfill** — pre-public-order-traffic blocker, flagged 2026-05-14: the validated e2e order fulfilled but `redeemUrl/Code/Pin` came back false (CTX-side delay or `fetchRedemption` swallowing an error), plus the related `Body has already been read` polling-fallback bug. Comprehensive audit P1 #10. Must be resolved (and added to the Tranche-1 acceptance checks) before public order traffic.
- [ ] **`loopfinance-web` first deploy + DNS** — listed in three checklists (this roadmap, `tranche-1-launch.md` Track 2, `phase-1-while-apple-approves.md` B.1); no document records whether it ever happened. Verify, record the outcome, and tick or schedule.
- [ ] **Android keystore escrow** — losing the upload keystore means losing Play Store package identity permanently. Both launch runbooks say "back it up to 1Password", but the operator does not use 1Password. Document an escrow/offline-backup procedure that doesn't assume it, before keystore generation.
- [ ] **GeoLite2 refresh cadence** — the `.mmdb` refreshes only on deploys that remember the MaxMind build secrets, and the download is best-effort (a build without the secrets silently falls back to the US default — a quiet degradation of the ADR 034 geo-redirect). Define a refresh cadence and/or a staleness signal (`docs/deployment.md` §GeoLite2).
- [ ] **Thin-currency promotion process** — ADR 035 leaves ~20 catalogue-only currencies below the ≥15-merchant threshold "revisited as the catalogue grows", with no review cadence or owner. Define the cadence (e.g. quarterly with the supplier-catalogue sweep); promoting one is a one-line `countries.ts` addition.
- [x] ~~**ADR 027 trigger review — decision needed**~~ — _Decided 2026-06-16 (CF-36 / cold-audit-2026-06-15 M-03)._ Binary-tamper detection's Phase-2 trigger ("distribution path moves outside the official stores") is met by the controlled, reviewer-only Phase-1 APK sideload. **Deferral re-accepted for Phase 1** — the sideload is a closed beta channel, not a public out-of-store install, and the tamper threat at that scale is self-inflicted and fenced by the other live controls. The trigger re-arms for Phase 2 the moment distribution becomes a genuinely public out-of-store channel (public download link, web-install, enterprise/MDM). The other three controls (SSL pinning, App Attest / Play Integrity, jailbreak-root) were re-checked on the same review — none of their triggers have fired. Full rationale + re-armed triggers in `docs/adr/027-mobile-platform-security.md` §"2026-06-16 trigger review".

---

## Phase 1 — Gift card purchases (XLM)

### Remaining setup tasks

- [x] ~~Run `npx buf generate`~~ — proto schema created, types generated to `packages/shared/src/proto/`
- [x] ~~Add `.env` files~~ — created from `.env.example`
- [x] ~~Run `npx cap add ios && npx cap add android`~~ — native projects created
- [x] ~~Install Playwright browsers~~ — chromium installed
- [x] ~~Set GitHub repo secrets for CI~~ — no **CTX API** secrets needed (upstream `/merchants`, `/login`, `/verify-email`, `/refresh-token` are public). Other workflow secrets that **do** need to be set when enabling the relevant workflow: `LOOP_E2E_REFRESH_TOKEN` + `STELLAR_TEST_SECRET_KEY` + `LOOP_JWT_SIGNING_KEY` + `LOOP_STELLAR_DEPOSIT_ADDRESS` + `LOOP_STELLAR_OPERATOR_SECRET` + `GH_SECRETS_PAT` (rotates the refresh token back to Actions secrets after each run) for `e2e-real.yml` (Tranche-1 loop-native purchase flow); `DISCORD_WEBHOOK_DEPLOYMENTS` for the CI-status notify job; `ANTHROPIC_API_KEY` for the Claude PR-review job.
- [x] ~~Set up GitHub branch protection rules on `main`~~ — done once the repo went public (A-037 closed). Required passing checks: Quality, Unit tests, Security audit, Build verification, E2E tests (mocked CTX); force-push and branch deletion blocked; stale reviews dismissed on new commits. See `docs/standards.md §15 CI/CD` for the ruleset and `gh api repos/LoopDevs/Loop/branches/main/protection` for the live config.

### Production infrastructure

- [x] ~~Deploy backend to Fly.io~~ — deployed and validated end-to-end on 2026-05-14: the `e2e-real` workflow drove an Aerie $0.02 XLM order `pending_payment → paid → procuring → fulfilled` against the deployed `api.loopfinance.io` (see `docs/deployment.md`)
- [ ] Deploy web (SSR) to Fly.io — `loopfinance-web` first-deploy **status unrecorded** (appears in three checklists, none with an outcome); verify with `flyctl status -a loopfinance-web` and record the result here. Tracked in §Orphaned-work register below.
- [x] ~~Set `IMAGE_PROXY_ALLOWED_HOSTS` in production backend~~ — now enforced at boot (audit A-025); `apps/backend/fly.toml` ships with the CTX hostnames baked in.
- [ ] Set up monitoring / error tracking — **code side wired**: backend uses `sentry()` middleware gated on `env.SENTRY_DSN` (`app.ts`); web calls `Sentry.init` on the client gated on `VITE_SENTRY_DSN` (`root.tsx`, with `browserTracingIntegration`, `tracesSampleRate: 0.1` in prod). **Operator side remaining**: set `SENTRY_DSN` in Fly secrets + `VITE_SENTRY_DSN` in the web build args.
- [x] ~~Configure production CORS allowlist~~ — already set in `apps/backend/src/app.ts` (`PRODUCTION_ORIGINS` includes `loopfinance.io`, `www.loopfinance.io`, and the Capacitor native origins `capacitor://localhost` / `https://localhost` / `http://localhost`; dev allows `*`).
- [x] ~~DNS: `api.loopfinance.io` → backend deployment~~ — live and serving since the 2026-05-14 validation
- [ ] DNS: point `loopfinance.io` / `www.loopfinance.io` → web deployment (blocked on the `loopfinance-web` first deploy above; apex/www stay parked on GitHub Pages until public launch)
- [ ] TLS certificates (automatic via Fly.io / Vercel)

### Code hardening (before connecting to real upstream)

- [x] ~~**Validate upstream responses with Zod**~~ — auth and order handlers now validate all upstream JSON with Zod schemas before forwarding.
- [x] ~~**Reject orders for unknown merchants**~~ — returns 404 if merchantId not in cache.
- [x] ~~**Add rate limiting**~~ — per-IP across every public and authenticated endpoint the roadmap originally scoped plus those added later: `/api/image` (300/min), `/api/clusters` (60/min), `/api/auth/request-otp` (5/min), `/api/auth/verify-otp` (10/min), `/api/auth/refresh` (30/min), `DELETE /api/auth/session` (20/min), `POST /api/orders` (10/min), `GET /api/orders` (60/min), `GET /api/orders/:id` (120/min). In-memory limiter with hourly cleanup, 10k-entry cap with insertion-order (FIFO) eviction once the cap is reached, 429 responses include `Retry-After`. IP source is `TRUST_PROXY`-gated (audit A-023).
- [x] ~~**Map upstream response fields to our types**~~ — Zod schemas validate and strip upstream responses. Order ID param sanitized against path traversal.
- [x] ~~**Use `expiresAt` in PaymentStep**~~ — shows live countdown timer, stops polling at expiry.
- [x] ~~**Remove `savingsBips` field**~~ — removed from shared types and backend sync.

### Code hardening (before production)

- [x] ~~**Add upstream health to `/health` endpoint**~~ — probes upstream `/status`, reports `degraded` when unreachable or data is stale.
- [x] ~~**Test merchant sync error paths**~~ — pagination, error recovery, disabled merchants, denominations, concurrent guard (7 tests).
- [x] ~~**Test location sync error paths**~~ — pagination, error recovery, NaN coords, disabled locations, concurrent guard (5 tests).
- [x] ~~**Test image proxy SSRF validation**~~ — localhost, loopback, private ranges, IPv6, allowlist, HTTPS enforcement (9 tests).
- [x] ~~**Test order proxy upstream behavior**~~ — unknown merchant, bad response shape, 401, success validation, path traversal, query passthrough (7 tests).
- [x] ~~**Add request correlation logging**~~ — Hono `requestId()` middleware adds `X-Request-Id` to all requests.

### Upstream API integration

- [x] ~~Obtain production credentials~~ — no credentials needed; upstream API is public
- [x] ~~Validate order creation flow end-to-end with real credentials~~ — tested with real CTX Bearer token, orders created successfully
- [x] ~~Confirm merchant sync pagination works with full catalog~~ — 117 merchants across 12 pages
- [x] ~~Confirm location data sync and clustering against real data~~ — 116,219 locations, clustering verified at multiple zoom levels
- ~~Test gift card barcode/PIN retrieval in purchase flow~~ — **deferred to Phase 2**: the upstream-response zod shape in `apps/backend/src/orders/handler.ts` (`GetOrderUpstreamResponse` + `getOrderHandler`'s construction block) maps `redeemUrl` / `redeemUrlChallenge` / `redeemScripts` but has no `giftCardCode` field; see ADR-005 §2 for the full rationale. The rendering side (`PurchaseComplete.tsx` + `jsbarcode`) is done and covered by unit tests, so there's nothing to test in Phase 1 until the backend populates `giftCardCode`.

### Brand & design

- [x] ~~Create core Loop brand assets~~ — `loop-logo.svg`, `loop-logo-white.svg`, `loop-favicon.svg`, `loop-favicon.ico`, `loop-favicon.png` live in `apps/web/public/` and are wired into `root.tsx`, `Navbar`, `Footer`, `auth`, and the app-lock overlay.
- [x] ~~Create marketing `hero.webp`~~ — 1400×700 VP8 webp at `apps/web/public/hero.webp`, sourced from `beta.dashspend.com/hero.webp`. Wired in `apps/web/app/routes/home.tsx` as the LCP candidate (preload link + `background-image` style on the hero stack).
- [x] ~~Integrate assets into web app (`apps/web/public/`)~~ — core assets referenced from every surface above.
- [ ] Configure splash screen assets for iOS and Android
- [ ] App icon for iOS (1024x1024) and Android (512x512)

### Web localisation & market coverage (shipped 2026-06)

The June 2026 web workstream — previously untracked here — shipped:

- [x] ~~Merchant variant grouping~~ — ADR 032: client-side brand grouping via `@loop/shared` name parsing (1,134 tiles → 982 groups).
- [x] ~~IP-geolocation region first-guess~~ — ADR 033: MaxMind GeoLite2 + `/api/public/geo` (superseded as the routing model by ADR 034; still feeds the `/` geo-redirect).
- [x] ~~Path-based locale routing~~ — ADR 034, phases 1–5 shipped across PRs #1401–#1406: `/:country/:lang` URLs, SSR geo 302 at `/`, per-country SEO (self-canonicals + reciprocal hreflang sitemap), locale-routed public links, region-store retirement.
- [x] ~~Extended supplier-currency display markets~~ — ADR 035, merged in PR #1408: AE/IN/SA/AU/MX surfaced as display-only countries (≥15-merchant threshold). **Follow-up open**: order-path support for extended-market currencies (currency CHECKs + loop-handler) is tracked in `docs/comprehensive-audit-2026-06-11.md` Part IV, Phase 3; ~20 thinner catalogue-only currencies await the promotion process in §Orphaned-work register below.

### Mobile app submission

> **Operator runbook:** the linear, click-by-click sequence for
> claiming the Phase-1 deliverable (TestFlight + APK + demo video) is
> in `tranche-1-launch.md` §"Release sequence — Phase 1 acceptance
> path". This roadmap section is the bullet-level checklist; the
> runbook section is the actionable path.

- [ ] Build and test on physical iOS device
- [ ] Build and test on physical Android device
- [x] ~~iOS app icon (1024x1024) + splash screens~~ — Loop wordmark on near-black; lives at `apps/mobile/native-overlays/ios/App/App/Assets.xcassets/{AppIcon.appiconset,Splash.imageset}` and re-applies on every `cap sync` via `apply-native-overlays.sh`. Matches Android branding.
- [x] ~~Android app icon (512x512) + adaptive icon + splash~~ — already in `apps/mobile/native-overlays/android/`.
- [x] ~~Android signed-APK build wiring~~ — `signing.gradle` overlay drives `signingConfigs.release` from operator-supplied `keystore.properties`. Falls back to unsigned with a Gradle warning if keystore is absent (release builds still buildable for local smoke). Keystore generation steps in `tranche-1-launch.md`.
- [ ] Apple Developer account setup, bundle ID `io.loopfinance.app`
- [ ] Google Play Console setup, package name `io.loopfinance.app`
- [ ] App Store screenshots and metadata
- [ ] Play Store screenshots and metadata
- [ ] Privacy policy and terms of service pages on `loopfinance.io` — **code side wired** (#662): React Router routes at `/privacy` + `/terms`, Footer links, sitemap.xml entries, SSR meta + canonical tags. Each page carries a yellow "pending legal review" banner over a placeholder outline. **Operator side remaining**: legal review of the placeholder copy, final wording drop-in, provision `privacy@` / `legal@` / `hello@loopfinance.io` mailboxes referenced in the copy.
- [ ] Submit to App Store review
- [ ] Submit to Play Store review

### Phase 1 exit criteria

- [ ] Web app live at `loopfinance.io`
- [ ] Backend API live at `api.loopfinance.io`
- [ ] iOS app approved and in App Store
- [ ] Android app approved and in Play Store
- [ ] Users can: sign up with email → browse merchants → buy gift card with XLM → view gift card code/barcode
- [ ] Map view shows merchant locations with clustering
- [ ] CI pipeline green on `main`
- [ ] Monitoring and error tracking operational

---

## Phase 2 — Integrated wallet, cashback, yield

Phase 2 has been reshaped twice. First, mid-2026, into the **ADR 015 / 016 cashback-app switch** (Loop-as-merchant-of-record, CTX as supplier, LOOP-branded stablecoins, admin panel). Second, in the 2026-05-05 design session, into the **integrated wallet + per-currency yield** topology now captured in ADR 030 (Privy embedded wallet, with dfns documented as fallback) + ADR 031 (LOOPUSD / LOOPEUR as Loop-curated DeFindex vault shares; GBPLOOP as 1:1-backed Stellar classic asset with nightly 3% APY mints; treasury captures spread).

The earlier "link external wallet" model from ADR 015 is **retired** by ADR 030. USDLOOP and EURLOOP are **retired** by ADR 031 — users hold canonical USDC/EURC routed into Loop's curated vaults via the LOOPUSD/LOOPEUR vault-share tokens. GBPLOOP **stays** as the only Loop-issued 1:1-backed stablecoin, with a nightly on-chain 3% APY mint funded by treasury spread on backing reserves.

That work is code-complete on the original ADR 015 surface; the new ADR 030 + 031 work is **not yet started** and is what Phase 2 ships next. Items below are either shipped on the original surface or explicit "not yet started" on the new surface.

### Cashback app switch — ADR 015/016 (shipped across #330 — #366)

- [x] ~~Home-currency data model~~ — `users.home_currency` column (#331),
      `user_credits` composite-key ready for multi-balance users.
- [x] ~~Order creation FX-pin~~ — `charge_minor` + `charge_currency`
      pinned via Frankfurter feed at creation (#336); cross-FX ledger
      refactor so GBP users on USD catalog orders credit in GBP (#353).
- [x] ~~LOOP-asset payout path~~ — `pending_payouts` table (#347),
      fulfillment writes the payout intent (#348), `@stellar/stellar-sdk`
      submit primitive (#355), worker loop with memo-idempotent
      retry (#356).
- [x] ~~Procurement USDC-default + XLM-floor fallback~~ — live Horizon
      USDC balance read (#342) + floor-triggered break-glass (#340 /
      #344) + Discord alert on below-floor (#361).
- [x] ~~Watcher LOOP-asset allowlist~~ — USDLOOP / GBPLOOP / EURLOOP
      accepted alongside USDC + XLM (#338).
- [x] ~~Onboarding currency picker~~ — locale-guessed default, user
      confirms (#357).
- [x] ~~User wallet-link settings~~ — `/settings/wallet` page (#362),
      discoverable from the Account page (#366).
- [x] ~~Admin treasury view~~ — LOOP-asset liabilities, USDC + XLM
      held assets, payout state counts with link-through to drilldown
      (#337, #343, #349, #358, #364).
- [x] ~~Admin payouts drilldown + retry~~ — filtered list (#350 / #359)
      with per-row retry button wrapping `resetPayoutToPending` (#351).
- [x] ~~Ops real-time observability~~ — Discord alert on payout failed
      (#360) + below-floor (#361) with throttling + classified `kind`.
- [x] ~~ADR status: Accepted~~ — rollout checklists all ticked (#365).

### New work — ADR 030 + 031 (not yet started, 2026-05-05 design)

- [ ] **Privy integration** (ADR 030). RS256 JWT migration + JWKS publish endpoint, Privy SDK Custom Auth Provider wiring, webhook for `users.stellar_address`. Fallback path to dfns documented if Privy DD fails on Soroban.
- [ ] **LOOPUSD vault** (ADR 031). Loop-curated DeFindex vault contract, USDC backing routed to Blend USDC pool, 0% mgmt + 50% perf fee. Audit on the vault contract is critical-path.
- [ ] **LOOPEUR vault** (ADR 031). Same structure with EURC + Blend EURC.
- [ ] **GBPLOOP nightly mint cron** (ADR 031). 3% APY paid as on-chain GBPLOOP mints to holders nightly. Idempotent via `gbploop_interest_payments` table.
- [ ] **Treasury spread management** (ADR 031). Operator-side investment of USDC/EURC backing into vaults + GBP fiat into UK custodian/MMF/gilts. Hot float per currency for instant withdrawals.
- [ ] **Past-30-day APY computation + display** (ADR 031). On-chain share-price history for vaults + on-chain mint history for GBPLOOP, surfaced as "past 30 days: X.XX%" with "no guarantee of future performance" disclaimer.
- [ ] **Asset rename: USDLOOP and EURLOOP retired**. Code references retired; never issued in production.
- [ ] **Privy/dfns Soroban DD** (critical-path). Verify vendor Soroban token custody before signing contracts.
- [ ] **Multi-jurisdictional regulatory review** (bundled). LOOPUSD/LOOPEUR vault curation + GBPLOOP issuance + Privy custody. 4–6 weeks of crypto-fintech counsel.
- [x] ~~UK GBP banking partner~~ — **Revolut Business** (resolved 2026-05-05). Treasury yield product selection (Flexible Cash Funds vs gilts) and Revolut Business API integration for Faster Payments off-ramp remain as scoping work but are not DD blockers.

### Deferred from original ADR 015 (no longer in scope)

- [ ] Multi-home-currency per user — UX still not built; launch users hold one home currency. Schema supports composite key.
- [ ] In-app LOOP-asset swap — out of scope for MVP; deferred entirely.
- [x] ~~Admin-mediated home-currency change~~ — `POST /api/admin/users/:userId/home-currency` (2026-05-04). Step-up gated; preflight rejects if the user has a non-zero credit balance in the old currency or any in-flight payouts.
- [ ] SEP-24 / off-platform withdrawal UX for LOOP assets — replaced by Privy-native withdraw flow per ADR 030 (Privy server signs LOOP-asset transfer, Loop redeems and pays canonical asset / fiat to destination).
- [x] ~~Trustline-probe before payout submit~~ — Privy provisions trustlines automatically per ADR 030; old probe logic obsolete.
- [ ] Hardware signing (HSM) for the operator secret — software signing adequate for launch volume.
- [ ] **External wallet linking** (`/settings/wallet` PUT endpoint, `LinkWalletNudge`, `TrustlineSetupCard`) — **retired by ADR 030**. The "user pastes their Stellar pubkey" model is replaced by Privy-provisioned wallets keyed on user_id.

### Authentication upgrades

- [x] ~~Social login — Google + Apple~~ — ADR 014; shipped via
      `/api/auth/social/google` and `/api/auth/social/apple`.
- [x] ~~Loop-owned OTP auth~~ — ADR 013; backend mints its own
      JWTs against the CTX operator pool when
      `LOOP_AUTH_NATIVE_ENABLED=true`.
- [x] ~~Login gate — require auth before any purchase~~ — `PurchaseContainer` renders the inline email/OTP flow when the store has no access token.
- [x] ~~Session persistence across app restarts (refresh token flow)~~ — `use-session-restore` hook restores on mount by pulling the refresh token from secure storage (Keychain on iOS, EncryptedSharedPreferences on Android, sessionStorage on web) and calling `tryRefresh`. Audits A-008 / A-020 / A-024 and ADR-006 cover the storage and recovery paths.

### Backend extensions (original Phase 2)

- [x] ~~Cashback calculation + distribution service~~ — `user_credits`
      ledger (ADR 009) + `pending_payouts` worker (ADR 016).
- [ ] **On-device Stellar wallet key generation** — **retired by ADR 030**. Privy provisions managed wallets keyed on user_id; on-device key gen is not Loop's path. Revisit only if Privy/dfns vendor relationship breaks down.
- [ ] **2-of-3 multisig wallet** — **retired by ADR 030**. Vendor MPC (Privy/dfns) replaces multisig; recovery is vendor's responsibility.
- [ ] **Recovery key escrow** — **retired by ADR 030**. Vendor-managed.

### Mobile enhancements

- [ ] Push notifications for order status and cashback
- [ ] Capacitor Live Update for OTA web asset updates
- [ ] Deep linking (`loopfinance.io/gift-card/:name` → app)

---

## Phase 3 — Growth & polish

### Scaling & performance

- [ ] Swap Leaflet for MapLibre GL JS (WebGL rendering, better mobile perf with many markers)
- [ ] Server-side merchant search (replace client-side 1000-merchant fetch in Navbar)
- [x] ~~Add circuit breaker on upstream API~~ — per-upstream-endpoint breakers (login, verify-email, refresh-token, logout, merchants, locations, gift-cards), each 5 failures → 30s OPEN → HALF_OPEN probe. Returns 503 when open. Independent so a failing endpoint doesn't trip the circuit for healthy ones (audit-hardening split — see `apps/backend/src/circuit-breaker.ts` `getUpstreamCircuit(key)` and ADR-004 §Per-endpoint circuit breakers).
- [x] ~~Add staleness alerting for background refreshes~~ — warns in logs when data exceeds 2x refresh interval

### Features

- [x] ~~Order history page~~ — `/orders` route with pagination, status badges, sign-in prompt. Navbar link added.
- [x] ~~Favourites~~ — `/api/users/me/favorites` list/add/remove with a 50-per-user cap, surfaced as a heart-toggle on every `MerchantCard` and a "Your favourites" strip on the home page (mobile + desktop). Catalog-evicted favourites surface as `merchant: null` so the row stays restorable while the UI hides the entry. Recently-purchased is a separate read on top of the orders ledger and stays open.
- [x] ~~Recently purchased merchants~~ — `GET /api/users/me/recently-purchased` derives distinct merchants from `orders` in `state IN ('paid', 'procuring', 'fulfilled')`, ordered by MAX(created_at) DESC. Surfaces as a "Recently purchased" strip above the home grid (mobile + desktop), rendered before the Favourites strip so a returning buyer lands on repeat-purchase shortcuts before browsing pinned merchants.
- [ ] Referral program

### Tranche 3 contract deliverables (added 2026-05-05 from contract review)

The proposal commits Tranche 3 to **Plaid + virtual cashback Visa/Mastercard + mainnet + 4-country launch**, none of which are scoped under "Phase 3 Growth & polish" above. These are the genuine T3 deliverables; the "Growth & polish" items below are post-contract enhancements.

- [ ] **Plaid SDK integration** — open-banking USD/GBP/EUR/CAD payment rails. Lets users buy gift cards via bank transfer in addition to crypto. Backend route accepts Plaid Auth + ACH/SEPA/FPS settlement; web/mobile SDK for account linking. Rough scope: 2–3 months including bank-rail integration and reg posture per jurisdiction.
- [ ] **Virtual cashback Visa/Mastercard** — physical/virtual card issuance for cashback spending. BIN sponsor partnership (Marqeta, Stripe Issuing, Galileo, etc) required; KYC + compliance program needed. Rough scope: 4–6 months including card issuer onboarding.
- [ ] **Mainnet launch** — flip from Tranche 2 testnet to mainnet across all stablecoins, vaults, and wallet provisioning. Includes audit completion (Privy/dfns custody, LOOPUSD/LOOPEUR vault, GBPLOOP issuance), regulatory authorisations (UK FCA EMI for GBPLOOP, equivalent posture per US/EU/CA jurisdictions), and migration of any testnet user balances.
- [ ] **Four-country launch** (US/UK/EU/CA) — verify CTX merchant catalog covers all four; complete jurisdictional reg posture for each; localise app strings and currency display.

### Phase 3 — Growth & polish (post-contract, not Tranche 3)

These were originally listed as Phase 3 but are not in the Tranche 3 contract. They're post-launch quality and scaling work.

### Observability

- [x] ~~Request correlation logging~~ — already implemented via Hono requestId() middleware (A4-008: server-mints, ignores inbound to defeat log-poisoning)
- [x] ~~Prometheus metrics endpoint~~ — `/metrics` mounted in `apps/backend/src/app.ts`; full exposition in `apps/backend/src/observability-handlers.ts` (rate-limit hits, per-route request totals, per-endpoint circuit-breaker state, runtime-health gauges, worker running state). Bearer-gated in production via `METRICS_BEARER_TOKEN`.
- [ ] Prometheus scraping infrastructure + dashboards + alert rules (the endpoint exists; the upstream scraping/storage/alerting tier does not yet)
- [ ] Analytics (privacy-respecting, no PII in events)
- [ ] Performance monitoring (Core Web Vitals, API latency)

### Quality

- [ ] Accessibility audit (WCAG 2.1 AA)
- [x] ~~Distinguish error types in auth hook~~ — maps 401/429/502/503 to user-facing messages, throws instead of returning boolean
- [x] ~~Distinguish error types in payment polling~~ — stops on 401 (session expired); 503 keeps polling (circuit breaker handles its own backoff); other transient errors retry up to 5 consecutive times, then surface a connection error (audit A-030)

---

## Upstream API reference

The upstream gift card provider (CTX) exposes these endpoints. Field shapes + integration notes are maintained in `docs/architecture.md` §CTX upstream field mapping; the historical Postman collection was retired during the audit hygiene pass (A-010 / A-035).

| Endpoint                    | Method | Auth                                | Purpose                                                                        |
| --------------------------- | ------ | ----------------------------------- | ------------------------------------------------------------------------------ |
| `/login`                    | POST   | none                                | Request OTP (email)                                                            |
| `/verify-email`             | POST   | none                                | Verify OTP → tokens                                                            |
| `/refresh-token`            | POST   | none                                | Refresh access token (refresh token rotates every call)                        |
| `/logout`                   | POST   | none (refreshToken in body)         | Revoke refresh token                                                           |
| `/gift-cards`               | POST   | Bearer                              | Create gift card order                                                         |
| `/gift-cards`               | GET    | Bearer                              | List authenticated user's orders (pagination via query)                        |
| `/gift-cards/:id`           | GET    | Bearer                              | Get a single order by id                                                       |
| `/gift-cards/:id/barcode`   | GET    | Bearer                              | Get gift card barcode (Phase 2 — barcode redemption)                           |
| `/merchants/:id`            | GET    | Bearer                              | Get merchant details                                                           |
| `/merchants/:id/card-image` | GET    | Bearer                              | Get merchant card image                                                        |
| `/merchants/:id/logo`       | GET    | Bearer                              | Get merchant logo                                                              |
| `/merchants`                | GET    | none                                | Bulk merchant catalog (paginated); our backend syncs without api-key headers   |
| `/locations`                | GET    | X-Api-Key + X-Api-Secret (when set) | Bulk merchant-location list (~116K rows); headers optional but operator-scoped |
| `/status`                   | GET    | none                                | Health check                                                                   |

Our backend proxies and adapts these — the web app never calls upstream directly.
