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
├── routes/          # File-based routes (React Router v7)
├── components/
│   ├── features/    # MerchantCard, PurchaseFlow, ClusterMap, etc.
│   └── ui/          # Button, Input, Card, etc.
├── hooks/           # useAuth, useMerchants, useNativePlatform
├── native/          # Capacitor plugin wrappers (haptics, secure storage)
├── services/        # Typed API client — one function per endpoint
└── stores/          # Zustand — auth session, UI state
```

## Build modes

`react-router.config.ts` switches SSR on/off via `BUILD_TARGET`:

- Default (`npm run build`): SSR enabled — for loop.app
- `BUILD_TARGET=mobile` (`npm run build:mobile`): static export — for Capacitor

In static mode, server-side loaders cannot run. All data fetching is client-side via TanStack Query.
