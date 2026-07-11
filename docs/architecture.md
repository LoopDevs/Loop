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
│  Dual-path auth · gift card order proxy                     │
│  (Loop-native JWTs when enabled; CTX-proxy during rollout)  │
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

## Locale routing (ADR 034 / ADR 035)

**Path-based locale routing (ADR 034)**: the public catalogue is served under a `/:country/:lang` URL prefix (e.g. `/gb/en`, `/de/en`, `/ae/en`); a bare `/` issues a server-side 302 to the geo-resolved country (`/<country>/en`), while bots get the `x-default` home rendered at `/`. The merchant filter and price-display currency read the URL country (via `useLocale()` + `merchantInCountry()`), not a client store — which is what removes the "US flash". Two SSR loaders fetch server-side as the **documented exceptions** to the pure-API-client rule: `routes/sitemap.tsx` (XML for crawlers, with per-country `hreflang`) and `routes/home-geo-redirect.tsx` (the `/` geo-redirect; precedence cookie > geo-IP via `/api/public/geo` > default). The legacy unprefixed routes still resolve during the migration; internal `<Link>`s on the localized surface go through `LocaleLink`.

**`packages/shared/src/countries.ts` is the single source of truth** for the country model. Adding a `Country` row (plus its currency in `SUPPORTED_CURRENCIES`) is the whole change needed to surface a market: the locale layout, geo-redirect, country selector, per-country SEO/hreflang sitemap, merchant filter, and the `money.ts` price formatter (generic `Intl.NumberFormat`) all derive from that list. It supersedes the retired four-region model in `regions.ts` (ADR 034 phase 5).

**Merchant country filtering**: `merchantInCountry()` matches merchants to a country by display currency (a EUR merchant surfaces on every Eurozone country page), so thin per-country catalogues still populate.

**Extended markets (ADR 035)**: the June-2026 supplier program took the catalogue to 33 currencies. Only **strong** markets — currencies with **≥ 15 enabled merchants** — get a country row: AE/IN/SA/AU/MX joined US/GB/CA + the Eurozone as **display-only** countries (price display + XLM ordering, no LOOP cashback band — the CAD precedent, since no AEDLOOP/INRLOOP/… asset exists). The ~20 thinner currencies stay catalogue-only (API-orderable but unrouted) until they cross the threshold; promotion is a one-line `countries.ts` addition (review cadence tracked in `docs/roadmap.md` §Orphaned-work register). The **Loop-side order path is wired** (CF-19): `POST /api/orders/loop` accepts the extended currencies (`ORDERABLE_CURRENCIES` in `@loop/shared`), the fiat FX feed (`payments/price-feed-fx.ts`, Frankfurter/ECB) requests them and FX-pins the charge to the user's home currency, and migration 0037 widens the `orders_currency_known` CHECK (charge/cashback CHECKs stay USD/GBP/EUR — display-only). A market goes live end-to-end only once that FX feed serves a live rate for the currency; until then an extended-market order returns a clean `CURRENCY_NOT_AVAILABLE` 503 ("ordering for this market is coming soon"), never a wrong charge — checked live per-request, never a static allowlist, so a market activates the moment the feed adds it, no deploy needed. **Confirmed 2026-07-10** against production Frankfurter: AUD/INR/MXN are live (orderable today); AED/SAR are not yet served by Frankfurter (USD-pegged Gulf currencies absent from the ECB reference-rate table it republishes) and correctly 503 until that changes — see ADR 035's status section for detail.

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

**Merchant slugs are country-aware (CTX-sourced).** `merchantsBySlug` is keyed off `merchantSlug(merchant)` from `@loop/shared`, which is the single source of truth shared with every frontend link. The slug is unique per `(brand, country)`:

1. **Prefer CTX's `slug`** field when present — CTX owns the merchant's country and regenerates its own brand-country slug (e.g. `adidas-ca`), so Loop defers to it verbatim. The CTX `slug` is carried through `mapUpstreamMerchant` onto the `Merchant` record.
2. **Else derive `brandSlug(name)-<country>`** — `"adidas"` + `CA` → `adidas-ca`. The transitional un-renamed form `"adidas Canada"` + `CA` → `adidas-canada-ca` (ugly but unique).
3. **Else fall back to bare `brandSlug(name)`** — a data-gap fallback for merchants tagged with neither a CTX slug nor a country (preserves the pre-country behaviour).

This makes the sync safe against CTX's country-token rename (`"adidas Canada"` → `"adidas"`, country kept): regional variants of one brand no longer collapse to the same bare slug and overwrite each other in `merchantsBySlug`. The slug-collision warn in `merchants/sync.ts` now fires only on a **true** duplicate — same brand AND country (the ~8 pre-existing dupe clusters like `lastminute`). Brand grouping (ADR 032, `/brand/:slug`) keys off the **country-agnostic** `brandSlug(name)` instead, so `adidas` across CA/US/GB collapses into ONE brand tile while each member keeps its distinct per-merchant `merchantSlug`.

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

Authentication has two coexisting paths:

- **Loop-native auth** (default when `LOOP_AUTH_NATIVE_ENABLED=true`) —
  Loop writes OTP rows, sends email itself, verifies social `id_token`s,
  and mints its own access/refresh JWTs — RS256 with a `kid` header when
  `LOOP_JWT_RSA_PRIVATE_KEY` is configured (ADR 030 Phase A; public keys
  publish at `GET /.well-known/jwks.json` so an external wallet provider
  can verify Loop tokens), HS256 otherwise. Verification accepts both
  algorithms during the cutover window so outstanding tokens survive.
- **Legacy CTX-proxy auth** (used while the identity takeover rolls out,
  or when the native flag is disabled) — Loop forwards OTP request /
  verify / refresh / logout to the upstream CTX API and passes the
  validated token pair back to the client.

