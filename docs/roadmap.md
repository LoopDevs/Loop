# Roadmap

What remains to ship Loop Phase 1 and what comes after.

The migration plan (`docs/migration.md`) covered getting the monorepo to a working state. This document tracks what's left to reach production and beyond.

---

## Phase 1 — Gift card purchases (XLM)

### Remaining setup tasks

- [ ] Run `npx buf generate` in `apps/backend/` to generate proto types
- [ ] Add `.env` files (copy from `.env.example` files, fill real values)
- [ ] Run `npx cap add ios && npx cap add android` in `apps/mobile/`
- [ ] Install Playwright browsers: `npx playwright install`
- [ ] Set GitHub repo secrets for CI (`CI_GIFT_CARD_API_BASE_URL`, `CI_GIFT_CARD_API_KEY`, `CI_GIFT_CARD_API_SECRET`)
- [ ] Set up GitHub branch protection rules on `main`

### Production infrastructure

- [ ] Deploy backend to Fly.io (see `docs/deployment.md`)
- [ ] Deploy web (SSR) to Fly.io or Vercel
- [ ] Set `IMAGE_PROXY_ALLOWED_HOSTS` in production backend for SSRF prevention
- [ ] Set up monitoring / error tracking (e.g., Sentry)
- [ ] Configure production CORS allowlist in backend (`loopfinance.io`)
- [ ] DNS: point `loopfinance.io` → web deployment, `api.loopfinance.io` → backend deployment
- [ ] TLS certificates (automatic via Fly.io / Vercel)

### Upstream API integration

- [ ] Obtain production credentials for upstream gift card API (CTX)
- [ ] Validate order creation flow end-to-end with real credentials
- [ ] Confirm merchant sync pagination works with full catalog
- [ ] Confirm location data sync and clustering against real data
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

- [ ] Swap Leaflet for MapLibre GL JS (WebGL rendering, better mobile perf)
- [ ] Server-side merchant search (replace client-side 1000-merchant fetch in Navbar)
- [ ] Favourites / recently purchased merchants
- [ ] Order history with re-purchase
- [ ] Referral program
- [ ] Analytics (privacy-respecting, no PII in events)
- [ ] Performance monitoring (Core Web Vitals, API latency)
- [ ] Accessibility audit (WCAG 2.1 AA)

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
