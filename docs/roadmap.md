# Roadmap

What remains to ship Loop Phase 1 and what comes after.

The migration plan (`docs/migration.md`) covered getting the monorepo to a working state. This document tracks what's left to reach production and beyond.

Known limitations we are **consciously not fixing** in the current phase are tracked separately in [ADR-002 — Known Limitations](adr/002-known-limitations.md). Check there before filing a bug for Stellar, barcode redemption, `eslint-plugin-react`, distributed rate limiting, DNS rebinding, probe timeouts, jsdom coverage, proto drift, metrics scraping, or upstream token passthrough.

---

## Phase 1 — Gift card purchases (XLM)

### Remaining setup tasks

- [x] ~~Run `npx buf generate`~~ — proto schema created, types generated to `packages/shared/src/proto/`
- [x] ~~Add `.env` files~~ — created from `.env.example`
- [x] ~~Run `npx cap add ios && npx cap add android`~~ — native projects created
- [x] ~~Install Playwright browsers~~ — chromium installed
- [x] ~~Set GitHub repo secrets for CI~~ — no secrets needed; upstream API is public
- [ ] Set up GitHub branch protection rules on `main`

### Production infrastructure

- [ ] Deploy backend to Fly.io (see `docs/deployment.md`)
- [ ] Deploy web (SSR) to Fly.io or Vercel
- [ ] Set `IMAGE_PROXY_ALLOWED_HOSTS` in production backend for SSRF prevention
- [ ] Set up monitoring / error tracking (e.g., Sentry)
- [x] ~~Configure production CORS allowlist~~ — already set in `index.ts` (loopfinance.io in production, \* in dev)
- [ ] DNS: point `loopfinance.io` → web deployment, `api.loopfinance.io` → backend deployment
- [ ] TLS certificates (automatic via Fly.io / Vercel)

### Code hardening (before connecting to real upstream)

- [x] ~~**Validate upstream responses with Zod**~~ — auth and order handlers now validate all upstream JSON with Zod schemas before forwarding.
- [x] ~~**Reject orders for unknown merchants**~~ — returns 404 if merchantId not in cache.
- [x] ~~**Add rate limiting**~~ — `/api/image` (60/min/IP) and `/api/auth/request-otp` (5/min/IP). In-memory rate limiter with hourly cleanup.
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
- [ ] Test gift card barcode/PIN retrieval in purchase flow

### Brand & design

- [ ] Create Loop brand assets: `loop-logo.svg`, `loop-favicon.ico`, `loop-favicon.png`, `hero.webp`
- [ ] Integrate assets into web app (`apps/web/public/`)
- [ ] Configure splash screen assets for iOS and Android
- [ ] App icon for iOS (1024x1024) and Android (512x512)

### Mobile app submission

- [ ] Build and test on physical iOS device
- [ ] Build and test on physical Android device
- [ ] Apple Developer account setup, bundle ID `io.loopfinance.app`
- [ ] Google Play Console setup, package name `io.loopfinance.app`
- [ ] App Store screenshots and metadata
- [ ] Play Store screenshots and metadata
- [ ] Privacy policy and terms of service pages on `loopfinance.io`
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

## Phase 2 — Stellar wallet & USDC cashback

### Stellar integration

- [ ] On-device key generation using `@stellar/stellar-sdk` (never leaves device)
- [ ] 2-of-3 multisig wallet setup (device key + server key + recovery key)
- [ ] Biometric authentication for transaction signing (Face ID / Touch ID)
- [ ] USDC cashback distribution after gift card purchase
- [ ] Wallet balance display and transaction history

### Authentication upgrades

- [ ] Social login (Apple Sign-In required for App Store, Google optional)
- [ ] Login gate — require auth before any purchase or wallet feature
- [ ] Session persistence across app restarts (refresh token flow)

### Backend extensions

- [ ] Server-side co-signing endpoint for Stellar transactions
- [ ] Cashback calculation and distribution service
- [ ] Recovery key escrow with third-party custodian
- [ ] Wallet balance and history endpoints

### Mobile enhancements

- [ ] Push notifications for order status and cashback
- [ ] Capacitor Live Update for OTA web asset updates
- [ ] Deep linking (`loopfinance.io/gift-card/:name` → app)

---

## Phase 3 — Growth & polish

### Scaling & performance

- [ ] Swap Leaflet for MapLibre GL JS (WebGL rendering, better mobile perf with many markers)
- [ ] Server-side merchant search (replace client-side 1000-merchant fetch in Navbar)
- [x] ~~Add circuit breaker on upstream API~~ — shared `upstreamCircuit` (5 failures → 30s OPEN → HALF_OPEN probe). Returns 503 when open. 13 tests.
- [x] ~~Add staleness alerting for background refreshes~~ — warns in logs when data exceeds 2x refresh interval

### Features

- [x] ~~Order history page~~ — `/orders` route with pagination, status badges, sign-in prompt. Navbar link added.
- [ ] Favourites / recently purchased merchants
- [ ] Referral program

### Observability

- [x] ~~Request correlation logging~~ — already implemented via Hono requestId() middleware
- [ ] Prometheus metrics endpoint
- [ ] Analytics (privacy-respecting, no PII in events)
- [ ] Performance monitoring (Core Web Vitals, API latency)

### Quality

- [ ] Accessibility audit (WCAG 2.1 AA)
- [x] ~~Distinguish error types in auth hook~~ — maps 401/429/502/503 to user-facing messages, throws instead of returning boolean
- [x] ~~Distinguish error types in payment polling~~ — stops on 401/503 (permanent), retries transient up to 5 times, then gives up

---

## Upstream API reference

The upstream gift card provider (CTX) exposes these endpoints (see Postman collection in repo root):

| Endpoint                    | Method | Auth                     | Purpose                         |
| --------------------------- | ------ | ------------------------ | ------------------------------- |
| `/login`                    | POST   | none                     | Request OTP (email)             |
| `/verify-email`             | POST   | none                     | Verify OTP → tokens             |
| `/refresh-token`            | POST   | none                     | Refresh access token            |
| `/gift-cards`               | POST   | Bearer                   | Create gift card order          |
| `/gift-cards?txid=<txid>`   | GET    | Bearer                   | Get gift card by txid           |
| `/gift-cards/:id/barcode`   | GET    | Bearer                   | Get gift card barcode           |
| `/merchants/:id`            | GET    | Bearer                   | Get merchant details            |
| `/merchants/:id/card-image` | GET    | Bearer                   | Get merchant card image         |
| `/merchants/:id/logo`       | GET    | Bearer                   | Get merchant logo               |
| `/merchants`                | GET    | X-Api-Key + X-Api-Secret | List merchants/locations (bulk) |
| `/status`                   | GET    | none                     | Health check                    |

Our backend proxies and adapts these — the web app never calls upstream directly.