```
App open
  → check stored refresh token
  → valid  → home
  → absent → /auth (email step)
               → POST /api/auth/request-otp
                   → native path enabled:
                     Loop writes OTP row + sends email
                   → native path disabled:
                     proxied to upstream POST /login
               → (email-enumeration defense: our handler returns 200
                  even when the email is rejected, so the client flow
                  cannot distinguish "new email accepted" from
                  "unknown email rejected")
               → OTP step
               → POST /api/auth/verify-otp
                   → native path enabled:
                     Loop verifies local OTP + mints token pair
                   → native path disabled:
                     proxied to upstream POST /verify-email
               → validated token pair returned
               → store tokens (see below)
               → home

Social sign-in
  → POST /api/auth/social/google or /api/auth/social/apple
  → only available on the Loop-native path
  → Loop verifies provider JWKS + audience, resolves/creates user,
    mints Loop token pair
  → store tokens (same as OTP flow)
  → home

Purchase
  → email already in session — not re-entered
  → Bearer access token on all authenticated requests
  → POST /api/orders → proxied to upstream POST /gift-cards (with Bearer auth)
```

**Token storage:**

- Access token: Zustand memory only
- Refresh token: `@aparajita/capacitor-secure-storage` on native (Keychain / EncryptedSharedPreferences — ADR-006, audit A-024); sessionStorage on web
- Access/refresh pair is **Loop-issued** on the native and social paths, and **CTX-issued** on the legacy proxy path
- Token refresh: POST /api/auth/refresh → native path rotates a Loop refresh JWT; proxy path forwards to upstream POST /refresh-token

**A2-1615 — CSRF posture (do not regress):** Loop uses **Bearer-only**
auth. The backend never sets cookies (`grep -rn "Set-Cookie"
apps/backend/src/` returns zero hits outside tests). CSRF defence is
implicit-by-construction here: a cross-origin attacker page cannot
forge a request that carries the user's `Authorization` header — the
header is added by our own JS, never by the browser auto-sending
cookies. No CSRF token primitive exists today and none is needed.

**Any future move to cookie-based session auth must add CSRF tokens
before rollout.** The migration is silently breaking otherwise: every
authenticated mutation today (orders, emissions, admin writes) would
become forgeable from a malicious origin once cookies start riding
along. If the migration is even being scoped, treat CSRF tokens as a
prerequisite, not a follow-up.

---

## Network egress (A2-1613)

The backend's outbound network surface is **enumerated, not allow-listed**
at the firewall layer. SSRF defence is per-handler — every fetcher
that could ever be redirected by user input has its own allowlist —
and Phase-1 deployments rely on Fly's default outbound policy plus
the per-handler validators.

The full enumeration of known outbound origins:

| Surface              | Origin(s)                                                           | SSRF defence                                                                               |
| -------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **CTX upstream**     | `spend.ctx.com` (configurable via `GIFT_CARD_API_BASE_URL`)         | Origin pinned in env at boot; circuit breaker per-endpoint.                                |
| **Image proxy**      | Per-request user URL                                                | Per-host allowlist (`IMAGE_PROXY_ALLOWED_HOSTS`, audit A-025) + scheme + private-IP guard. |
| **Stellar Horizon**  | `horizon.stellar.org` (configurable via `LOOP_STELLAR_HORIZON_URL`) | Origin pinned in env at boot; per-account / per-asset endpoints only.                      |
| **Price feed**       | `api.coingecko.com`                                                 | Single hardcoded URL; no user-controlled segment.                                          |
| **Google OAuth**     | `googleapis.com`, `accounts.google.com`                             | Hardcoded JWKS + issuer URLs; per-token signature verify.                                  |
| **Apple OAuth**      | `appleid.apple.com`                                                 | Hardcoded JWKS + issuer URLs; per-token signature verify.                                  |
| **Sentry**           | `*.ingest.sentry.io` / `*.ingest.de.sentry.io`                      | DSN baked at deploy time; no user-controlled segment.                                      |
| **Discord webhooks** | `discord.com/api/webhooks/<id>/<token>`                             | Webhook URL baked into Fly secret per channel; allowed_mentions disabled.                  |

**Phase-1 posture:** runtime egress allowlist (e.g. via `iptables` /
Fly Machines policy / a forward proxy) is intentionally **not**
enforced — adding network-level enforcement on top of per-handler
validation is a Phase 2/3 hardening item once the surface stabilises.
The enumeration above is the reviewer-facing audit trail; any new
outbound origin lands here in the same PR that adds it, gated by the
`apps/backend/AGENTS.md` Files table convention.

---

## Image proxy

`GET /api/image?url=<encoded>&width=<n>&height=<n>&quality=<n>&mode=<public|private>`

- Fetches upstream image, resizes with `sharp`, serves with cache headers
- LRU in-memory cache: 100 MB max, 7-day TTL
- `mode=private` bypasses the shared LRU cache and returns `Cache-Control: private, no-store`; used for authenticated redemption barcode imagery so order-bound assets do not become public cache objects
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
| `failureThreshold` | 5       | Consecutive 5xx/429/network failures to trip |
| `cooldownMs`       | 30 000  | Milliseconds in OPEN before allowing a probe |

