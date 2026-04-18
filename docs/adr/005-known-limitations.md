# ADR-005: Known Limitations

- **Status**: Accepted
- **Date**: 2026-04-17
- **Deciders**: Engineering
- **Supersedes**: —
- **Superseded by**: —

## Context

Several items surfaced during the Phase 1 audit that we consciously chose
**not** to fix in this phase. Two classes:

1. **Phase 2 scope** — work that is real but deferred to a later milestone
   because it depends on infrastructure or product decisions that don't exist yet.
2. **Deliberate technical trade-offs** — cases where the theoretically-better
   fix is larger than the current risk justifies. Documented here so a future
   reader doesn't read silence as "nobody noticed."

Leaving these undocumented invites each new contributor to re-audit them and
file duplicate issues.

## Decision

Track the following as known, accepted limitations for Phase 1. Each entry
lists what the limitation is, why we're accepting it, what triggers a revisit,
and where the fix work would happen.

### 1. Stellar wallet / USDC cashback is Phase 2

- **What**: No on-device Stellar wallet, no USDC cashback on fulfilled orders,
  no biometric-gated signing. Orders are paid by the user sending XLM from an
  external wallet to the address returned in the `paymentUri`.
- **Why accepted**: Phase 1 ships discounted gift cards via external XLM
  payment only. The wallet features are the entire Phase 2 deliverable.
- **Revisit**: When Phase 2 is prioritised on the roadmap.
- **Where**: `apps/web/app/stores/`, `apps/web/app/native/biometrics.ts` (stub),
  new `apps/web/app/native/stellar-wallet.ts`, plus `@stellar/stellar-sdk`
  integration on-device (never on the backend — see CLAUDE.md rule).

### 2. Barcode gift card redemption is Phase 2

- **What**: The rendering side is done — `PurchaseComplete.tsx` dynamically
  imports `jsbarcode` and paints a CODE128 canvas when `giftCardCode` is
  present, with an `aria-label` on the canvas and the code + optional PIN
  shown as text below. What's still Phase 2 is the **data wiring**: the
  backend's `getOrderHandler` comment explicitly notes that populating
  `giftCardCode` from upstream is not yet implemented (see
  `apps/backend/src/orders/handler.ts` — the barcode path "is currently
  unreachable via polling"). There's also no scanner-friendly full-screen
  brightness prompt.
- **Why accepted**: Most merchants in the current catalog use `url`
  redemption. The extra upstream wiring for barcode-only cards only pays
  off once CTX onboards retailers where that's the primary path.
- **Revisit**: When a barcode-primary merchant is added to the catalog, or
  when user research shows the current flow is insufficient.
- **Where**: `apps/backend/src/orders/handler.ts` (populate `giftCardCode`
  when upstream returns barcode data), and likely a brightness-maxing
  wrapper around the existing canvas in `PurchaseComplete.tsx`.

### 3. `eslint-plugin-react` is not in use

- **What**: Dropped in PR #27 to unblock the ESLint 10 upgrade. We lost rules
  from `plugin:react/recommended` and `plugin:react/jsx-runtime` — most
  notably `react/jsx-key`, `react/jsx-no-target-blank`,
  `react/no-unescaped-entities`.
- **Why accepted**: `eslint-plugin-react` didn't support ESLint 10 at the time
  we upgraded. Running on ESLint 9 would have meant living with the
  accumulated security advisories on the older ESLint major.
- **Risks we carry in the meantime**:
  - Missing `key` prop on lists won't be lint-caught (React still warns at
    runtime; tests catch some cases).
  - External `<a target="_blank">` without `rel="noopener noreferrer"` would
    not be flagged. Mitigated at runtime by `native/webview.ts` which always
    sets `noopener,noreferrer` for programmatic opens — but unmitigated for
    JSX `<a>` tags in components.
- **Revisit**: When `eslint-plugin-react` publishes an ESLint-10-compatible
  release. Track upstream: https://github.com/jsx-eslint/eslint-plugin-react/issues
- **Where**: `eslint.config.js` at the repo root.

### 4. Rate limiting is per-process in-memory

