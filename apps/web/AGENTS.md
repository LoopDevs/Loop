# Web — Agent Guide

> Read this before modifying anything in `apps/web/`.

## Structure

```
app/
├── routes/           ← File-based routes (React Router v7, 34 routes)
│   ├── home.tsx, map.tsx, gift-card.$name.tsx, brand.$slug.tsx, auth.tsx,
│   │   onboarding.tsx, calculator.tsx, sitemap.tsx,
│   │   privacy.tsx, terms.tsx, not-found.tsx
│   ├── orders.tsx, orders.$id.tsx          ← order history + detail
│   ├── cashback.tsx, cashback.$slug.tsx    ← user cashback dashboard
│   ├── settings.*.tsx                      ← profile / wallet / cashback / home-currency
│   └── admin.*.tsx (17 routes)             ← admin panel: treasury / cashback /
│                                             orders / users / merchants / operators /
│                                             payouts / assets / audit / stuck-orders
├── components/
│   ├── features/     ← Domain components, grouped by feature:
│   │   ├── admin/    ← ~40 components (treasury, cashback, operator, supplier,
│   │   │               payout, mix-axis-matrix cards + csv export)
│   │   ├── auth/     ← social login button, email+OTP flow
│   │   ├── cashback/ ← flywheel chip, balance, pending-payouts, rail-mix
│   │   ├── home/     ← stats bands (cashback + flywheel)
│   │   ├── onboarding/ ← biometric, currency, wallet-trust, signup-tail
│   │   ├── order/    ← per-order payout card
│   │   ├── orders/   ← loop-orders list + summary header
│   │   ├── purchase/ ← amount → payment → complete / redeem state machine
│   │   ├── wallet/   ← Stellar trustline status / setup cards
│   │   └── top-level: Navbar, Footer, MerchantCard, MerchantGroupCard, ClusterMap, MapBottomSheet,
│   │                  NativeTabBar, NativeBackButton, FixedSearchButton
│   └── ui/           ← Primitives (Button, Input, LazyImage, OfflineBanner,
│                       Skeleton, Spinner, ToastContainer)
├── hooks/            ← TanStack Query wrappers + lifecycle (use-auth, use-merchants,
│                       use-orders, use-native-platform, use-session-restore, query-retry)
├── services/         ← Typed API client (api-client, auth, clusters, merchants,
│                       orders, orders-loop, config, admin, user, public-stats,
│                       parse-error-response)
├── stores/           ← Zustand (auth.store, purchase.store, ui.store)
├── native/           ← Capacitor plugin wrappers (platform, haptics, secure-storage,
│                       biometrics, app-lock, back-button, clipboard, keyboard, network,
│                       notifications, purchase-storage, share, task-switcher-overlay,
│                       status-bar, webview)
├── utils/            ← admin-cache, error-messages, image, locale, money,
│                       security-headers, query-error-reporting (A2-1322),
│                       sentry-error-scrubber (A2-1312), sentry-scrubber (A2-1308)
└── root.tsx          ← Layout, QueryClientProvider (QueryCache + MutationCache
                        forwarding to Sentry), Sentry.init with LOOP_ENV, meta, links
```

## Key patterns

**Data fetching:** Always via TanStack Query and never in loaders (pure API client). Reusable domain fetchers still belong in `hooks/`, but route/component-local `useQuery` is allowed when the query is genuinely local to one surface. In both cases the rules are the same: call only `services/*`, use the flat query-key taxonomy below, set an explicit `staleTime`, use `shouldRetry` unless the surface has a documented reason not to, and keep invalidation logic in the same file or `utils/admin-cache.ts`.