- **4xx responses** do not count as failures (client errors, not upstream outage) — **except 429** (CF-12): a `429 Too Many Requests` is upstream back-pressure, not a client bug, so it counts toward the failure threshold and never resets the success counter. Without this the breaker would treat every rate-limited response as a success and never open under a CTX rate-limit storm.
- **`forceOpen()`** (CF-13) trips a breaker OPEN out-of-band, bypassing the consecutive-failure count. `operatorFetch` uses it on a CTX `401` (an expired/invalid operator bearer is dead until rotated, so there's no value in waiting for five), pulling the operator from rotation and alerting via `notifyOperatorCredentialExpired`.
- When OPEN, upstream proxy handlers return **503** `Service temporarily unavailable` (not 502).
- The `/health` endpoint bypasses the circuit breaker — it probes upstream directly so external monitors can detect recovery. Probe result is cached 10s (PR #131) to stop an attacker from turning `/health` into an outbound-fetch amplifier; the probe's own fetch timeout is 8s so marginal CTX `/status` latency does not flap the service down prematurely.
- `/health` now reports five operational classes in one response: CTX reachability, merchant/location/GeoLite2-db freshness (`geoDbStale` / `geoDbBuildEpoch` — go-live-plan §T1-F, `docs/deployment.md` §GeoLite2; false when GeoLite2 was never configured at all, not just when fresh), native-auth OTP delivery state, and per-worker runtime state (`payment_watcher`, `procurement_worker`, `payout_worker`, `asset_drift_watcher`, `interest_scheduler`, `interest_mint`, `auth_row_purge`, `redemption_backfill`, `wallet_provisioning`). It also exposes the rate limiter's current fleet-size divisor (`rateLimitFleetEstimate` / `rateLimitFleetEstimateSource` — S4-4, `docs/deployment.md` §Rate-limiter fleet-size estimate; purely informational, doesn't affect `status`).
- Status-change notifications to the Discord monitoring channel are flap-damped by a rolling window: a healthy→degraded flip requires **5 degraded readings in the last 10 probes**, and a degraded→healthy flip requires **8 healthy readings in the last 10 probes**. On top of that detector, `notifyHealthChange` has a 30-minute per-process cooldown so a noisy incident does not flood the channel. The raw `/health` response body is always the current reading so Fly's liveness probe remains undebounced.
- One breaker **per upstream endpoint** — `login`, `verify-email`, `refresh-token`, `logout`, `merchants`, `locations`, `gift-cards`. Lazily created via `getUpstreamCircuit(key)` in `circuit-breaker.ts`. Independent so a failing merchants sync can't trip auth, and a failing gift-cards endpoint can't trip clusters.

---

## Phase 2 — Integrated wallet + per-currency yield (ADR 030 + ADR 031)

Phase 2's wallet model has evolved through three design states. The current state, locked in 2026-05-05, is captured in ADR 030 (wallet) and ADR 031 (per-currency yield).

**State 1 (pre-2026-04, archived)**: 2-of-3 multisig with on-device Ed25519 key in Keychain + server co-signer + recovery custodian. Descoped before any implementation.

**State 2 (2026-04-21, ADR 015)**: External-wallet linking. User pastes a Stellar pubkey into `users.stellar_address`; backend signs outbound LOOP-asset payouts. Three Loop-issued 1:1-backed stablecoins: USDLOOP, GBPLOOP, EURLOOP. Implemented and shipped behind feature flags.

**State 3 (2026-05-05, ADR 030 + ADR 031, NOT YET IMPLEMENTED)**: Integrated cross-platform wallet via Privy (with dfns fallback). Per-currency yield with Loop revenue capture:

| Currency | User holds                                              | Mechanism                                                                                        | APY mechanism                               |
| -------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| USD      | LOOPUSD (Soroban DeFindex vault share, Loop is curator) | Vault holds USDC, routes to Blend USDC pool. 0% mgmt + 50% perf fee.                             | Variable, displayed as past 30-day realised |
| EUR      | LOOPEUR (Soroban DeFindex vault share, Loop is curator) | Vault holds EURC, routes to Blend EURC pool. Same fee schedule.                                  | Variable, displayed as past 30-day realised |
| GBP      | GBPLOOP (Stellar classic asset, 1:1 GBP-backed)         | Loop's treasury holds GBP fiat, invests for yield. **Nightly on-chain 3% APY mints to holders.** | 3% APY fixed (policy variable, adjustable)  |

USDLOOP and EURLOOP **retire** in State 3 — users hold canonical vault shares (LOOPUSD/LOOPEUR) instead of Loop-issued 1:1 wrappers for those currencies. Only GBPLOOP remains as a Loop-issued 1:1-backed stablecoin (because no on-chain GBP yield primitive exists on Stellar).

| Component                                | Location                                                      | Role                                                                                                                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User wallet (State 3)                    | Privy-provisioned (or dfns fallback)                          | Embedded MPC wallet keyed on Loop's `user_id`. Cross-platform, single-auth identity-bound. Holds LOOPUSD/LOOPEUR/GBPLOOP.                                                                                                                                     |
| Operator secret                          | Backend env (`LOOP_STELLAR_OPERATOR_SECRET`)                  | Backend signs outbound LOOP-asset payments + nightly GBPLOOP mints. See `payments/payout-submit.ts`.                                                                                                                                                          |
| Payout channel accounts (ADR 044 / S4-1) | Backend env (`LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS`, optional) | N pre-funded accounts the payout worker uses as tx source (sequence + fee) so N submits run concurrently; never hold the LOOP asset — the operator/issuer stays the actual funder via an op-level `source` override. See `docs/adr/044-payout-throughput.md`. |
| GBPLOOP issuer                           | Backend env (`LOOP_STELLAR_GBPLOOP_ISSUER`)                   | Issuer pubkey for GBPLOOP. Asset-drift watcher reconciles on-chain circulation against off-chain GBP backing.                                                                                                                                                 |
| LOOPUSD vault contract                   | Soroban (Stellar mainnet)                                     | Loop-curated DeFindex vault for USDC backing. Vault share token IS LOOPUSD; users hold it directly.                                                                                                                                                           |
| LOOPEUR vault contract                   | Soroban (Stellar mainnet)                                     | Same shape, EURC.                                                                                                                                                                                                                                             |

**State 2 → State 3 migration**: removes `LinkWalletNudge`, `TrustlineSetupCard`, the `PUT /api/users/me/stellar-address` user-input endpoint (becomes Privy-webhook-populated), and the asset-drift watcher's USDLOOP/EURLOOP entries. Keeps the `users.stellar_address` column (now populated by Privy webhook), the FX-pin behaviour, the cross-FX cashback emission, and the operator/issuer-account architecture for GBPLOOP. ADR 030's File map and ADR 031's File map list the affected files.

### Vault subsystem foundation (ADR 031 §Detailed design D3/D9, V1 — dark)

The first build increment toward State 3's LOOPUSD/LOOPEUR vaults (above) is schema + config + a read layer only — NO Soroban client, NO emission/withdraw logic (those are later PRs, ADR 031 §D5/D6). Ships dark: `LOOP_VAULTS_ENABLED` (default `false`) is the vault-subsystem master switch — distinct from `LOOP_PHASE_1_ONLY`, which gates the user-facing cashback/wallet surface generally. An empty `loop_vaults` table + the flag off is byte-identical to pre-migration.

- `loop_vaults` (migration 0060) — registry, one row per `(asset_code, network)` (unique index): the deployed DeFindex vault's contract id, share-token identity (`share_asset_code`/`share_asset_issuer`), underlying asset + issuer, Blend strategy id, and performance-fee bps. CHECK constraints pin `asset_code` to `LOOPUSD`/`LOOPEUR` (GBPLOOP is a classic 1:1 asset with its own interest-mint path, migration 0041 — not a vault) and `network` to `testnet`/`mainnet`. Starts EMPTY — the operator inserts the deployed vault addresses post-deploy (ADR 031 §D9 step 1/6); no admin write endpoint exists yet.
- `vault_share_price_snapshots` (migration 0060) — `(asset_code, network, taken_at, share_price_ppm, source_ledger)`, indexed on `(asset_code, network, taken_at DESC)`. Feeds the later past-30-day APY computation (ADR 031 §D8); this PR ships the table + a record/read helper pair, no scheduled snapshotter yet.
- `apps/backend/src/credits/vaults/registry.ts` — the read layer: `vaultsEnabled()`, `getActiveVault()`, `listActiveVaults()`, `recordSharePriceSnapshot()`, `getLatestSharePrice()`. Every function checks `vaultsEnabled()` first — belt-and-suspenders so a populated-but-not-yet-live registry can't be read by anything downstream even once rows exist.

Full build sequence (vault deploy → Soroban integration → wallet-provider signing → watchers/APY → config review → mainnet): ADR 031 §Detailed design D9.

---

## Fraud / abuse controls (ADR 045, B-3)

Phase-1 build, two controls, both in `apps/backend/src/fraud/`:

- **Per-user order-create velocity limit** (`fraud/velocity.ts`). Called
  from `orders/loop-handler.ts` before `createOrder` — a bounded,
  indexed query (reuses the `orders_user_created` index) counts and
  sums the user's own orders in a rolling window; over
  `LOOP_ORDER_VELOCITY_MAX_PER_WINDOW` orders or
  `LOOP_ORDER_VELOCITY_MAX_VALUE_MINOR` of charge value in one
  currency within `LOOP_ORDER_VELOCITY_WINDOW_HOURS` hours rejects
  with 429 `ORDER_VELOCITY_EXCEEDED` before any write. Per-USER, not
  per-IP — bounds one account's blast radius independent of the
  existing per-IP rate limiter. Fails CLOSED (503
  `ORDER_VELOCITY_CHECK_UNAVAILABLE`) if the query itself errors.
- **Duplicate-account detection** (`fraud/duplicate-account-signals.ts`).
  Called from `payments/watcher.ts` AFTER a `pending_payment → paid`
  transition commits (fire-and-forget, never inside the transition).
  Looks for other users' paid orders funded from the same on-chain
  source account (`orders.payment_received_payment->>'from'`,
  expression-indexed via `orders_payment_source_account`); a match
  writes one row to `fraud_signals` (migration 0059) and pages
  `#loop-monitoring` on first occurrence. **Flag only — never
  auto-blocks.**

Both controls, the full design rationale (why per-currency not
FX-converted, why the query is shaped the way it is, the fail-safe
posture), and what's explicitly deferred (device/IP signup capture, a
real chargeback state machine for the eventual card/Plaid rail) are in
ADR 045.

