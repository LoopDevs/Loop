# @loop/web

React Router v7 + Vite web application. Builds to SSR (web) or static export (mobile).

## Quickstart

```bash
cp .env.local.example .env.local   # set VITE_API_URL
npm run dev                         # dev server on :5173
```

Requires `apps/backend` running on the URL set in `VITE_API_URL`.

## Commands

```bash
npm run dev              # React Router dev server (SSR mode)
npm run build            # SSR production build
npm run build:mobile     # static export for Capacitor (BUILD_TARGET=mobile)
npm start                # serve SSR build locally
npm run typecheck        # react-router typegen + tsc --noEmit
npm test                 # vitest run
npm run test:coverage    # vitest + coverage report
```

## App structure

```
app/
├── routes/          # File-based routes — home, auth, map, orders,
│                    # gift-card.$name, not-found; declared in app/routes.ts
├── components/
│   ├── features/    # Domain components — Navbar, MerchantCard,
│   │                # ClusterMap, MapBottomSheet, NativeTabBar,
│   │                # NativeBackButton, and the purchase/ subtree
│   │                # (AmountSelection → PaymentStep →
│   │                # PurchaseComplete / RedeemFlow, orchestrated by
│   │                # PurchaseContainer)
│   └── ui/          # Primitives — Button, Input, Spinner, LazyImage,
│                    # OfflineBanner, ToastContainer
├── hooks/           # useAuth, useAllMerchants, useMerchants,
│                    # useMerchantBySlug, useMerchant, useOrders,
│                    # useOrder, useNativePlatform, useSessionRestore,
│                    # query-retry (shared TanStack Query retry predicate)
├── native/          # Capacitor plugin wrappers — imports of @capacitor/*
│                    # and @aparajita/* are restricted to this folder
│                    # by eslint no-restricted-imports. Contents:
│                    # platform, haptics, clipboard, back-button,
│                    # keyboard, network, status-bar, share,
│                    # notifications, screenshot-guard, webview,
│                    # biometrics, app-lock, purchase-storage, and
│                    # secure-storage (keychain-backed — ADR-006)
├── services/        # Typed API client — api-client (auth + coalesced
│                    # refresh), auth, clusters, merchants, orders,
│                    # config (API_BASE)
├── stores/          # Zustand — auth.store, purchase.store (state
│                    # machine: amount → payment → complete / redeem /
│                    # error), ui.store (theme + toasts)
└── utils/           # Pure functions — error-messages (status-aware),
                     # image (proxy URL builder), money (currency-aware
                     # formatter), security-headers (CSP)
```

## Build modes

`react-router.config.ts` switches SSR on/off via `BUILD_TARGET`:

- Default (`npm run build`): SSR enabled — for loopfinance.io
- `BUILD_TARGET=mobile` (`npm run build:mobile`): static export — for Capacitor

In static mode, server-side loaders cannot run. All data fetching is client-side via TanStack Query.