- **What**: `apps/backend/src/app.ts` uses an in-memory `Map` for rate limit
  buckets, capped at 10k entries with LRU eviction (PR #33). If we scale the
  backend to more than one Fly.io machine, each machine's rate limit is
  independent and the effective per-IP limit multiplies by instance count.
- **Why accepted**: Phase 1 runs on a single Fly machine. Adding Redis just
  for rate-limit state doubles the infrastructure and operational surface
  before we have the traffic to justify it.
- **Revisit**: When we horizontally scale the backend, or if an adversary
  demonstrates that they can bypass per-IP limits by distributing across
  machines. The `/metrics` endpoint exposes `loop_rate_limit_hits_total` —
  watching that counter jump without triggering per-IP 429s is the signal.
- **Where**: `apps/backend/src/app.ts` (`hitRateLimit`, the
  `rateLimitMap`). Replace with a shared store (Upstash Redis is the Fly-
  friendly option) and keep the existing interface so call sites don't move.

### 5. Image proxy DNS-rebinding TOCTOU

- **What**: `apps/backend/src/images/proxy.ts` validates resolved IPs against
  the private-range deny-list in `validateImageUrl`, but `fetch()` does its
  own DNS lookup that we don't control. An attacker-run DNS server can return
  a public IP to the check and a private IP to the subsequent fetch.
- **Why accepted**: The practical mitigation is `IMAGE_PROXY_ALLOWED_HOSTS`
  — when set, only operator-trusted hostnames are admitted at all. For Phase 1
  the image proxy only serves merchant logos/cards from upstream CTX, which we
  allowlist in production. PR #38 documents this in the source as a
  `KNOWN LIMITATION` comment.
- **Revisit**: Before the image proxy is ever allowed to accept arbitrary
  third-party hostnames (e.g. a user-avatar feature). At that point the fix
  is a custom `undici.Dispatcher.connect` that reuses the already-resolved
  IP with the expected `Host` header.
- **Where**: `apps/backend/src/images/proxy.ts`.

### 6. Circuit-breaker probe cooperation

- **What**: `apps/backend/src/circuit-breaker.ts` arms a `probeTimeoutMs`
  failsafe (PR #40) so a hung HALF_OPEN probe can't jam the breaker
  indefinitely. But during the probe window, requests still wait on the
  caller's `fetch` timeout — if a caller forgets to pass an `AbortSignal`,
  we'd still burn up to `probeTimeoutMs` (default 60s) per stuck probe
  before the failsafe fires.
- **Why accepted**: Every current caller passes an `AbortSignal.timeout(...)`
  of ≤ 30s. The failsafe closes the door on a never-completing probe; the
  only remaining wait is one bad 60s window. Enforcing "init.signal must be
  present" at the breaker level has cross-cutting test implications we don't
  want to bundle.
- **Revisit**: If a new caller forgets the signal in production and pages
  somebody.
- **Where**: `apps/backend/src/circuit-breaker.ts` `wrappedFetch`.

### 7. Web vitest runs in `node` environment, not `jsdom`

- **What**: `apps/web/vitest.config.ts` sets `environment: 'node'`. Rendering
  React components or invoking hooks through `@testing-library/react`'s
  `renderHook` requires `environment: 'jsdom'`.
- **Why accepted**: Most web tests today are pure-logic (service clients,
  stores, utility functions). Switching the default to `jsdom` slows every
  test file (~100 ms startup) and pulls in a sizeable dependency.
- **Consequence**: `useAuth`, `useSessionRestore`, and the purchase-flow
  components (Task #11) are covered by e2e tests only. Per-hook/per-component
  unit coverage is a known gap.
- **Revisit**: When Task #11 (purchase-flow component tests) lands. The likely
  resolution is a per-file `// @vitest-environment jsdom` pragma for the
  component suites rather than a global flip.
- **Where**: `apps/web/vitest.config.ts`, per-file pragmas in future
  component tests.

### 8. Proto generation is manual

- **What**: `apps/backend/proto/clustering.proto` is compiled to
  `packages/shared/src/proto/clustering_pb.ts` via `npm run proto:generate`,
  which wraps `buf generate`. The generated file is committed. If someone
  edits the `.proto` and forgets to run generate, the TypeScript checked into
  git drifts from the source of truth.
- **Why accepted**: A `proto generate` CI step would run on every PR, which
  for a file that changes once a year is overhead. Committing the generated
  file means fresh clones don't need `buf` installed.
- **Revisit**: If we catch a PR where the generated file is stale. At that
  point add a CI check that regenerates and `git diff --exit-code`s.
- **Where**: `.github/workflows/ci.yml`, eventual `proto:check` script.

### 9. No metrics exporter integration

- **What**: `/metrics` exposes Prometheus-format counters (PR #33), but
  nothing scrapes it in production. Fly.io's managed observability is
  currently the primary signal.
- **Why accepted**: Prometheus / Grafana Cloud setup is real operational
  work (auth, retention, dashboards) and not justified by current traffic.
  Having the endpoint available means we can point a scraper at it the day
  a real alert costs us.
- **Revisit**: When we need alerting on rate-limit-hit ratios or circuit
  state beyond the Discord webhook fan-outs.
- **Where**: Fly.io config (`fly.toml`), Grafana Cloud scrape config.

### 10. Third-party runtime dependencies (Google Fonts, CARTO/OSM tiles)

- **What**: `apps/web/app/root.tsx` loads Inter from `fonts.googleapis.com` /
  `fonts.gstatic.com`. `apps/web/app/components/features/ClusterMap.tsx`
  loads basemap tiles from `basemaps.cartocdn.com` and attributes
  OpenStreetMap + CARTO in the map footer. Both issue third-party requests
  at page load (fonts) and at every viewport change (tiles).
- **Why accepted**: Self-hosting the Inter font file set adds ~200 KB to the
  bundle for a benefit users won't see; CARTO's free basemap policy covers
  the traffic volume Loop expects for Phase 1. Both providers are named
  explicitly in the CSP allowlist (audit A-027) so "unsanctioned new
  third-party origin" is blocked at the browser layer.
- **Privacy note**: Both services see the user's IP at request time. No
  Loop-specific identifiers (cookies, tokens, email) are transmitted —
  the fetches are cookie-less cross-origin GETs. Users in EU jurisdictions
  should still be informed; that copy lands with the privacy policy work
  under "Mobile app submission" in `docs/roadmap.md`.
- **Revisit**: If we ship a self-hosted assets bundle (likely alongside
  MapLibre GL JS in Phase 3), retire both third-party origins in the
  same pass and drop them from `buildSecurityHeaders`.
- **Where**: `apps/web/app/root.tsx` (font `<link>` tags),
  `apps/web/app/components/features/ClusterMap.tsx` (tile layer),
  `apps/web/app/utils/security-headers.ts` (CSP allowlist).

### 11. Secret token transport on login is via upstream

- **What**: `accessToken` and `refreshToken` are minted by upstream CTX and
  returned through our `/api/auth/verify-otp` proxy. We don't rotate or
  gate them server-side; we pass them through.
- **Why accepted**: Auth is proxied by design (`CLAUDE.md` rule). Custom
  token issuance would duplicate the upstream session model and create a
  two-way-sync problem.
- **Revisit**: If we ever want session-level controls CTX doesn't offer
  (forced re-auth, per-device revocation UI). That likely coincides with
  Phase 2.
- **Where**: `apps/backend/src/auth/handler.ts` (`verifyEmail`,
  `refreshToken`).

## Consequences

- New contributors can identify in one place what isn't in scope for Phase 1
  and why, instead of re-opening each as a bug.
- Each item names a concrete trigger for revisiting. "Deferred" is allowed;
  "forgotten" is not.
- Link from `docs/roadmap.md` so planning meetings can reuse this as input.

## Related

- [PR #33 — security hardening bundle](https://github.com/LoopDevs/Loop/pull/33)
- [PR #38 — image proxy alpha + DNS rebinding note](https://github.com/LoopDevs/Loop/pull/38)
- [PR #40 — circuit breaker probe failsafe](https://github.com/LoopDevs/Loop/pull/40)
- [ADR-004 — security hardening pass](004-security-hardening-pass.md)
