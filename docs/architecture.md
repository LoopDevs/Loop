# Architecture

## System overview

```
┌─────────────────────────────────────────────────────────────┐
│  apps/mobile  (Capacitor v8)                                │
│  Thin native shell — iOS + Android                          │
│  Loads static build from apps/web/build/client/             │
└──────────────────────┬──────────────────────────────────────┘
                       │ bundles static build of
┌──────────────────────▼──────────────────────────────────────┐
│  apps/web  (React Router v7 + Vite)                         │
│  Two modes: SSR build (web) / static export (mobile)        │
│  Pure API client — all data via TanStack Query              │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTP + protobuf / JSON
┌──────────────────────▼──────────────────────────────────────┐
│  apps/backend  (TypeScript + Hono, Node.js)                 │
│  Merchant cache · map clustering · image proxy              │
│  Email OTP / refresh-token proxy · gift card order proxy    │
│  (backend does NOT mint its own tokens — it forwards CTX's) │
└──────────────────────┬──────────────────────────────────────┘
                       │ REST API
┌──────────────────────▼──────────────────────────────────────┐
│  Upstream Gift Card API  (external, provider-managed)       │
│  Merchant catalog · gift card orders · cashback (Phase 2)   │
└─────────────────────────────────────────────────────────────┘
```

---

## Web build modes

`react-router.config.ts` exports `ssr: process.env.BUILD_TARGET !== 'mobile'`.

| Command                | Mode          | Used for                      |
| ---------------------- | ------------- | ----------------------------- |
| `npm run build` (web)  | SSR           | Deployed to loopfinance.io    |
| `npm run build:mobile` | Static export | Bundled into Capacitor binary |

**Static export constraint**: React Router loaders cannot run server-side in static export mode. Loaders may only handle layout structure and `<meta>` tags. All data fetching is client-side via TanStack Query.

---

## Backend data model (in-memory)

Backend holds two hot-swappable in-memory stores:

```
merchantStore: {
  merchants:       Merchant[]            // list, preserves upstream ordering
  merchantsById:   Map<string, Merchant> // O(1) id lookup (GET /api/merchants/:id)
  merchantsBySlug: Map<string, Merchant> // O(1) slug lookup (GET /api/merchants/by-slug/:slug)
  loadedAt:        number                // unix ms — drives /health staleness check
}                                        // refreshed every 6h (REFRESH_INTERVAL_HOURS)

locationStore: {
  locations: Location[]
  loadedAt:  number
}                                        // refreshed every 24h (LOCATION_REFRESH_INTERVAL_HOURS)
```

Hot-swap is safe in Node.js because JS is single-threaded — the store reference is replaced atomically on each refresh. No locks needed.

---

## Clustering algorithm

Located in `apps/backend/src/clustering/algorithm.ts`.

