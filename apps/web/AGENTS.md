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
│   ├── features/     ← Domain components (Navbar, MerchantCard, ClusterMap, purchase/)
│   └── ui/           ← Primitives (Button, Input, Spinner)
├── hooks/            ← useAuth, useMerchants, useNativePlatform, slug
├── services/         ← Typed API client (one function per backend endpoint)
├── stores/           ← Zustand (auth session, purchase flow, UI state)
├── native/           ← Capacitor plugin wrappers (haptics, secure storage, platform)
├── utils/            ← Image proxy URL builder
└── root.tsx          ← Layout, QueryClientProvider, meta, links
```

## Key patterns

**Data fetching:** Always via TanStack Query hooks in `hooks/`. Never in loaders (pure API client).

**API calls:** Always through `services/api-client.ts`. Authenticated calls use `authenticatedRequest()` which handles token injection and silent refresh on 401.

**Auth flow:** `useAuth()` hook → `services/auth.ts` → backend proxy → upstream CTX. Tokens stored: access token in Zustand (memory only), refresh token in Capacitor Preferences (native) or sessionStorage (web).

**Purchase flow state machine:** Managed by `stores/purchase.store.ts`. Steps: `amount → payment → complete | error`. The `PurchaseContainer` orchestrates the flow, `PaymentStep` polls order status with countdown timer.

**Error handling:** `useAuth()` throws `Error` with user-facing messages mapped from `ApiException` status codes (401, 429, 502, 503). Payment polling distinguishes permanent (401, 503) from transient errors.

**Capacitor plugins:** Only imported in `app/native/`. Components use the native wrappers, never `@capacitor/*` directly. ESLint enforces this.

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

1. Install the plugin: `npm install @capacitor/foo -w @loop/web -w @loop/mobile`
2. Create wrapper in `app/native/foo.ts` (lazy import, graceful web fallback)
3. Use the wrapper in components — never import `@capacitor/foo` directly
4. ESLint will block direct imports outside `app/native/`

## Build modes

- `npm run build` → SSR (for loopfinance.io)
- `npm run build:mobile` → static export (for Capacitor binary)
- `react-router.config.ts` switches via `BUILD_TARGET` env var
