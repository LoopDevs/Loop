# Phase 2 — Architecture compliance (evidence)

**Commit SHA at capture:** `450011ded294b638703a9ba59f4274a3ca5b7187`
**Audit branch:** `main` (worktree clean-ish; uncommitted onboarding work
unrelated to phase 2 scope, confirmed not read for conclusions)
**Date captured:** 2026-04-23

---

## 0. Method recap

Seven `AGENTS.md §Critical architecture rules` checked by grep per plan
§Phase 2 Method. 23 ADRs reconciled via §5.3 (decision statement → find
implementation → read implementation → classify). Negative-space
(plan G3-13) enumerated at the end. Evidence was gathered without
consulting `docs/codebase-audit.md`, `docs/audit-checklist.md`, or
`docs/audit-tracker.md` per plan §0.2.

---

## 1. Per-rule evidence

### Rule 1 — "Web is a pure API client. No server-side data fetching in loaders."

Search for server-side loaders:

```
$ rg -n 'export\s+(async\s+)?function\s+loader' apps/web
apps/web/app/routes/sitemap.tsx:71:export async function loader(): Promise<Response> {

$ rg -n 'clientLoader|clientAction' apps/web
(no matches)

$ rg -n 'useLoaderData' apps/web/app
(no matches)
```

`apps/web/app/routes/sitemap.tsx:38-49` does a server-side fetch to
`${apiBaseUrl()}/api/public/top-cashback-merchants` inside the loader.
The loader body at lines 12-18 self-documents this as a deliberate,
scoped exception ("sitemap is inherently server-rendered content for
crawlers"). `apps/web/app/routes.ts:7-8` excludes the route from the
mobile static export (`BUILD_TARGET=mobile` → `[]`).

**Finding:** AGENTS.md rule #1 text claims "no server-side data
fetching in loaders" with no caveat, while the code has one. Rule text
has drifted from the implementation it governs. See A2-202.

### Rule 2 — "Auth is proxied through upstream CTX. Backend does not generate OTPs, issue JWTs, or send emails."

Search for backend JWT minting:

```
$ rg -n 'signLoopToken|verifyLoopToken|LOOP_JWT_SIGNING_KEY' apps/backend/src
apps/backend/src/auth/tokens.ts: (full HS256 sign/verify module)
apps/backend/src/auth/handler.ts: ... calls signLoopToken
apps/backend/src/auth/native.ts: ... native OTP + sign flow
apps/backend/src/auth/otps.ts: (OTP generation + storage)
apps/backend/src/auth/refresh-tokens.ts: (refresh token table)
apps/backend/src/auth/social.ts: (Google/Apple id_token → Loop JWT)
apps/backend/src/auth/identities.ts: (user_identities multi-provider)
```

`apps/backend/src/auth/tokens.ts:72-92` signs HS256 JWTs keyed on
`LOOP_JWT_SIGNING_KEY`. Access 15 min, refresh 30 days. Includes
custom `typ: 'access' | 'refresh'` claim. Full Loop-owned token mint.

The migration is covered by ADR-013 ("Loop-owned auth and CTX
operator-account pool") and ADR-014 (social login). Both are Proposed
but their artefacts (tables, env vars, handlers, migrations) are
landed in `apps/backend/src/db/schema.ts` and under `apps/backend/src/auth/*`.

**Finding:** AGENTS.md rule #2 is directly contradicted by ADR-013's
implementation: the backend mints JWTs, generates OTPs, and (per
ADR-013 rollout checklist) is designed to send Loop-branded emails via
`auth/email.ts`. The rule text hasn't been updated despite 13 ADR-013
slices landing. See A2-203.

Zod validation on remaining CTX-proxy paths (for legacy compat) is
confirmed: `apps/backend/src/auth/handler.ts:41-48, 155, 232` —
`VerifyOtpUpstreamResponse` and `RefreshUpstreamResponse` are
`safeParse`d before forwarding.

### Rule 3 — "All Capacitor plugin calls live in `apps/web/app/native/`."

```
$ rg -n "from '@capacitor/|from '@capacitor-community/|from '@aparajita/capacitor|from '@capgo/" apps/web/app
apps/web/app/native/secure-storage.ts:1:import { Capacitor } from '@capacitor/core';
apps/web/app/native/biometrics.ts:1:import { Capacitor } from '@capacitor/core';
apps/web/app/native/haptics.ts:1: ...
apps/web/app/native/platform.ts:1: ...
apps/web/app/native/network.ts:1: ...
apps/web/app/native/app-lock.ts:1: ...
apps/web/app/native/purchase-storage.ts:1: ...
apps/web/app/native/back-button.ts:1: ...
apps/web/app/native/clipboard.ts:1: ...
apps/web/app/native/share.ts:1: ...
apps/web/app/native/keyboard.ts:1: ...
apps/web/app/native/screenshot-guard.ts:1: ...
apps/web/app/native/status-bar.ts:1: ...
apps/web/app/native/webview.ts:1: ...
apps/web/app/native/notifications.ts:1: ...
apps/web/app/native/__tests__/secure-storage-native.test.ts:37:vi.mock('@aparajita/capacitor-secure-storage', ...)
```

Every Capacitor import sits under `apps/web/app/native/` (or a test
`__tests__` sibling). `eslint.config.js:96-112` codifies the rule
with `no-restricted-imports` on `@capacitor/*`, `@aparajita/capacitor-*`,
`@capgo/*`, ignoring `apps/web/app/native/**`.

**Status: in-sync.** No drift.

### Rule 4 — "Static export constraint: `BUILD_TARGET=mobile` → loaders cannot run server-side."

```
$ rg -n "BUILD_TARGET" apps/web
apps/web/package.json:9:    "build:mobile": "BUILD_TARGET=mobile react-router build"
apps/web/react-router.config.ts:4:  ssr: process.env['BUILD_TARGET'] !== 'mobile'
apps/web/app/routes.ts:8:  process.env.BUILD_TARGET === 'mobile' ? [] : [route('sitemap.xml', 'routes/sitemap.tsx')]
```

`apps/web/react-router.config.ts` toggles SSR off when
`BUILD_TARGET=mobile`. `apps/web/app/routes.ts:5-8` excludes the
sitemap resource route (the one loader-bearing surface) from the
mobile build with an explanatory comment. No other route exports
`loader`/`action`/`clientLoader` (verified above).

**Status: in-sync.**

### Rule 5 — "Protobuf for clusters: clients send `Accept: application/x-protobuf`; JSON fallback for debugging only."

```
$ rg -n "application/x-protobuf" apps/
apps/web/app/services/clusters.ts:5:const PROTOBUF_MIME = 'application/x-protobuf';
apps/web/app/services/__tests__/clusters.test.ts:45: ...sends Accept header
apps/backend/src/clustering/handler.ts:6:const PROTOBUF_MIME = 'application/x-protobuf';
apps/backend/src/clustering/handler.ts:12: /* protobuf preferred when Accept header includes it */
apps/backend/src/clustering/handler.ts:173:c.header('Vary', 'Accept');
apps/backend/src/clustering/__tests__/handler.test.ts:194: /* falls back to JSON when types unavailable */
apps/backend/src/openapi.ts:4995: 'application/x-protobuf': { schema: ... binary }
```

Client sends the Accept header; server does content negotiation on
the same string; `Vary: Accept` header emitted to keep caches honest.
OpenAPI documents both content types. ADR-003 reconciles.

**Status: in-sync.**

### Rule 6 — "No `any` except dynamically-imported proto bridge."

Post-filtering comment prose matches, the concrete type-`any`
occurrences in non-test source:

```
apps/backend/src/clustering/handler.ts:109: let ProtobufClusterResponse: any = null;
apps/backend/src/clustering/handler.ts:111: const mod = (await import('@loop/shared/src/proto/clustering_pb.js' as any)) as any;
apps/web/app/services/clusters.ts:99:  '@loop/shared/src/proto/clustering_pb.js' as any
apps/web/app/services/clusters.ts:100:  )) as any;
apps/web/app/services/clusters.ts:103:  const msg = ProtobufClusterResponse.fromBinary(new Uint8Array(buffer)) as any;
apps/web/app/services/clusters.ts:107:  locationPoints: msg.locationPoints.map((p: any) => ({
apps/web/app/services/clusters.ts:123:  clusterPoints: msg.clusterPoints.map((p: any, i: number) => ({
```

Every site carries an `eslint-disable` pragma immediately above:

```
apps/backend/src/clustering/handler.ts:108: /* eslint-disable @typescript-eslint/no-explicit-any */
apps/web/app/services/clusters.ts:97: /* eslint-disable @typescript-eslint/no-explicit-any */
```

All within the proto-bridge import path. `packages/shared/src` has
zero `any` occurrences matching the type pattern.

**Status: in-sync.**

### Rule 7 — "All upstream responses Zod-validated before forwarding."

```
$ rg -n "\.safeParse\(|\.parse\(" apps/backend/src (filtered to upstream response paths)
apps/backend/src/auth/handler.ts:155: VerifyOtpUpstreamResponse.safeParse(raw)
apps/backend/src/auth/handler.ts:232: RefreshUpstreamResponse.safeParse(raw)
apps/backend/src/orders/handler.ts:227: CreateOrderUpstreamResponse.safeParse(raw)
apps/backend/src/orders/handler.ts:368: ListOrdersUpstreamResponse.safeParse(raw)
apps/backend/src/orders/handler.ts:466: GetOrderUpstreamResponse.safeParse(raw)
apps/backend/src/merchants/sync.ts:160: UpstreamListResponseSchema.safeParse(raw)
apps/backend/src/merchants/sync.ts:169: UpstreamMerchantSchema.safeParse(item)
apps/backend/src/merchants/handler.ts:168: UpstreamMerchantDetailResponse.safeParse(raw)
apps/backend/src/clustering/data-store.ts:114: UpstreamLocationsResponseSchema.safeParse(raw)
apps/backend/src/clustering/data-store.ts:127: UpstreamLocationSchema.safeParse(rawItem)
apps/backend/src/payments/horizon.ts:112: HorizonPaymentsResponse.safeParse(raw)
apps/backend/src/payments/horizon.ts:189: HorizonPaymentsResponse.safeParse(raw)
apps/backend/src/payments/horizon-balances.ts:144: HorizonAccountResponse.safeParse(raw)
apps/backend/src/payments/horizon-trustlines.ts:121: HorizonAccountResponse.safeParse(raw)
apps/backend/src/payments/horizon-circulation.ts:129: AssetsListResponse.safeParse(raw)
apps/backend/src/payments/price-feed.ts:69: CoinGeckoResponse.safeParse(raw)
apps/backend/src/payments/price-feed.ts:161: FxFeedResponse.safeParse(raw)
apps/backend/src/auth/id-token.ts:70: JwksResponse.safeParse(raw)
```

One bare `fetch` exists: `apps/backend/src/app.ts:556` in the
`/health` upstream probe. It only reads `res.ok` (status code) and
never touches the body, so there is nothing to Zod-validate. The
comment at lines 548-555 justifies the bare fetch (circuit-breaker
would short-circuit to CircuitOpenError and /health would lie).

**Status: in-sync.** Every upstream response body reaching code that
cares about its shape goes through `safeParse` first.

---

## 2. Package boundaries

### `apps/web` MUST NOT import `apps/backend`

```
$ rg -n "from '@loop/backend|from \"@loop/backend|from '\.\./\.\./backend|from '../backend" apps/web
(no matches)
```

**Status: in-sync.**

### `packages/shared` MUST have no node-only APIs or runtime deps beyond `@bufbuild/protobuf`

```
$ rg -n "from 'node:|from \"node:|require\(" packages/shared/src
(no matches)

$ cat packages/shared/package.json (dependencies key):
"@bufbuild/protobuf": "2.11.0"
```

Only `@bufbuild/protobuf` is a runtime dep. All `import` statements
across the 17 shared source files reach only `@bufbuild/protobuf`
(verified via grep). Comments mention `zod` but no file imports it.

**Status: in-sync.**

---

## 3. ADR reconciliation (all 23, per plan §5.3)

| ADR | Title                                       | Status        | Evidence pointer                                                                                                                                                                                                                                                                                                                                                                                                            | Note                                                                                                                            |
| --- | ------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 001 | Static export over remote URL for Capacitor | in-sync       | `apps/web/react-router.config.ts:4`, `apps/web/app/routes.ts:7-8`, `apps/web/package.json:9`                                                                                                                                                                                                                                                                                                                                | BUILD_TARGET=mobile flips `ssr:false`; loader-bearing route excluded.                                                           |
| 002 | TypeScript over Go for the backend          | in-sync       | `apps/backend/src/**/*.ts`, Hono framework throughout                                                                                                                                                                                                                                                                                                                                                                       | All backend source is TypeScript on Hono. No Go remnants.                                                                       |
| 003 | Protobuf for clustering endpoint            | in-sync       | `apps/backend/src/clustering/handler.ts:6,12`, `apps/web/app/services/clusters.ts:5`, `packages/shared/src/proto/clustering_pb.ts`                                                                                                                                                                                                                                                                                          | Both sides negotiate on `application/x-protobuf`; `@bufbuild/protobuf` the single generator.                                    |
| 004 | Security hardening pass                     | in-sync       | Per-endpoint circuit breakers: `apps/backend/src/circuit-breaker.ts` + `getUpstreamCircuit('login' / 'verify-email' / 'refresh-token' / 'logout' / 'gift-cards' / 'merchants' / 'locations')` across handlers. Server `expiresAt`: `apps/backend/src/orders/handler.ts`. Coalesced refresh: `apps/web/app/services/api-client.ts`. Strict CSP: `apps/backend/src/app.ts:321` + `apps/web/app/utils/security-headers.ts:61`. | All five decisions implemented.                                                                                                 |
| 005 | Known limitations (Phase 1)                 | in-sync       | Doc itself; items 1-11 still accurate at time of capture.                                                                                                                                                                                                                                                                                                                                                                   | Status "partial" on item 7 (jsdom opt-in) matches `apps/web/vitest.config.ts` reality.                                          |
| 006 | Keychain-backed secure storage              | in-sync       | `apps/web/app/native/secure-storage.ts:45` imports `@aparajita/capacitor-secure-storage`; `apps/web/package.json` + `apps/mobile/package.json` co-declare the dep                                                                                                                                                                                                                                                           | Migration path logic present (read SecureStorage first, fall back to Preferences, write-and-delete on first hit).               |
| 007 | Native projects — overlays over versioning  | in-sync       | `apps/mobile/native-overlays/{ios,android}/` exist; `apps/mobile/scripts/apply-native-overlays.sh`; `apps/mobile/ios/`, `apps/mobile/android/` are gitignored.                                                                                                                                                                                                                                                              | Overlay directory present; bootstrap instructions in AGENTS.md match.                                                           |
| 008 | `@capacitor/filesystem` for share           | in-sync       | `apps/web/app/native/share.ts:31` imports `@capacitor/filesystem`; helper writes to `Directory.Cache` before `Share.share`.                                                                                                                                                                                                                                                                                                 | Single module; stays inside `native/`.                                                                                          |
| 009 | Credits ledger and cashback flow            | in-sync       | `apps/backend/src/db/schema.ts` — `user_credits` keyed `(user_id, currency)`, `credit_transactions` append-only with typed union (see shared `credit-transaction-type.ts`). Migration `0000_initial_schema.sql` has both.                                                                                                                                                                                                   | Materialized balance + append-only log both landed.                                                                             |
| 010 | Principal switch + payment rails            | in-sync       | `apps/backend/src/db/schema.ts:336-368` (face/wholesale/cashback/margin minor columns, payment_source, payment_memo, paid_at/fulfilled_at). `apps/backend/src/orders/procurement.ts`, `loop-handler.ts`, watcher.                                                                                                                                                                                                           | All ADR-010 order row additions present; state machine wired through `transitions.ts`.                                          |
| 011 | Admin panel for cashback configuration      | drifted-minor | `apps/backend/src/db/schema.ts:181-184` has `merchantCashbackConfigs`; `apps/backend/src/admin/*`; route `/admin/cashback` at `apps/web/app/routes/admin.cashback.tsx`. **Drift:** `DEFAULT_USER_CASHBACK_PCT_OF_CTX` / `DEFAULT_LOOP_MARGIN_PCT_OF_CTX` env vars mentioned in ADR are not referenced anywhere in `apps/backend` source.                                                                                    | Table, history, is_admin flag, route all present; the two env-based defaults the ADR specifies are not implemented. See A2-204. |
| 012 | Drizzle ORM + Fly Postgres                  | in-sync       | `apps/backend/package.json:25,37` pins `drizzle-orm@0.45.2` + `drizzle-kit@0.31.10`; migrations in `apps/backend/src/db/migrations/`; startup-time apply at `apps/backend/src/index.ts:19`.                                                                                                                                                                                                                                 | Driver, schema, migrate-on-boot all present.                                                                                    |
| 013 | Loop-owned auth + CTX operator pool         | in-sync       | `apps/backend/src/auth/tokens.ts` (HS256 sign/verify), `auth/native.ts`, `auth/otps.ts`, `auth/refresh-tokens.ts`, `ctx/operator-pool.ts`. Env: `LOOP_JWT_SIGNING_KEY{,_PREVIOUS}`, `CTX_OPERATOR_POOL`.                                                                                                                                                                                                                    | All checklist items landed. **Creates drift with AGENTS.md rule #2 — see A2-203.**                                              |
| 014 | Social login (Google + Apple)               | in-sync       | `apps/backend/src/auth/social.ts`, `auth/id-token.ts` (JWKS verify), `auth/identities.ts`, migration `0005_user_identities.sql`. Endpoints at `/api/auth/social/google`, `/api/auth/social/apple`.                                                                                                                                                                                                                          | `user_identities` table present; JWKS cache path present.                                                                       |
| 015 | Stablecoin topology + payment rails         | in-sync       | `users.home_currency` column (migration `0006`); `apps/backend/src/credits/payout-asset.ts`; `apps/backend/src/payments/payout-worker.ts`; issuer env vars in `env.ts`; admin treasury UI.                                                                                                                                                                                                                                  | Checklist marked `[x]` in ADR matches shipped surface.                                                                          |
| 016 | Stellar SDK for outbound payout submit      | in-sync       | `apps/backend/package.json` has `@stellar/stellar-sdk`; `apps/backend/src/payments/payout-submit.ts` + `payout-worker.ts`; `LOOP_STELLAR_OPERATOR_SECRET` in `env.ts`; Pino redaction.                                                                                                                                                                                                                                      | Submit primitive + worker loop + memo idempotency all landed.                                                                   |
| 017 | Admin credit primitives (writes)            | in-sync       | `apps/backend/src/admin/idempotency.ts`, `admin/credit-adjustments.ts`, migration `0011_admin_idempotency_keys.sql`, Discord audit envelope in `apps/backend/src/discord.ts`. Retry endpoint `admin/payouts.ts` envelope carries `{ result, audit }`.                                                                                                                                                                       | Actor, idempotency, reason, Discord all enforced.                                                                               |
| 018 | Admin panel architecture                    | in-sync       | Drill-down pairs in `apps/backend/src/app.ts` (payouts, orders, audit-tail); CSV siblings (`audit-tail-csv.ts`, `payouts-csv.ts`, `orders-csv.ts`, `credit-transactions-csv.ts`); tier-3 rate limits applied.                                                                                                                                                                                                               | Drill-down + CSV + tier splits all present.                                                                                     |
| 019 | `@loop/shared` package policy               | in-sync       | `packages/shared/src/{api.ts,credit-transaction-type.ts,loop-asset.ts,order-state.ts,payout-state.ts,stellar.ts,search.ts,money-format.ts,public-*.ts,merchants.ts,orders.ts,slugs.ts,cashback-realization.ts}`. All cross-boundary; all pure TS (no node/react/fs).                                                                                                                                                        | 17 source files, all satisfy the three-part test. Backend re-exports live under `apps/backend/src/db/schema.ts`.                |
| 020 | Public API surface                          | in-sync       | `apps/backend/src/app.ts:699-730` registers `/api/public/cashback-stats`, `/top-cashback-merchants`, `/merchants/:id`, `/cashback-preview`, `/loop-assets`, `/flywheel-stats`, all at `rateLimit(60, 60_000)`. Handlers under `apps/backend/src/public/` implement last-known-good + never-500.                                                                                                                             | Cache-Control, rate-limit, zero-shape-bootstrap all landed.                                                                     |
| 021 | Merchant-catalog eviction policy            | in-sync       | Rule A fallback visible in `apps/backend/src/admin/*` merchant-join shapes. Rule B drop visible in `apps/backend/src/public/top-cashback-merchants.ts`. Rule C pin is the invariant `orders.merchant_id` is NOT NULL and never updated post-creation (see `apps/backend/src/orders/repo.ts`).                                                                                                                               | Three rules codify a pre-existing pattern; no fresh implementation required.                                                    |
| 022 | Admin drill-triplet pattern                 | in-sync       | Quartets landed (`payment-method-share`, `flywheel-stats`); triplets landed (`cashback-monthly`, `cashback-activity`); ADR tracks its own status-of-pattern section.                                                                                                                                                                                                                                                        | Pattern is descriptive; matches shipped endpoint inventory.                                                                     |
| 023 | Admin mix-axis matrix                       | in-sync       | `apps/backend/src/admin/{merchant-operator-mix.ts,operator-merchant-mix.ts,user-operator-mix.ts}` plus matching tests, registered in `app.ts` and `openapi.ts`.                                                                                                                                                                                                                                                             | All three named instances present, response shape matches the ADR template.                                                     |

Summary: 21 `in-sync` · 1 `drifted-minor` (ADR-011 defaults) · 0
`withdrawn` · 0 `never-implemented`. ADR-013 is in-sync with the code
but causes AGENTS.md rule-2 to be stale (logged under Rule 2 as A2-203).

---

## 4. Negative-space (plan G3-13)

Things that _should_ exist given the stated posture but I did not find:

### 4.1 Content-Security-Policy on the backend

The backend serves only JSON/binary; `apps/backend/src/app.ts:321`
calls `secureHeaders(...)`. The `default-src 'none'` posture is
confirmed in the integration test `apps/backend/src/__tests__/routes.integration.test.ts:471-478`.
A per-response CSP is present; nothing is missing. Info-level: no
CSP Report-Only / report-uri emission — a defence-in-depth monitoring
gap, but not a rule failure.

### 4.2 Pre-commit secret scan

```
$ rg -n "gitleaks|trufflehog|detect-secrets|secret-scan" .github .husky scripts
(no matches)
```

No pre-commit or CI-side secret scanner is configured. Given the number
of secret env vars the project has grown (`LOOP_JWT_SIGNING_KEY`,
`LOOP_STELLAR_OPERATOR_SECRET`, `CTX_OPERATOR_POOL`, Discord webhooks,
Sentry DSN, DATABASE_URL) an accidental-commit vector is higher than
at Phase 0. `.gitignore` catches `.env*` but not ad-hoc dumps or
inline paste. Info-level.

### 4.3 Dependency / supply-chain gating

```
$ rg -n 'npm audit|audit-ci|snyk|osv-scanner' .github/workflows
.github/workflows/ci.yml:111:  - run: npm audit --audit-level=high
```

`npm audit --audit-level=high` is wired in CI. No SBOM export, no
`osv-scanner`, no Snyk. Info-level: adequate for Phase 1, should be
reinforced by Phase 3 (Dependencies & Supply chain).

### 4.4 Structured 4xx error taxonomy

`packages/shared/src/api.ts:63-82` exports
`ApiErrorCode`: `NETWORK_ERROR`, `TIMEOUT`, `VALIDATION_ERROR`,
`NOT_FOUND`, `UNAUTHORIZED`, `RATE_LIMITED`, `INTERNAL_ERROR`,
`UPSTREAM_ERROR`, `UPSTREAM_REDIRECT`, `SERVICE_UNAVAILABLE`,
`IMAGE_TOO_LARGE`, `NOT_AN_IMAGE`. Not exhaustive — the backend
returns `IDEMPOTENCY_KEY_REQUIRED`, `OPERATOR_UNAVAILABLE`,
`INSUFFICIENT_BALANCE` and similar literals in the admin-write path
(per ADR-017). No shared enum covers these. Info-level: a
follow-up should widen `ApiErrorCode` or declare a per-surface
extension pattern. See A2-205.

### 4.5 ADR status lifecycle is unclear

ADRs 009, 010, 011, 013, 014, 017 carry status `Proposed` despite
implementation that is clearly landed (visible in `apps/backend/src/*`
as of this commit). ADRs 004, 005, 006, 007, 008, 012, 015, 016, 018,
019, 020, 021, 022, 023 correctly flip to `Accepted`. The
pattern reads as "status fell behind implementation." Info-level. See
A2-206.

### 4.6 Rule-text drift for AGENTS.md

Rules #1 ("no server-side data fetching in loaders") and #2 ("backend
does not generate OTPs, issue JWTs, or send emails") are factually
wrong at this commit because the scoped exceptions (sitemap) and the
ADR-013 migration landed without updating the rule prose. See A2-202
and A2-203.

---

## 5. Findings

Severity per plan §3.4. `Info` observations are logged but not
remediation-ranked above `Low`.

### A2-201 — Loader-purity rule mentions no exception while one exists

**Severity:** Low · **Surface:** Rule 1 · Rule 4

**Files:** `AGENTS.md:100`; `apps/web/app/routes/sitemap.tsx:71`;
`apps/web/app/routes.ts:7-8`

**Evidence:** AGENTS.md rule #1 text: `"No server-side data fetching
in loaders."` `sitemap.tsx:38-49` fetches from
`/api/public/top-cashback-merchants` inside a loader. The code is
self-documenting about why it's safe (SSR-only, excluded from mobile
via `routes.ts` BUILD_TARGET check), but the rule text is not.

**Impact:** Next contributor reads the rule as absolute, files a
follow-up to "fix" the sitemap, or worse — removes the exclusion on
`routes.ts` in the name of consistency and breaks the mobile static
export.

**Remediation:** Amend rule #1 to either "except for resource routes
excluded from mobile" or link to the sitemap file's self-documenting
comment. Same or separate wording for rule #4 since the exclusion
mechanism is the same. Closed only by a PR editing `AGENTS.md`.

---

### A2-202 — AGENTS.md rule #2 contradicts ADR-013

**Severity:** Medium · **Surface:** Rule 2

**Files:** `AGENTS.md:101`; `apps/backend/src/auth/tokens.ts`;
`apps/backend/src/auth/otps.ts`; `apps/backend/src/auth/native.ts`;
`apps/backend/src/auth/refresh-tokens.ts`;
`docs/adr/013-loop-owned-auth-and-ctx-operator-accounts.md`

**Evidence:** Rule #2 verbatim: "Backend does not generate OTPs,
issue JWTs, or send emails. All auth endpoints proxy to spend.ctx.com."
ADR-013's decision directly inverts this: Loop issues its own
HS256 JWTs (`tokens.ts:72-92`), stores OTP hashes with TTL
(`otps.ts`), and — per ADR-013 rollout checklist — is designed to
send Loop-branded email. The proxy path is retained only as a
legacy compatibility surface during migration phases A-C.

**Impact:** An agent instructed to enforce rule #2 as absolute would
regress ADR-013 to proxy-only. Humans reading rule #2 during review
may object to any PR in the `auth/native.ts` / `auth/tokens.ts` area
as "violates AGENTS.md" when in fact those files are the decision's
implementation.

**Remediation:** Rewrite rule #2 to reflect the dual-accept posture:
"Legacy CTX-proxy auth is accepted for transitional sessions; new
auth issues Loop-signed HS256 JWTs (ADR-013). Both paths share the
OTP + refresh-token rotation semantics."

---

### A2-203 — ADR-011 mentions default-percent env vars that are not implemented

**Severity:** Low · **Surface:** ADR-011 reconciliation

**Files:** `docs/adr/011-admin-panel-cashback-configuration.md:96-98`

**Evidence:**

```
$ rg -n 'DEFAULT_USER_CASHBACK_PCT_OF_CTX|DEFAULT_LOOP_MARGIN_PCT_OF_CTX'
docs/adr/011-admin-panel-cashback-configuration.md (only)
```

ADR-011 §"Default on catalog sync" promises the two env-configurable
defaults. No reference exists in `apps/backend/src/env.ts`, in the
admin handlers, or in the merchant-sync path. Either the defaults
land elsewhere (hard-coded constants) or this is never-implemented
for that paragraph of the ADR.

**Impact:** Operator tuning "what % of the CTX discount do new
merchants default to?" is not an env knob today — contradicts the
ADR and means every tweak is a code change + deploy. Not blocking
Phase 1 (few merchants); would bite the moment the team wants to
run an onboarding cohort with a different split.

**Remediation:** Either (a) implement the two env vars per ADR-011,
or (b) update the ADR §"Default on catalog sync" to record the
actual mechanism (e.g., "hard-coded 80/20 in `merchants/sync.ts`") and
note when the env-var knob becomes worth the scaffolding.

---

### A2-204 — `ApiErrorCode` shared enum lags backend-emitted literals

**Severity:** Low · **Surface:** Negative-space 4.4

**Files:** `packages/shared/src/api.ts:63-82`; admin-write handlers
under `apps/backend/src/admin/*`

**Evidence:** `ApiErrorCode` enumerates 12 codes; ADR-017-driven
admin-write endpoints return at minimum `IDEMPOTENCY_KEY_REQUIRED`
(per ADR text line 63) and likely more (`OPERATOR_UNAVAILABLE`,
`INSUFFICIENT_BALANCE`, order-state violations). The shared enum
therefore doesn't cover the full 4xx vocabulary clients see, which
defeats the purpose of the `switch (err.code)` pattern the comment at
`api.ts:59-61` promotes.

**Impact:** Clients fall through to a default branch on post-ADR-017
error codes; i18n / UX copy for those codes is brittle string
matching rather than typed exhaustiveness.

**Remediation:** Either (a) widen `ApiErrorCode` to include every
backend-emitted `{ code: '...' }` literal — a per-handler audit gives
the full set; or (b) declare the extension pattern (each surface gets
its own enum that extends `ApiErrorCode`). Update `ApiError`'s `code`
type to the widened union.

---

### A2-205 — ADR status lines have not kept pace with implementation

**Severity:** Info · **Surface:** Negative-space 4.5

**Files:** `docs/adr/009-credits-ledger-cashback-flow.md:3`,
`010-principal-switch-payment-rails.md:3`,
`011-admin-panel-cashback-configuration.md:3`,
`013-loop-owned-auth-and-ctx-operator-accounts.md:3`,
`014-social-login-google-apple.md:3`,
`017-admin-credit-primitives.md:3`

**Evidence:** Each carries `Status: Proposed` despite their
rollout-checklist items landing under `apps/backend/src/*` as of
commit `450011de`. ADR-015 and ADR-016 correctly flipped from
Proposed → Accepted and added an `Implemented:` line; the others
are pattern-matchable but haven't.

**Impact:** A future contributor searching "what's still Proposed vs.
Accepted?" gets a misleading answer. Compounds the "ADRs are
honest about truth" assumption the audit program depends on.

**Remediation:** One ADR-status-sweep PR that flips each of the six
ADRs above to Accepted (or back to Proposed with a corresponding
code removal, which is not what we see). Each line should follow
ADR-015's template: `Implemented: <date> (<surface>)`.

---

### A2-206 — No automated secret scan in pre-commit or CI

**Severity:** Info · **Surface:** Negative-space 4.2

**Files:** `.github/workflows/ci.yml`, `.husky/*`, `scripts/*`
(absence)

**Evidence:** grep for `gitleaks|trufflehog|detect-secrets|secret-scan`
across `.github`, `.husky`, `scripts` returns zero matches. Given
the secret-env surface grew ~5x since Phase 0 (JWT key, Stellar
operator secret, CTX operator pool, Discord webhooks, Sentry DSN,
DATABASE_URL), the probability of an accidental commit is higher
than it was, and the mitigation (human review + `.gitignore` of
`.env*`) is unchanged.

**Impact:** A one-line paste-in-the-wrong-file error goes straight to
git history. Rotating Stellar / JWT keys after the fact is possible
but expensive and visible to the whole user base.

**Remediation:** Add `gitleaks` as a pre-commit hook (husky) and as a
CI job that blocks the merge queue on hit. Baseline the current tree
once and rely on the delta check thereafter.

---

### A2-207 — AGENTS.md "quick commands" section misses the workers-enabled boot gate

**Severity:** Info · **Surface:** Rule 2 + ADR 015/016 reconciliation

**Files:** `AGENTS.md:64-89`; `apps/backend/src/index.ts`;
`apps/backend/src/env.ts` (`LOOP_WORKERS_ENABLED`)

**Evidence:** The AGENTS.md "Quick commands" section describes
`npm run dev:backend` as the one-liner to boot the backend but doesn't
mention the worker gate. With ADRs 015 + 016 landed, a local dev
invoking `/api/admin/payouts` without `LOOP_WORKERS_ENABLED=true`
will see rows stuck in `pending` and won't know that's the expected
behaviour. Not a rule failure; a documentation drift that will cost
a new contributor an afternoon.

**Impact:** Contributor onboarding friction. Low, recoverable.

**Remediation:** Add a note next to `dev:backend` naming the two
worker-gate env vars (`LOOP_WORKERS_ENABLED`,
`LOOP_STELLAR_OPERATOR_SECRET`) and what each unlocks. Or link to
`docs/development.md` §Workers.

---

## 6. Summary

- **Rules 3, 5, 6, 7 + both package boundaries:** fully in-sync.
- **Rules 1 + 2 + 4:** implementation correct, rule _text_ stale (A2-201, A2-202).
- **21 ADRs in-sync, 1 drifted-minor (ADR-011 defaults), 6 with stale status lines** (A2-205).
- **Negative space:** CSP present; secret-scan absent (A2-206); shared error-code taxonomy incomplete (A2-204); ADR statuses stale (A2-205); quick-commands drift (A2-207).

Findings ranked: 0 Critical · 0 High · 1 Medium · 3 Low · 3 Info.

No blocked items — all probes executable from the tree at
commit `450011de`.
