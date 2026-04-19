# Web — Agent Guide

> Read this before modifying anything in `apps/web/`.

## Structure

```
app/
├── routes/           ← File-based routes (React Router v7)
│   ├── home.tsx      ← Merchant directory (featured + all)
│   ├── auth.tsx      ← Email → OTP login flow
│   ├── gift-card.$name.tsx  ← Merchant detail + purchase flow
│   ├── map.tsx       ← Cluster map (lazy-loaded Leaflet)
│   ├── orders.tsx    ← Order history (paginated)
│   └── not-found.tsx ← 404 catch-all
├── components/
│   ├── features/     ← Domain components (Navbar, Footer, MerchantCard, ClusterMap,
│   │                   MapBottomSheet, NativeTabBar, NativeBackButton, purchase/)
│   └── ui/           ← Primitives (Button, Input, LazyImage, OfflineBanner, Skeleton,
│                       Spinner, ToastContainer)
├── hooks/            ← TanStack Query wrappers + lifecycle (use-auth, use-merchants,
│                       use-orders, use-native-platform, use-session-restore, query-retry)
├── services/         ← Typed API client (api-client, auth, clusters, merchants, orders, config)
├── stores/           ← Zustand (auth.store, purchase.store, ui.store)
├── native/           ← Capacitor plugin wrappers (platform, haptics, secure-storage,
│                       biometrics, app-lock, back-button, clipboard, keyboard, network,
│                       notifications, purchase-storage, screenshot-guard, share,
│                       status-bar, webview)
├── utils/            ← error-messages, image (proxy URL builder), money, security-headers
└── root.tsx          ← Layout, QueryClientProvider, meta, links
```

## Key patterns

**Data fetching:** Always via TanStack Query hooks in `hooks/`. Never in loaders (pure API client).

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
3. Create a hook in `app/hooks/` if it's used reactively (TanStack Query)
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
