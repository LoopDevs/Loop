# User Journeys

## UJ-001: First Visit to Public Cashback Discovery

- Actor: unauthenticated visitor.
- Entry points: home, cashback, calculator, merchant detail, sitemap, robots, manifest, public API.
- Audit surfaces: web routes, public backend handlers, public shared types, cache-control, image proxy, SEO/static assets, public docs.
- Required checks: no PII, no auth assumptions, never-500 policy, stale fallback, rate limits, service-only fetches, SSR/static behavior, tests, docs truth.

## UJ-002: Email OTP Sign-In, Session Restore, Logout

- Actor: user on web and native.
- Entry points: auth route, auth service, auth hook, auth store, secure storage wrapper, backend auth routes.
- Audit surfaces: Loop-native auth, CTX proxy auth, OTP request/verify, refresh, logout, session deletion, storage migration, concurrent refresh.
- Required checks: enumeration resistance, brute-force limits, token storage, refresh cleanup, replay, error messages, user-facing states, tests, docs.

## UJ-003: Social Login

- Actor: user using Google or Apple if configured.
- Entry points: social login button, backend social auth, identity tables, replay guard.
- Audit surfaces: client IDs, token verification, account linking, identity uniqueness, replay prevention, error states, OpenAPI, tests.
- Required checks: issuer/audience, nonce/replay, email verification, user creation/update, home currency defaults, privacy, logs.

## UJ-004: Browse Map and Merchant Catalog

- Actor: user browsing merchants and locations.
- Entry points: map, merchant cards, search, cluster API, merchant API, image proxy.
- Audit surfaces: merchant sync, location sync, clustering proto/JSON, cache, search folding, disabled merchant handling, map UI, assets.
- Required checks: freshness, disabled visibility, protobuf negotiation, fallback, rate limits, image SSRF, stale data, tests.

## UJ-005: Purchase Gift Card with Legacy or Loop-Native Flow

- Actor: authenticated user.
- Entry points: gift-card route, purchase container, amount selection, payment step, backend order creation, payment watcher, procurement worker, redemption.
- Audit surfaces: amount validation, merchant lookup, order idempotency, payment quote, memo, status polling, reload recovery, terminal states.
- Required checks: duplicate submit, stale token, rate limit, upstream failure, worker crash, DB transaction, shared contracts, e2e coverage.

## UJ-006: Redeem Gift Card and View Order Detail

- Actor: authenticated user who bought a card.
- Entry points: purchase complete, redeem flow, orders list, order detail.
- Audit surfaces: redemption fields, barcode, challenge, authz, list/detail handlers, UI state, native share/clipboard.
- Required checks: no cross-user access, safe share data, no arbitrary remote fetch, stored purchase cleanup, error paths, tests.

## UJ-007: Cashback Dashboard and Wallet Setup

- Actor: authenticated user.
- Entry points: cashback dashboard, merchant cashback detail, settings cashback, wallet settings, trustline setup.
- Audit surfaces: user credits, pending payouts, rail mix, cashback charts, wallet address validation, trustline status, shared types.
- Required checks: home currency, Stellar public key validation, pending vs paid math, unauthenticated redirects, stale data, tests.

## UJ-008: Native App Lifecycle

- Actor: native mobile user.
- Entry points: app load, secure storage, app lock, biometrics, back button, task switcher overlay, network/offline, keyboard, status bar.
- Audit surfaces: Capacitor wrappers, mobile static export, overlays, native package parity, platform detection.
- Required checks: fail-closed vs fail-open, storage persistence, background/foreground transitions, permissions, backup exclusion, tests/manual plan.