1. Extend each side of the viewport bbox by 50% of its dimension (north / south / east / west each shift outward by half the viewport's height/width). The resulting bbox is 2× the original on both axes (4× area). Pre-loads clusters so panning doesn't instantly reveal empty edges.
2. Select `gridSize` based on zoom level:

   | Zoom | Grid cell         |
   | ---- | ----------------- |
   | ≤3   | 20.0°             |
   | ≤5   | 10.0°             |
   | 6    | 5.0°              |
   | ≤7   | 1.5°              |
   | ≤9   | 0.5°              |
   | ≤11  | 0.1°              |
   | ≤13  | 0.03°             |
   | ≥14  | individual points |

3. Group locations by `(floor(lat/grid), floor(lng/grid))` cell key
4. Single point in cell → `LocationPoint`; multiple → `ClusterPoint` (centroid of visible-only points)
5. Response: protobuf if client sends `Accept: application/x-protobuf`, JSON otherwise

---

## Auth flow

Authentication is proxied through the upstream CTX API. Our backend does not issue its own tokens — it forwards auth requests to upstream and passes tokens back to the client.

```
App open
  → check stored refresh token
  → valid  → home
  → absent → /auth (email step)
               → POST /api/auth/request-otp  → proxied to upstream POST /login
               → OTP email sent by upstream (branded for Loop)
               → (email-enumeration defense: our handler returns 200
                  even when upstream rejects the email with 4xx, so the
                  client flow cannot distinguish "new email accepted"
                  from "unknown email rejected")
               → OTP step
               → POST /api/auth/verify-otp   → proxied to upstream POST /verify-email
               → upstream returns token pair
               → store tokens (see below)
               → home

Purchase
  → email already in session — not re-entered
  → Bearer access token on all authenticated requests
  → POST /api/orders → proxied to upstream POST /gift-cards (with Bearer auth)
```

**Token storage:**

- Access token: Zustand memory only
- Refresh token: `@aparajita/capacitor-secure-storage` on native (Keychain / EncryptedSharedPreferences — ADR-006, audit A-024); sessionStorage on web
- Tokens are upstream (CTX) tokens — backend proxies without verification
- Token refresh: POST /api/auth/refresh → proxied to upstream POST /refresh-token

---

## Image proxy

`GET /api/image?url=<encoded>&width=<n>&height=<n>&quality=<n>`

- Fetches upstream image, resizes with `sharp`, serves with cache headers
- LRU in-memory cache: 100 MB max, 7-day TTL
- Prevents CORS issues and normalises image dimensions
- SSRF-hardened (audit A-025): the target URL is validated before
  fetch — rejects non-http/https schemes, localhost / private / IPv6
  link-local addresses, and hosts outside the
  `IMAGE_PROXY_ALLOWED_HOSTS` allowlist. The backend refuses to boot
  in `NODE_ENV=production` without the allowlist set, unless
  `DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT=1` is an explicit
  emergency opt-out. Requests capped at 10 MB and 2000px per
  dimension.

---

## Protobuf

Schema: `apps/backend/proto/clustering.proto`
Generated types: `packages/shared/src/proto/` (run `npm run proto:generate`)

Both web and backend use dynamic import for proto types with JSON fallback — safe before first `buf generate` run.

---

## Circuit breaker

All upstream API calls (auth, orders, merchant sync, location sync) are routed through an endpoint-scoped circuit breaker (`apps/backend/src/circuit-breaker.ts`, `getUpstreamCircuit(key)`). This prevents cascading failures when a specific upstream endpoint is down, without tripping healthy ones.

```
CLOSED ──(N consecutive failures)──→ OPEN ──(cooldown elapsed)──→ HALF_OPEN
  ↑                                                                  │
  └──────────(probe succeeds)──────────────────────────────────────────┘
                                     ↑
  OPEN ←───────────────(probe fails)─┘
```

| Parameter          | Default | Description                                  |
| ------------------ | ------- | -------------------------------------------- |
| `failureThreshold` | 5       | Consecutive 5xx/network failures to trip     |
| `cooldownMs`       | 30 000  | Milliseconds in OPEN before allowing a probe |

- **4xx responses** do not count as failures (client errors, not upstream outage).
- When OPEN, upstream proxy handlers return **503** `Service temporarily unavailable` (not 502).
- The `/health` endpoint bypasses the circuit breaker — it probes upstream directly so external monitors can detect recovery. Result is cached 10s (PR #131) to stop an attacker from turning `/health` into an outbound-fetch amplifier.
- One breaker **per upstream endpoint** — `login`, `verify-email`, `refresh-token`, `logout`, `merchants`, `locations`, `gift-cards`. Lazily created via `getUpstreamCircuit(key)` in `circuit-breaker.ts`. Independent so a failing merchants sync can't trip auth, and a failing gift-cards endpoint can't trip clusters.

---

## Phase 2 — Stellar wallet + cashback

2-of-3 multisig per user:

| Key          | Location                                    | Signs when                         |
| ------------ | ------------------------------------------- | ---------------------------------- |
| Device key   | iOS Keychain / Android Keystore (biometric) | On-device after Face ID / Touch ID |
| Server key   | Backend env (encrypted reference)           | Every transaction as co-signer     |
| Recovery key | Third-party custodian                       | Account recovery only              |

Device key never leaves the device. Backend never sees the private key.

---

## Backend API endpoints

```
GET  /health
GET  /metrics                               — Prometheus format
GET  /openapi.json                          — full OpenAPI 3.1 spec
GET  /api/merchants              ?page=&limit=&q=      — paginated, max 100 per page
GET  /api/merchants/all                                 — full catalog in one response (audit A-002)
GET  /api/merchants/by-slug/:slug
GET  /api/merchants/:id
GET  /api/merchants/cashback-rates              — public bulk map of active cashback pcts (ADR 011/015)
GET  /api/merchants/:merchantId/cashback-rate   — public cashback-% preview (ADR 011/015)
GET  /api/clusters           ?west=&south=&east=&north=&zoom=
GET  /api/image              ?url=&width=&height=&quality=
GET  /api/config                            — client feature flags (ADR 010 / 013)
POST /api/auth/request-otp
POST /api/auth/verify-otp
POST /api/auth/refresh
POST /api/auth/social/google                — ADR 014
POST /api/auth/social/apple                 — ADR 014
DELETE /api/auth/session
POST /api/orders             [authenticated]
POST /api/orders/loop        [authenticated — Loop-native flow, ADR 010]
GET  /api/orders/loop        [authenticated — Loop-native list, ADR 010]
GET  /api/orders/loop/:id    [authenticated — Loop-native flow, ADR 010]
GET  /api/orders             [authenticated]
GET  /api/orders/:id         [authenticated]
GET  /api/users/me           [authenticated — profile + home_currency, ADR 015]
POST /api/users/me/home-currency   [authenticated — first-time-set (order-less), ADR 015]
PUT  /api/users/me/stellar-address [authenticated — link/unlink Stellar wallet for payouts, ADR 015]
GET  /api/users/me/cashback-history [authenticated — recent credit-ledger events, ADR 009/015]
GET  /api/users/me/credits         [authenticated — per-currency balance list, ADR 009/015]
GET  /api/users/me/pending-payouts  [authenticated — caller's on-chain payout rows, ADR 015/016]
GET  /api/users/me/pending-payouts/:id [authenticated — single payout detail, ADR 015/016]
GET  /api/users/me/cashback-summary [authenticated — compact { lifetime, thisMonth } totals, ADR 009/015]
GET  /api/public/cashback-stats    [public — landing-page aggregates, never-500, ADR 009/015/020]
GET  /api/public/top-cashback-merchants [public — landing-page "best cashback" list, never-500, ADR 011/020]
GET  /api/admin/merchant-cashback-configs              [admin]
PUT  /api/admin/merchant-cashback-configs/:merchantId  [admin]
GET  /api/admin/merchant-cashback-configs/:merchantId/history  [admin]
GET  /api/admin/treasury                               [admin]
GET  /api/admin/payouts                                [admin — ADR 015 payout backlog, ?state/?userId/?assetCode filters]
GET  /api/admin/payouts/:id                            [admin — single pending-payout drill-down]
POST /api/admin/payouts/:id/retry                      [admin — reset failed payout to pending, ADR 015/016/017]
GET  /api/admin/payouts-by-asset                       [admin — per-asset × per-state payout breakdown, ADR 015/016]
GET  /api/admin/top-users                               [admin — ranked top users by cashback, ADR 009/015]
GET  /api/admin/audit-tail                              [admin — newest-first admin-write audit rows + ?before cursor, ADR 017/018]
GET  /api/admin/audit-tail.csv                          [admin — finance/legal CSV export of admin write-audit, ADR 017/018]
POST /api/admin/users/:userId/credit-adjustments        [admin — signed credit adjustment, ADR 017]
GET  /api/admin/payouts.csv                            [admin — finance-ready CSV export, ADR 015]
GET  /api/admin/orders                                  [admin — Loop-native orders drill-down + ?state/?userId/?merchantId/?chargeCurrency/?ctxOperatorId filters, ADR 011/013/015]
GET  /api/admin/operator-stats                          [admin — per-operator order volume + success rate, ADR 013]
GET  /api/admin/orders/activity                         [admin — N-day created/fulfilled sparkline, ADR 010]
GET  /api/admin/orders.csv                              [admin — finance-ready CSV export, ADR 011/015]
GET  /api/admin/stuck-orders                            [admin — SLO stuck-in-paid/procuring triage, ADR 011/013]
GET  /api/admin/stuck-payouts                           [admin — SLO stuck-in-pending/submitted payouts, ADR 015/016]
GET  /api/admin/cashback-activity                       [admin — daily cashback-accrual sparkline, ADR 009/015]
GET  /api/admin/merchant-stats                          [admin — per-merchant cashback stats, ADR 011/015]
GET  /api/admin/orders/:orderId                         [admin — single order detail, ADR 011/015]
GET  /api/admin/orders/:orderId/payout                  [admin — payout row for a given order]
GET  /api/admin/supplier-spend                          [admin — per-currency supplier spend, ADR 013/015]
GET  /api/admin/users                                   [admin — paginated user directory w/ email fragment filter]
GET  /api/admin/users/:userId                           [admin — single-user detail]
GET  /api/admin/users/:userId/credits                   [admin — per-user credit balance, ADR 009]
GET  /api/admin/users/:userId/credit-transactions       [admin — per-user credit-ledger log, ADR 009]
```

Full request/response shapes — including field types, pagination
envelopes, and error codes per endpoint — are generated from the backend
zod schemas and served live at `GET /openapi.json`. The schema source is
[`apps/backend/src/openapi.ts`](../apps/backend/src/openapi.ts). Any PR
that changes a request/response contract must keep that file in sync
with the handler's validator.

---

## CTX upstream field mapping

Our backend maps CTX API responses to Loop's internal types. Key transformations:

### Order creation (`POST /gift-cards`)

| CTX field             | Loop field                             | Notes                              |
| --------------------- | -------------------------------------- | ---------------------------------- |
| `id`                  | `orderId`                              |                                    |
| `paymentCryptoAmount` | `xlmAmount`                            |                                    |
| `paymentUrls.XLM`     | `paymentUri`, `paymentAddress`, `memo` | Stellar URI parsed into components |

### Order status

`mapStatus()` in `apps/backend/src/orders/handler.ts` is the source of
truth; unknown values default to `pending` and log a warn so schema drift
surfaces in ops logs.

| CTX status                                | Loop status               |
| ----------------------------------------- | ------------------------- |
| `fulfilled`                               | `completed`               |
| `expired`                                 | `expired`                 |
| `refunded`                                | `failed`                  |
| `unpaid`, `processing`, `paid`, `pending` | `pending`                 |
| anything else                             | `pending` (with warn log) |

### Order detail (`GET /gift-cards/:id`)

| CTX field                   | Loop field            | Notes                                                                                       |
| --------------------------- | --------------------- | ------------------------------------------------------------------------------------------- |
| `id`                        | `id`                  |                                                                                             |
| `merchantId`                | `merchantId`          |                                                                                             |
| `merchantName`              | `merchantName`        | Empty string when upstream omits it                                                         |
| `cardFiatAmount` (string)   | `amount` (number)     | Parsed via `parseMoney` — single-order handler throws on non-numeric                        |
| `cardFiatCurrency`          | `currency`            | Defaults to `USD` if upstream omits                                                         |
| `status`                    | `status`              | Mapped via `mapStatus`: fulfilled→completed, expired→expired, refunded→failed, else→pending |
| `paymentCryptoAmount`       | `xlmAmount`           | Defaults to `'0'` if upstream omits                                                         |
| `percentDiscount`           | `percentDiscount`     |                                                                                             |
| `redeemType`                | `redeemType`          |                                                                                             |
| `redeemUrl` (optional)      | `redeemUrl`           | Only present when upstream returns it                                                       |
| `redeemUrlChallenge` (opt.) | `redeemChallengeCode` | Only present when upstream returns it                                                       |
| `redeemScripts` (optional)  | `redeemScripts`       | Only present when upstream returns it                                                       |
| `created` (ISO string)      | `createdAt`           |                                                                                             |

### Auth

All auth requests include `clientId` mapped from platform: `web` → `loopweb`, `ios` → `loopios`, `android` → `loopandroid`. All authenticated upstream requests include `X-Client-Id` header.
