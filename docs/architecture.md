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
│  Email OTP auth · JWT · gift card order proxy               │
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
merchantsById: Map<string, Merchant>   — refreshed every 6h
locationStore: { locations, loadedAt } — refreshed every 24h
```

Hot-swap is safe in Node.js because JS is single-threaded — the store reference is replaced atomically on each refresh. No locks needed.

---

## Clustering algorithm

Located in `apps/backend/src/clustering/algorithm.ts`.

1. Expand viewport bbox by 50% (pre-loads clusters for smooth panning)
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

```
App open
  → check stored refresh token
  → valid  → home
  → absent → /auth (email step)
               → POST /api/auth/request-otp  (6-digit OTP, 10-min TTL)
               → OTP step
               → POST /api/auth/verify-otp   (returns JWT pair)
               → store tokens (see below)
               → home

Purchase
  → email already in session — not re-entered
  → Bearer access token on all authenticated requests
  → POST /api/orders (proxied to upstream API)
```

**Token storage:**

- Access token: Zustand memory only (15-min TTL)
- Refresh token: Capacitor Preferences on native; sessionStorage on web (30-day TTL)
- Server always returns refresh token in JSON body — client stores it via platform-appropriate secure storage

---

## Image proxy

`GET /api/image?url=<encoded>&width=<n>&height=<n>&quality=<n>`

- Fetches upstream image, resizes with `sharp`, serves with cache headers
- LRU in-memory cache: 100 MB max, 7-day TTL
- Prevents CORS issues and normalises image dimensions

---

## Protobuf

Schema: `apps/backend/proto/clustering.proto`
Generated types: `packages/shared/src/proto/` (run `npm run proto:generate`)

Both web and backend use dynamic import for proto types with JSON fallback — safe before first `buf generate` run.

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
GET  /api/merchants              ?page=&limit=&q=
GET  /api/merchants/by-slug/:slug
GET  /api/merchants/:id
GET  /api/clusters           ?west=&south=&east=&north=&zoom=
GET  /api/image              ?url=&width=&height=&quality=
POST /api/auth/request-otp
POST /api/auth/verify-otp
POST /api/auth/refresh
DELETE /api/auth/session
POST /api/orders             [authenticated]
GET  /api/orders             [authenticated]
GET  /api/orders/:id         [authenticated]
```