---

## Backend API endpoints

```
GET  /health
GET  /metrics                               — Prometheus format
GET  /openapi.json                          — full OpenAPI 3.1 spec, bearer-gated, `private, no-store`
GET  /.well-known/jwks.json                 — public RSA JWKS for Loop-minted RS256 JWTs (ADR 030 Phase A), `public, max-age=3600`
GET  /.well-known/apple-app-site-association — iOS Universal Links domain-verification (M-3); 404 WELL_KNOWN_NOT_CONFIGURED until APPLE_TEAM_ID is set, `public, max-age=300`
GET  /.well-known/assetlinks.json            — Android App Links domain-verification (M-3); 404 WELL_KNOWN_NOT_CONFIGURED until ANDROID_CERT_SHA256 is set, `public, max-age=300`
GET  /api/merchants              ?page=&limit=&q=      — paginated, max 100 per page
GET  /api/merchants/all                                 — full catalog in one response (audit A-002); `?fields=lite` strips description/instructions/terms for browse (S4-7)
GET  /api/merchants/search       ?q=&country=&limit=    — server-side name search, bounded (default 20/max 50), lite projection (S4-7 §3 tail)
GET  /api/merchants/by-slug/:slug
GET  /api/merchants/:id
GET  /api/merchants/cashback-rates              — public bulk map of active cashback pcts (ADR 011/015)
GET  /api/merchants/:merchantId/cashback-rate   — public cashback-% preview (ADR 011/015)
GET  /api/clusters           ?west=&south=&east=&north=&zoom=
GET  /api/image              ?url=&width=&height=&quality=&mode=
GET  /api/config                            — client feature flags (ADR 010 / 013)
POST /api/auth/request-otp
POST /api/auth/verify-otp
POST /api/auth/refresh
POST /api/auth/social/google                — ADR 014
POST /api/auth/social/apple                 — ADR 014
DELETE /api/auth/session
DELETE /api/auth/session/all                             [authed — B4: sign out of all devices; revokes every live refresh token]
POST /api/orders             [authenticated]
POST /api/orders/loop        [authenticated — Loop-native flow, ADR 010 + Idempotency-Key, A2-2003; `credit` method is migration-window only — wallet-activated users get 400 CREDIT_METHOD_RETIRED and spend via token redemption, ADR 036 OQ3; `loop_asset` gets 400 LOOP_ASSET_UNAVAILABLE_PHASE_1 while LOOP_PHASE_1_ONLY=true (AUDIT-2 finding B); gated by the ADR 045 (B-3) per-user velocity check before creation — 429 ORDER_VELOCITY_EXCEEDED / 503 ORDER_VELOCITY_CHECK_UNAVAILABLE]
GET  /api/orders/loop        [authenticated — Loop-native list, ADR 010]
GET  /api/orders/loop/:id    [authenticated — Loop-native flow, ADR 010]
POST /api/orders/loop/:id/redeem [authenticated — one-tap LOOP-asset redemption from the embedded wallet: user-signed inner payment + operator fee-bump; watcher settles downstream, ADR 030 C3 / ADR 036; 400 LOOP_ASSET_UNAVAILABLE_PHASE_1 while LOOP_PHASE_1_ONLY=true, fail-closed even for pre-existing orders (AUDIT-2 finding B). ADR 031 §D6 (V4): when the order's chargeCurrency is vault-eligible (USD/EUR) and LOOP_VAULTS_ENABLED is on, forks internally to a Soroban vault-share redemption (orders/redeem-vault.ts + credits/vaults/vault-redemptions.ts) instead of the classic on-chain payment — same request/response shape, same status codes; gated off is byte-identical to the classic path above]
GET  /api/orders             [authenticated]
GET  /api/orders/:id         [authenticated]
GET  /api/users/me           [authenticated — profile + home_currency, ADR 015]
POST /api/users/me/home-currency   [authenticated — first-time-set (order-less), ADR 015]
PUT  /api/users/me/stellar-address [authenticated — link/unlink Stellar wallet for payouts, ADR 015]
GET  /api/users/me/dsr/export      [authenticated — DSR / GDPR portability self-serve data export, A2-1906]
POST /api/users/me/dsr/delete      [authenticated — DSR / GDPR right of erasure (anonymisation), A2-1905]
GET  /api/users/me/stellar-trustlines [authenticated — per-LOOP-asset trustline status for caller's linked Stellar address; Horizon-backed 30s cache, ADR 015]
GET  /api/users/me/cashback-history [authenticated — recent credit-ledger events, ADR 009/015]
GET  /api/users/me/cashback-history.csv [authenticated — full credit-ledger CSV dump, ADR 009]
GET  /api/users/me/credits         [authenticated — per-currency balance list, ADR 009/015]
GET  /api/users/me/pending-payouts  [authenticated — caller's on-chain payout rows, ADR 015/016]
GET  /api/users/me/pending-payouts/summary [authenticated — aggregate view of in-flight payouts, bucketed by (asset, state), ADR 015/016]
GET  /api/users/me/pending-payouts/:id [authenticated — single payout detail, ADR 015/016]
GET  /api/users/me/orders/:orderId/payout [authenticated — per-order settlement drill, mirror of admin /api/admin/orders/:orderId/payout, ADR 015/016]
GET  /api/users/me/cashback-summary [authenticated — compact { lifetime, thisMonth } totals, ADR 009/015]
GET  /api/users/me/cashback-by-merchant [authenticated — top cashback-earning merchants in window, ADR 009/015]
GET  /api/users/me/cashback-monthly [authenticated — last 12 months of cashback totals by (month,currency), ADR 009/015]
GET  /api/users/me/orders/summary   [authenticated — 5-number orders-page summary header, ADR 010/015]
GET  /api/users/me/flywheel-stats   [authenticated — caller's LOOP-asset recycled order count + charge, ADR 015]
GET  /api/users/me/payment-method-share [authenticated — caller's own rail mix, home-currency locked, ADR 010/015]
GET  /api/me/wallet                [authenticated — embedded-wallet balance surface: address + provisioning + on-chain LOOP balances + interest APY (non-zero only when the ADR 031 on-chain mint path is enabled); never-500 last-known-good fallback, ADR 030 C4 / ADR 036]
GET  /api/me/vault-apy             [authenticated — past-30d/90d realised APY per LOOP-branded yield asset (LOOPUSD/LOOPEUR from vault share-price history, GBPLOOP from interest-mint history); never discloses the yield mechanism, ADR 031 §D8]
GET  /api/public/cashback-stats    [public — landing-page aggregates, never-500, ADR 009/015/020]
GET  /api/public/top-cashback-merchants [public — landing-page "best cashback" list: ?limit + ?country (CAT-02) scoping, never-500, ADR 011/020]
GET  /api/public/merchants/:id     [public — per-merchant SEO detail (accepts id or slug); ?country (CAT-02) 404s an out-of-country merchant, never-500, ADR 011/020]
GET  /api/public/cashback-preview  [public — pre-signup "calculate your cashback" preview: ?merchantId + ?amountMinor → floor-rounded cashback, never-500, ADR 011/015/020]
GET  /api/public/loop-assets       [public — configured (code, issuer) pairs for trustline setup, never-500, ADR 015/020]
GET  /api/public/flywheel-stats    [public — 30-day fulfilled + recycled counts + % pill, never-500, ADR 015/020]
GET  /api/public/geo               [public — IP-geolocation first guess for the `/` locale redirect + onboarding currency → { countryCode, region }, never-500, ADR 020/033/034]
POST /api/public/rum               [public — first-party, cookieless RUM intake: one Core Web Vital observation or a bare page-view marker, folded into /metrics (loop_web_vital_* / loop_page_views_total); no DB, no PII, no persistent id, never-500, ADR 020/048]
GET  /api/admin/merchant-cashback-configs              [admin]
GET  /api/admin/merchant-cashback-configs/history      [admin — fleet-wide config-edit audit feed, ADR 011/018]
PUT  /api/admin/merchant-cashback-configs/:merchantId  [admin]
GET  /api/admin/merchant-cashback-configs/:merchantId/history  [admin]
GET  /api/admin/treasury                               [admin]
GET  /api/admin/treasury.csv                           [admin — Tier-3 long-form CSV of the treasury snapshot for SOC-2 / audit evidence, ADR 009/015/018]
GET  /api/admin/treasury/credit-flow                   [admin — per-day credited/debited/net ledger time-series, ?days=1-180, ?currency=USD|GBP|EUR, ADR 009/015]
GET  /api/admin/treasury/credit-flow.csv               [admin — Tier-3 CSV of the credit-flow time series for month-end ledger reconciliation, ADR 009/015/018]
GET  /api/admin/assets/:assetCode/circulation          [admin — per-asset circulation drift: onChain stroops vs ledger liability, ADR 015]
GET  /api/admin/asset-drift/state                      [admin — persisted snapshot of the asset-drift watcher (asset_drift_state table): per-asset drift state + failed burn/mint rows dimension + last tick ms, ADR 015]
GET  /api/admin/operator-float/movements               [admin — R3-1 operator XLM/USDC wallet movement drilldown, defaults to unclassified movements for float-reconciliation triage]
POST /api/admin/operator-float/baselines               [admin + step-up(operator-float) — R3-1 audited reconciliation baseline, idempotent ADR 017 write]
POST /api/admin/operator-float/manual-movements        [admin + step-up(operator-float) — R3-1 audited manual float movement/explanation, idempotent ADR 017 write]
GET  /api/admin/interest/mint-forecast                 [admin — forward-mint forecast for the interest pool: per-currency cohort balance, daily interest, pool balance, days of cover, recommended next-mint amount, ADR 009/015]
GET  /api/admin/payouts/settlement-lag                 [admin — p50/p95/max seconds from payout-intent to on-chain confirm, per LOOP asset + fleet-wide, ADR 015/016]
GET  /api/admin/cashback-realization                   [admin — per-currency lifetime earned vs spent vs outstanding; recycledBps = flywheel-health KPI, ADR 009/015]
GET  /api/admin/cashback-realization/daily             [admin — daily time-series of earned/spent/recycledBps per currency over N days; sparkline-ready dense output, ADR 009/015]
GET  /api/admin/cashback-realization/daily.csv         [admin — Tier-3 finance CSV export of the daily realization trend (day,currency,earned_minor,spent_minor,recycled_bps), ADR 009/015/018]
GET  /api/admin/payouts                                [admin — ADR 015 payout backlog, ?state/?userId/?assetCode filters]
GET  /api/admin/payouts/:id                            [admin — single pending-payout drill-down]
POST /api/admin/payouts/:id/retry                      [admin — reset failed payout to pending, ADR 015/016/017]
POST /api/admin/payouts/:id/compensate                 [admin — re-credit user after permanently failed LEGACY withdrawal payout, ADR 024 §5 / ADR 036]
GET  /api/admin/payouts-by-asset                       [admin — per-asset × per-state payout breakdown, ADR 015/016]
GET  /api/admin/top-users                               [admin — ranked top users by cashback, ADR 009/015]
GET  /api/admin/audit-tail                              [admin — newest-first admin-write audit rows + ?before cursor, ADR 017/018]
GET  /api/admin/audit-tail.csv                          [admin — finance/legal CSV export of admin write-audit, ADR 017/018]
POST /api/admin/users/:userId/credit-adjustments        [admin — signed credit adjustment, ADR 017]
POST /api/admin/users/:userId/refunds                   [admin — order-bound refund, ADR 017 + A2-901]
POST /api/admin/users/:userId/emissions                 [admin — queue on-chain LOOP backfill, mirror NOT debited, ADR-024 / ADR 036]
POST /api/admin/users/:userId/home-currency              [admin — change home_currency with safety preflight, ADR 015 deferred]
POST /api/admin/users/:userId/revoke-sessions            [admin — B4: revoke a user's live sessions (incident response); step-up-exempt]
GET  /api/admin/users/:userId/auth-state                 [staff — A5-3: B5 verify-otp lockout snapshot + OTP request/verify timestamps + live-session count; read-only, never returns a code/hash]
POST /api/admin/users/:userId/clear-otp-lockout          [admin — A5-3: clear the B5 verify-otp lockout counter (reuses clearOtpAttempts); ADR-017-lite (Idempotency-Key + reason), step-up-exempt]
POST /api/admin/deposits/:paymentId/refund               [admin + step-up — A6: refund an abandoned late deposit to its on-chain sender]
GET  /api/users/me/favorites                            [user — favourite merchants, newest first; joined to in-memory catalog]
POST /api/users/me/favorites                            [user — add a merchant to favourites; idempotent on (user_id, merchant_id)]
DELETE /api/users/me/favorites/:merchantId              [user — remove a merchant from favourites; idempotent]
GET  /api/users/me/recently-purchased                   [user — distinct merchants from purchased orders, most-recent first]
POST /api/admin/step-up                                 [admin — mint 5-min step-up token, ADR-028 / A4-063]
GET  /api/admin/payouts.csv                            [admin — finance-ready CSV export, ADR 015]
GET  /api/admin/orders                                  [admin — Loop-native orders drill-down + ?state/?userId/?merchantId/?chargeCurrency/?paymentMethod/?ctxOperatorId filters, ADR 011/013/015]
GET  /api/admin/merchant-flows                          [admin — per-merchant fulfilled-order flow, ADR 011/015]
GET  /api/admin/discord/config                          [admin — webhook env-var configured? ADR 018]
GET  /api/admin/users/search                            [admin — find users by email fragment, ADR 011]
GET  /api/admin/user-credits.csv                        [admin — Tier-3 CSV of off-chain balances, ADR 009/019]
GET  /api/admin/reconciliation                          [admin — ledger drift check, ADR 009]
GET  /api/admin/operator-stats                          [admin — per-operator order volume + success rate, ADR 013]
GET  /api/admin/operators/latency                       [admin — per-operator p50/p95/p99 fulfilment latency, ADR 013/022]
GET  /api/admin/operators-snapshot.csv                  [admin — Tier-3 CSV joining operator-stats + latency per operator for CTX quarterly reviews, ADR 013/018/022]
GET  /api/admin/orders/activity                         [admin — N-day created/fulfilled sparkline, ADR 010]
GET  /api/admin/orders.csv                              [admin — finance-ready CSV export, ADR 011/015]
GET  /api/admin/stuck-orders                            [admin — SLO stuck-in-paid/procuring triage, ADR 011/013]
GET  /api/admin/stuck-payouts                           [admin — SLO stuck-in-pending/submitted payouts, ADR 015/016]
GET  /api/admin/cashback-activity                       [admin — daily cashback-accrual sparkline, ADR 009/015]
GET  /api/admin/cashback-activity.csv                   [admin — finance CSV export of daily × per-currency accrual, ADR 009/015/018]
GET  /api/admin/cashback-monthly                        [admin — 12-month fleet-wide per-(month,currency) cashback emissions, ADR 009/015]
GET  /api/admin/payouts-monthly                         [admin — 12-month fleet-wide per-(month,asset) confirmed payout totals, ADR 015/016]
GET  /api/admin/payouts-activity                        [admin — daily per-asset confirmed-payout sparkline series (1-180d), ADR 015/016]
GET  /api/admin/payouts-activity.csv                    [admin — Tier-3 CSV of daily × per-asset confirmed payouts for month-end close, ADR 015/016/018]
GET  /api/admin/merchant-stats                          [admin — per-merchant cashback stats, ADR 011/015]
GET  /api/admin/merchant-stats.csv                      [admin — per-merchant CSV for CTX negotiation, ADR 011/015/018]
GET  /api/admin/merchants/:merchantId/operator-mix      [admin — per-merchant × per-operator attribution for incident triage, ADR 013/022]
GET  /api/admin/merchants/flywheel-share                [admin — per-merchant loop_asset recycled leaderboard, ADR 011/015]
GET  /api/admin/merchants/flywheel-share.csv            [admin — Tier-3 CSV export of the flywheel leaderboard, ADR 011/015/018]
GET  /api/admin/merchants/:merchantId/flywheel-stats    [admin — per-merchant scalar flywheel stats for the drill page, ADR 011/015]
GET  /api/admin/merchants/:merchantId/cashback-summary  [admin — per-currency lifetime cashback paid out on fulfilled orders, ADR 009/011/015]
GET  /api/admin/merchants/:merchantId/payment-method-share [admin — rail mix for one merchant, sibling of fleet-wide share, ADR 010/015]
GET  /api/admin/merchants/:merchantId/cashback-monthly  [admin — 12-month per-merchant cashback emission trend, ADR 009/011/015]
GET  /api/admin/merchants/:merchantId/flywheel-activity [admin — daily per-merchant recycled-vs-total fulfilled-order series (1-180d), ADR 011/015]
GET  /api/admin/merchants/:merchantId/flywheel-activity.csv [admin — Tier-3 CSV of per-merchant flywheel-activity for BD / commercial prep, ADR 011/015/018]
GET  /api/admin/merchants/:merchantId/top-earners       [admin — ranked top cashback earners at one merchant (inverse of user-cashback-by-merchant), ADR 009/011/015]
GET  /api/admin/merchant-cashback-configs.csv           [admin — snapshot CSV of commercial terms, ADR 011/018]
GET  /api/admin/merchants-catalog.csv                   [admin — full catalog + joined cashback config state as CSV for finance/BD, ADR 011/018]
GET  /api/admin/orders/:orderId                         [admin — single order detail, ADR 011/015]
GET  /api/admin/orders/:orderId/payout                  [admin — payout row for a given order]
GET  /api/admin/orders/payment-method-share             [admin — cashback-flywheel metric: xlm/usdc/credit/loop_asset share, ADR 010/015]
GET  /api/admin/orders/payment-method-activity          [admin — daily payment-method time-series (1-90d), trend complement to the share, ADR 010/015]
GET  /api/admin/supplier-spend                          [admin — per-currency supplier spend, ADR 013/015]
GET  /api/admin/supplier-spend/activity                 [admin — per-day per-currency supplier spend time-series (1-180d, ?currency=USD|GBP|EUR), ADR 013/015]
GET  /api/admin/supplier-spend/activity.csv             [admin — Tier-3 CSV of daily × per-currency supplier spend for month-end CTX-invoice reconciliation, ADR 013/015/018]
GET  /api/admin/operators/:operatorId/supplier-spend    [admin — per-operator per-currency supplier spend (axis of fleet supplier-spend), ADR 013/015/022]
GET  /api/admin/operators/:operatorId/activity          [admin — per-operator daily created/fulfilled/failed time-series (1-90d), ADR 013/022]
GET  /api/admin/operators/:operatorId/merchant-mix      [admin — per-operator × per-merchant attribution (dual of /merchants/:id/operator-mix), ADR 013/022]
GET  /api/admin/users                                   [admin — paginated user directory w/ email fragment filter]
GET  /api/admin/users/by-email?email=                   [admin — exact-match user lookup for support-ticket workflow]
GET  /api/admin/users/top-by-pending-payout             [admin — ops funding prioritisation leaderboard, ADR 015/016]
GET  /api/admin/users/recycling-activity                 [admin — 90-day list of users recycling LOOP-asset cashback, ADR 015]
GET  /api/admin/users/recycling-activity.csv             [admin — Tier-3 CSV export of the user recycling leaderboard, ADR 015/018]
GET  /api/admin/users/:userId                           [admin — single-user detail]
GET  /api/admin/users/:userId/credits                   [admin — per-user credit balance, ADR 009]
GET  /api/admin/users/:userId/cashback-by-merchant       [admin — per-user cashback-by-merchant support triage, ADR 009/015]
GET  /api/admin/users/:userId/cashback-summary           [admin — scalar lifetime + this-month cashback headline, ADR 009/015]
GET  /api/admin/users/:userId/flywheel-stats             [admin — scalar recycled-vs-total per-user flywheel mirror, ADR 015]
GET  /api/admin/users/:userId/cashback-monthly           [admin — 12-month per-user cashback emission trend, ADR 009/015]
GET  /api/admin/users/:userId/payment-method-share       [admin — per-user rail mix, sibling of fleet + per-merchant share, ADR 010/015]
GET  /api/admin/users/:userId/credit-transactions       [admin — per-user credit-ledger log, ADR 009]
GET  /api/admin/users/:userId/credit-transactions.csv   [admin — per-user credit-ledger CSV for compliance / SAR, ADR 009/015]
GET  /api/admin/users/:userId/operator-mix              [admin — per-user × per-operator attribution for support triage, ADR 013/022]
POST /api/admin/merchants/resync                        [admin — force an immediate CTX merchant-catalog sweep, ADR 011]
GET  /api/admin/discord/notifiers                       [admin — static catalog of Discord notifiers, ADR 018]
POST /api/admin/discord/test                            [admin — fire a benign test ping at a Discord channel, ADR 018]
GET  /api/admin/staff                                   [admin — staff list incl. legacy is_admin shim entries + grant metadata, ADR 037]
PUT  /api/admin/staff/:userId/role                      [admin — grant/change a staff role; step-up + ADR-017 envelope; last-admin + self-demotion guards, ADR 037]
DELETE /api/admin/staff/:userId/role                    [admin — revoke staff access; step-up + ADR-017 envelope; last-admin + self-revoke guards, ADR 037]
GET  /api/admin/lookup?q=                               [staff — reverse lookup: order id | payment memo | Stellar address → owning user; index-backed only, ADR 037]
GET  /api/admin/watcher-skips                           [staff — payment_watcher_skips browser, ?status/?reason filters + ?before keyset cursor, ADR 037]
GET  /api/admin/watcher-skips/:paymentId                [staff — skip-row detail incl. the Horizon payment snapshot, ADR 037]
POST /api/admin/watcher-skips/:paymentId/reopen         [staff — support action: abandoned → pending with attempts reset; ADR-017 envelope, ADR 037]
GET  /api/admin/users/:userId/wallet                    [staff — wallet card: provider/wallet_id/addresses/provisioning + on-chain balances via the trustline reader, ADR 030/037]
POST /api/admin/users/:userId/wallet/reprovision        [staff — support action: reset provisioning attempts + re-enqueue the drive; ADR-017 envelope, ADR 037]
POST /api/admin/orders/:orderId/refetch-redemption      [staff — support action: one-shot redemption re-fetch via the backfill machinery; ADR-017 envelope, ADR 037]
POST /api/admin/orders/:orderId/redrive                 [admin — A5-1 order re-drive lever: re-runs the procurement worker's own path for a stuck PAID order the worker never drained (procuring refused — the recovery sweep owns those); step-up gated, ADR-017 envelope]
POST /api/admin/orders/:orderId/refund                  [admin — A5-4 order-bound refund: paid/failed refund directly, procuring only once stale (>15-min sweep cutoff) AND CTX-unpaid, fulfilled needs a code-unused attestation ({codeUnused,attestationNote}); reuses the existing refund primitives per payment_method (on-chain refund-to-sender for xlm/usdc, mirror credit for credit, fail-closed for loop_asset); paid/procuring fenced to failed first; INV-8-idempotent; step-up gated (order-refund scope), ADR-017 envelope]
POST /api/admin/vault-emissions/:id/redrive              [admin — ADR 031 V7 vault-emission re-drive: re-enters the existing driveOneVaultEmission for a failed (attempts-exhausted) or operator-confirmed-stuck row; resume state inferred from persisted depositedAt/transferredAt landing markers (never blindly reset to pending) so a completed deposit/transfer is verified via CF-18 priorTxHash, never re-submitted; serialised against the emission sweep via its fleet-wide advisory lock (a reclaimed row skips the pending→depositing CAS, so an un-serialised re-drive racing the sweep is a double-deposit/double-transfer vector) — 409 VAULT_EMISSION_REDRIVE_SWEEP_IN_PROGRESS when the sweep holds the lock; refuses (409) an already-mirrored row; step-up gated (vault-redrive scope), ADR-017 envelope]
POST /api/admin/vault-redemptions/:id/redrive            [admin — ADR 031 V7 vault-redemption re-drive: re-enters the existing driveOneVaultRedemption; failed rows resume from redeemedAt (redeemed → only the mirror step re-runs; otherwise collecting → the existing branch skips an already-landed collect); a needs-refund row (markRedemptionNeedsRefund signature) is refused with 409 rather than silently re-attempting a payout; refuses (409) an already-settled row; step-up gated (vault-redrive scope, shared with the emission-side endpoint), ADR-017 envelope]
GET  /api/admin/ledger                                  [staff — fleet-wide credit_transactions browser: ?userId/?type/?referenceType+?referenceId/?since/?before filters, keyset-paginated (?before cursor, limit [1,200] default 50), read-only, ADR 037 §4.2 / A5-8]
GET  /api/admin/users/:userId/audit                     [staff — per-subject audit timeline: merges admin actions targeting this user + credit_transactions + orders + payouts + refresh_tokens revocations + an OTP-lock snapshot into one newest-first page; ?limit (per-source, default 8/[1,20]); PER-SOURCE COMPOUND (timestamp,id) keyset cursors (response.nextCursors {at,id} → request beforeAdminActions/beforeLedger/beforeOrders/beforePayouts/beforeSessions as "<iso>|<id>") so uneven-density sources page independently AND tied-timestamp batches (e.g. a mass session revoke stamping one revokedAt on many rows) don't drop rows; read-only, ADR 037 §4 / A5-7]
```