**Query-key taxonomy:** flat hyphenated strings — `['admin-treasury']`, `['admin-user-credits', userId]`, `['merchants']`, `['me', 'credits']` (me-surface only uses a 2-element array because the first element is a scope selector, not a module name). Never add a hierarchical admin key like `['admin', 'treasury']` — it overlaps cosmetically with me-surface keys and defeats the flat convention. For the rare case where a mutation invalidates a broad admin surface, `utils/admin-cache.ts::invalidateAllAdminQueries(queryClient)` sweeps every `admin-*` key via predicate.

**Locale policy (A2-1521):** admin surfaces import `ADMIN_LOCALE` from `utils/locale.ts` (pinned `en-US`) so every operator sees identical number / date formatting regardless of their browser locale — operator screenshots in support tickets must be comparable. User-facing surfaces pass `USER_LOCALE` (currently `undefined`, so `Intl` picks up the browser locale) so dates and thousands separators feel native. Never hardcode `'en-US'` in a component — the two constants are the single point of change when the policy evolves.

**API calls:** Always through `services/api-client.ts`. Authenticated calls use `authenticatedRequest()` which handles token injection and silent refresh on 401.

**Auth flow:** `useAuth()` hook → `services/auth.ts` → backend proxy → upstream CTX. Tokens stored: access token in Zustand (memory only), refresh token via `@aparajita/capacitor-secure-storage` (Keychain on iOS / EncryptedSharedPreferences on Android — audit A-024, ADR-006) on native, or `sessionStorage` on web. The secure-storage wrapper also one-shot-migrates any legacy `@capacitor/preferences` value on first read so upgrades don't log every user out.

**Purchase flow state machine:** Managed by `stores/purchase.store.ts`. Steps: `amount → payment → complete | redeem | error`. The `PurchaseContainer` orchestrates the flow, `PaymentStep` polls order status with a countdown timer and enforces a bounded retry budget (`MAX_CONSECUTIVE_ERRORS = 5`, audit A-030).

**Error handling:** `useAuth()` throws `Error` with user-facing messages mapped from `ApiException` status codes (401, 429, 502, 503). Payment polling stops on 401 (session expired) and surfaces a connection error after 5 consecutive transient failures; 503 doesn't count against the budget because the circuit breaker runs its own backoff.

**Capacitor plugins:** Only imported in `app/native/`. Components use the native wrappers, never `@capacitor/*`, `@aparajita/capacitor-*`, or `@capgo/*` directly. ESLint `no-restricted-imports` blocks all three patterns outside `app/native/`.

## Recipe: Add a new route

1. Create `app/routes/my-route.tsx` with `meta()`, `ErrorBoundary`, and default export
2. Add to `app/routes.ts`: `route('my-route', 'routes/my-route.tsx')`
3. Use `useNativePlatform()` to conditionally render Navbar (hidden on native)
4. Fetch data via hooks (e.g., `useMerchants`), not in loaders

## Recipe: Add a new API call

1. Add the typed function in `app/services/` (use `apiRequest` or `authenticatedRequest`)
2. If it returns new types, add them to `packages/shared/src/`
3. Create a hook in `app/hooks/` when the query is reusable across multiple surfaces or needs shared invalidation policy. One-off route/component queries can stay local as long as they still go through `services/*`, use flat query keys, and spell out `staleTime` / `retry`.
4. Never call `fetch()` directly from components

## Recipe: Add a Capacitor plugin

1. Install the plugin: `npm install @capacitor/foo -w @loop/web -w @loop/mobile` (or `@aparajita/capacitor-foo`, `@capgo/foo` — the ESLint boundary covers all three org patterns)
2. Create wrapper in `app/native/foo.ts` (lazy import, graceful web fallback)
3. Use the wrapper in components — never import the plugin package directly
4. ESLint `no-restricted-imports` will block `@capacitor/*`, `@aparajita/capacitor-*`, and `@capgo/*` imports outside `app/native/`

## Build modes

- `npm run build` → SSR (for loopfinance.io)
- `npm run build:mobile` → static export (for Capacitor binary)
- `react-router.config.ts` switches via `BUILD_TARGET` env var