Since ADR 037 the `/api/admin/*` namespace is staff-gated, not
admin-gated: the blanket middleware is `requireStaff('support')`
(resolving the role from `staff_roles`, falling back to the
deprecated `users.is_admin` shim) and admin-only mounts each carry
an explicit per-route `requireStaff('admin')`. Endpoints tagged
`[admin]` above 404 for support; `[staff]` endpoints accept both
roles. The split follows the ADR 037 matrix: all read views are
support-visible EXCEPT bulk CSV exports (every `.csv` path) and the
Discord config trio, which stay admin-only along with every money
write, role management, and the step-up mint. Non-staff users get
the same 404 concealment as before.

Full request/response shapes — including field types, pagination
envelopes, and error codes per endpoint — are generated from the backend
zod schemas and served live at `GET /openapi.json`. The route is
bearer-gated when `OPENAPI_BEARER_TOKEN` is configured and always emits
`Cache-Control: private, no-store` plus `Vary: Authorization` so an
intermediary cache cannot replay the admin-inclusive spec across
callers. The schema source is
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

Proxy-path auth requests map platform to CTX `clientId`: `web` →
`loopweb`, `ios` → `loopios`, `android` → `loopandroid`. Loop-native
auth accepts the same platform field so the client contract stays
uniform, but does not send `clientId` upstream because CTX is bypassed.
All authenticated upstream requests still include the `X-Client-Id`
header when Loop calls CTX on behalf of the user.
