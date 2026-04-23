# Phase 8b — Web components / hooks / services / stores / utils (evidence)

**Commit SHA at capture:** `450011ded294b638703a9ba59f4274a3ca5b7187`
**Date captured:** 2026-04-23
**Auditor:** cold-reviewer (Phase 8b)
**Scope:** `apps/web/app/components/**` (101 non-test `.tsx` files — 52 in `components/features/admin/`, 8 in `components/features/` root, plus 10 in ui, plus feature subdirs cashback/home/onboarding/order/orders/purchase/wallet/auth), `apps/web/app/hooks/**` (7 hooks + `index.ts`), `apps/web/app/services/**` (10 service modules), `apps/web/app/stores/**` (3 stores), `apps/web/app/utils/**` (6 utils).
**Out of scope (Phase 8a):** `routes/`, `root.tsx`, `native/`, `app.css`, `public/`.

Primary evidence: direct file reads with line numbers, greps across the scoped trees, cross-references to backend error-code emission points. No source modified.

---

## 1. Services layer — backend-call surface

### 1.1 Services × endpoint × query-key matrix

| Service file      | Functions exported                                                                                                                                                                                                                                                                                                                                   | Auth type                                                  | Query key(s) (if consumed by useQuery / invalidations)                                                                                                                                                                                                                                                                                                   | Retry via `shouldRetry`?  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `api-client.ts`   | `apiRequest`, `authenticatedRequest`, `tryRefresh`                                                                                                                                                                                                                                                                                                   | core                                                       | n/a — transport; injects `Authorization` + `X-Client-Id` headers; 30s timeout via composed `AbortSignal`                                                                                                                                                                                                                                                 | n/a                       |
| `config.ts`       | `fetchAppConfig`, `API_BASE`                                                                                                                                                                                                                                                                                                                         | public                                                     | `['app-config']`                                                                                                                                                                                                                                                                                                                                         | `retry: false` (explicit) |
| `auth.ts`         | `requestOtp`, `verifyOtp`, `socialLoginGoogle`, `socialLoginApple`, `logout`                                                                                                                                                                                                                                                                         | public (for request/verify, social), authed DELETE session | none — imperative via `useAuth.logout`/`useOnboardingAuth`                                                                                                                                                                                                                                                                                               | n/a                       |
| `clusters.ts`     | `fetchClusters`                                                                                                                                                                                                                                                                                                                                      | public                                                     | none (imperative; `ClusterMap.tsx` drives its own `AbortController`)                                                                                                                                                                                                                                                                                     | n/a                       |
| `merchants.ts`    | `fetchMerchants`, `fetchAllMerchants`, `fetchMerchant`, `fetchMerchantBySlug`, `fetchMerchantCashbackRate`, `fetchMerchantsCashbackRates`                                                                                                                                                                                                            | mixed (detail=authed; rest public)                         | `['merchants', {...}]`, `['merchants-all']`, `['merchant-by-slug', slug]`, `['merchant', id]`, `['merchant-cashback-rate', id]`, `['merchants-cashback-rates']`                                                                                                                                                                                          | yes (via `use-merchants`) |
| `orders.ts`       | `createOrder`, `fetchOrders`, `fetchOrder`                                                                                                                                                                                                                                                                                                           | authed                                                     | `['orders', { page }]`, `['order', id]`                                                                                                                                                                                                                                                                                                                  | yes (via `use-orders`)    |
| `orders-loop.ts`  | `createLoopOrder`, `getLoopOrder`, `listLoopOrders`, `loopOrderStateLabel`, `isLoopOrderTerminal`                                                                                                                                                                                                                                                    | authed (Loop-native JWT)                                   | `['loop-orders']` (only)                                                                                                                                                                                                                                                                                                                                 | yes (LoopOrdersList)      |
| `user.ts`         | `setHomeCurrency`, `getMe`, `setStellarAddress`, `getCashbackHistory`, `getUserPendingPayouts`, `getUserPendingPayoutsSummary`, `getUserStellarTrustlines`, `getUserPayoutByOrder`, `getMyCredits`, `getCashbackSummary`, `getCashbackByMerchant`, `getCashbackMonthly`, `getUserOrdersSummary`, `getUserFlywheelStats`, `getUserPaymentMethodShare` | authed                                                     | `['me']`, `['me','credits']`, `['me','cashback-summary']`, `['me','cashback-history', …]`, `['me','cashback-by-merchant']`, `['me','cashback-monthly']`, `['me','pending-payouts']`, `['me','pending-payouts-summary']`, `['me','flywheel-stats']`, `['me','payment-method-share','fulfilled']`, `['me','orders','summary']`, `['order', id, 'payout']`  | yes (all call sites)      |
| `public-stats.ts` | `getPublicCashbackStats`, `getPublicTopCashbackMerchants`, `getPublicMerchant`, `getPublicCashbackPreview`, `getPublicLoopAssets`, `getPublicFlywheelStats`                                                                                                                                                                                          | public                                                     | `['public-cashback-stats']`, `['public-top-cashback-merchants', N]`, `['public-merchant', slug]`, `['public-cashback-preview', …]`, `['public-loop-assets']`, `['public-flywheel-stats']`                                                                                                                                                                | mostly yes; one opts out  |
| `admin.ts`        | 90+ functions (cashback configs, treasury, payouts, orders, users, merchants, operators, assets, credit-flow, csv download, retry/adjustment writes, etc.)                                                                                                                                                                                           | authed (admin-only on server)                              | mixed `admin-...` flat keys: `admin-users`, `admin-user`, `admin-cashback-configs`, `admin-treasury`, `admin-payouts`, `admin-payouts-by-asset`, `admin-top-users-by-pending-payout`, `admin-operator-stats`, `admin-merchant-stats`, etc. Two outliers use hierarchical `['admin', 'cashback-monthly']` / `['admin', 'payouts-monthly']` (see A2-1155). | yes (all useQuery sites)  |

**Confirmed: services is the only backend-call surface.** `grep -n "\bfetch\s*(" apps/web/app/{components,hooks,stores,utils}` returns **zero** hits. The only three `fetch(` occurrences in `apps/web/app/` outside services are `services/api-client.ts:56`, `services/clusters.ts:37`, `services/config.ts:38` (all in services), and — out of Phase 8b scope — `routes/sitemap.tsx:40` and `native/share.ts:42,112`. **No component bypasses the services layer with a direct `fetch()`.** (Phase 8a's `sitemap` SSR-only loader is documented in phase-8a evidence; `native/share.ts` is Phase 8a/9 scope.)

### 1.2 Error-taxonomy consumption (G4-02) — gap table

Backend emits these unique `code` values (grep over `apps/backend/src/**/*.ts`):

```
HOME_CURRENCY_LOCKED   IDEMPOTENCY_KEY_REQUIRED   IMAGE_TOO_LARGE
INSUFFICIENT_BALANCE   INSUFFICIENT_CREDIT        INTERNAL_ERROR
NOT_AN_IMAGE           NOT_CONFIGURED             NOT_FOUND
RATE_LIMITED           SERVICE_UNAVAILABLE        UNAUTHORIZED
UPSTREAM_ERROR         UPSTREAM_REDIRECT          UPSTREAM_UNAVAILABLE
VALIDATION_ERROR       WEBHOOK_NOT_CONFIGURED
```

Client-synthesised (via `services/api-client.ts:61,64,66` and `services/clusters.ts:43,46,48`): `TIMEOUT`, `NETWORK_ERROR`.

Web UX translations:

- `utils/error-messages.ts :: friendlyError` — maps _only_ HTTP `status ∈ {429, 502, 503, 504}` + client codes `TIMEOUT` / `NETWORK_ERROR`. Returns `fallback` for everything else including `UPSTREAM_ERROR` at other statuses, `INSUFFICIENT_CREDIT` (400), `HOME_CURRENCY_LOCKED` (409), `INSUFFICIENT_BALANCE` (400), `UPSTREAM_REDIRECT` (502), `WEBHOOK_NOT_CONFIGURED` (409), `NOT_AN_IMAGE` (502), `IMAGE_TOO_LARGE` (413).
- `hooks/use-auth.ts :: authErrorMessage` — a **second**, divergent translator covering only `status ∈ {401, 429, 502, 503}`; 401 gets a hard-coded "Incorrect or expired code" string appropriate for OTP verify but wrong for `requestOtp`/social-login callers. Does not consult `err.code`.
- `components/**` : two files switch on `err.code`: `ClusterMap.tsx:137` (only `'TIMEOUT'` for abort-detection) and `ClusterMap.tsx:352-354` (a `GeolocationPositionError`, not ApiException). **No component uses `err.code === 'INSUFFICIENT_CREDIT' | 'HOME_CURRENCY_LOCKED' | 'INSUFFICIENT_BALANCE' | 'WEBHOOK_NOT_CONFIGURED'`** — the codes with UX intent are entirely unconsumed outside tests (`routes/__tests__/settings.wallet.test.tsx:288` asserts a `HOME_CURRENCY_LOCKED` code flows through but the route renders the generic `error` message; `components/features/admin/__tests__/DiscordNotifiersCard.test.tsx:138` exercises `WEBHOOK_NOT_CONFIGURED` but the component renders a generic `Ping failed: ...` message from `err.message`).
- Codes never documented in any shared TypeScript union — no `type ApiErrorCode = 'UNAUTHORIZED' | ...` in `@loop/shared`. The `code` field is `string` (`packages/shared/src/api.ts`). Adding a new server code will compile; removing one will also compile; drift is invisible.

### 1.3 Services consistency checks

- **api-client vs clusters body parsing.** `api-client.ts:69-98` and `clusters.ts:51-82` each re-implement non-ok body normalisation; they're byte-for-byte parallel but duplicated (comment on `clusters.ts:54-56` acknowledges the duplication). Drift risk: a future fix to one will silently miss the other. Already flagged as intentional by author comment; still carried (A2-1162 below).
- **Refresh failure → storage clear.** `api-client.ts:163-178` (`doRefresh` catch) correctly distinguishes definitive rejection (4xx except 429) from transient (5xx, 429, network) and only clears storage on definitive. **But** `use-session-restore.ts:25` unconditionally calls `useAuthStore.getState().clearSession()` on _any_ null return, which wipes the refresh token from secure storage via `clearRefreshToken()`. On a cold-boot where upstream/backend has a transient blip (5xx or network), this silently logs the user out locally and removes the token that was still valid — the careful "keep on disk" branch in `doRefresh` is undone at boot. (A2-1150 high.)
- **Admin idempotency-key generation.** `admin.ts :: retryPayout` (1133-1136) and `applyCreditAdjustment` (1835-1838) both generate a UUID client-side (with a `Date.now() + Math.random()` fallback). The server stores the key in `admin_idempotency_keys`; a client-side generated per-click key means a user refreshing a "retry succeeded" confirmation produces a _new_ key and therefore a _new_ attempt, defeating the point of idempotency if the user navigates away and back while the first request is still in flight. Not a phase-8b violation per se (it's the admin-UI design, not the service), but worth noting the envelope response's `audit.replayed` flag (`admin.ts:1110-1120`) has **no consumer** — no component branches on it to tell the operator "this was a replay". A2-1163.

---

## 2. Stores — invariant × reset × persistence matrix

| Store               | State shape                                                                                                                                                                                         | Reset path       | Persistence                                                                                                                                                                                                                                                                                          | Cross-tab / native assumptions                                                                                                                                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.store.ts`     | `{ email, accessToken }` (memory only)                                                                                                                                                              | `clearSession()` | `clearSession` calls `clearRefreshToken()` (native: Keychain `remove(REFRESH_TOKEN_KEY)` **and** `remove(EMAIL_KEY)`; web: `sessionStorage.removeItem` both). `wasAuthed` = `false`.                                                                                                                 | `wasAuthedLastSession()` reads `localStorage` un-guarded (wrapped in try/catch so SSR `ReferenceError` doesn't throw). `setSession` fires `storeRefreshToken` + `storeEmail` fire-and-forget (`void` — storage failure never surfaces).                              |
| `purchase.store.ts` | `{ step, merchantId, merchantName, amount, paymentAddress, xlmAmount, orderId, expiresAt, memo, giftCardCode, giftCardPin, barcodeImageUrl, redeemUrl, redeemChallengeCode, redeemScripts, error }` | `reset()`        | `savePendingOrder` / `clearPending` through `~/native/purchase-storage` (Capacitor Preferences on native, sessionStorage on web). Queued through a `persistQueue` so save/clear lands in order. Snapshot has `loadPendingOrderSync()` at module load, validated against `validatePersistedPurchase`. | `loadPendingOrderSync` reads `sessionStorage.getItem(PENDING_ORDER_KEY)` at module load, unguarded but try/catch'd. Only `step === 'payment'` restores. `logout` does **not** call `usePurchaseStore.getState().reset()` — state leaks across users. (A2-1151.)      |
| `ui.store.ts`       | `{ themePreference ('system'\|'light'\|'dark'), theme ('light'\|'dark'), toasts: Toast[] }`                                                                                                         | none explicit    | `localStorage['theme']` for preference; toasts in-memory, capped `MAX_TOASTS=5`, auto-dismiss timers tracked in module-level `Map` so `removeToast` cancels the pending setTimeout.                                                                                                                  | `resolveTheme` checks `typeof window !== 'undefined'` (line 27); `loadPreference` does not but its `localStorage.getItem` is try/catch'd. Timer map is module-level, not per-store-instance — fine for singletons but would collide if the store is ever re-created. |

### 2.1 Logout completeness (plan G6-30)

`useAuth.logout()` (`hooks/use-auth.ts:84-90`) calls backend `logout()` then `store.clearSession()`. Coverage:

- Access token (memory): **cleared** (via `clearSession`).
- Refresh token (Keychain / sessionStorage): **cleared** (via `clearRefreshToken`).
- Email (secure storage): **cleared** (`clearRefreshToken` also removes `EMAIL_KEY`, by design — see `native/secure-storage.ts:122,132`).
- `wasAuthed` flag in `localStorage`: **cleared** (`setWasAuthed(false)` in `clearSession`).
- Server-side refresh-token revocation: **attempted** via `services/auth.ts :: logout` DELETE `/api/auth/session`; failure is swallowed in `try/catch` so local clear always proceeds (documented intent, `auth.ts:65-69,82-84`).
- Purchase-flow state (`purchase.store.ts`): **not reset**. A user who logs out mid-purchase leaves `merchantId`, `paymentAddress`, and `orderId` in memory; next user on shared browser/device sees that state when `PurchaseContainer` mounts. (A2-1151 high.)
- React Query cache: **not cleared**. `grep -rn "queryClient\.clear\|queryClient\.resetQueries"` returns zero hits; only per-feature `invalidateQueries` after admin mutations. A user-switch on a shared device retains the previous user's cashback summary, orders list, credits, pending-payouts, etc. in RAM for the default `gcTime` (5 min) and will render briefly before refetching. (A2-1152 high.)
- UI store (`themePreference` / `toasts`): **not reset** — theme preference is deliberately user-scoped cross-session; toasts flush on route change implicitly. Not a finding.

---

## 3. Hooks — SWR semantics, dependency-array, SSR safety

| Hook                           | File                       | SWR settings                                                                                       | `enabled`                 | SSR-safe?                                                                      | Notes                                                                                                                                                                                               |
| ------------------------------ | -------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useAuth`                      | `use-auth.ts`              | imperative wrappers; no `useQuery`                                                                 | —                         | yes                                                                            | `authErrorMessage` diverges from `friendlyError` (A2-1154).                                                                                                                                         |
| `useSessionRestore`            | `use-session-restore.ts`   | side-effect only                                                                                   | —                         | module-level boot triggers only when `typeof window !== 'undefined'` (line 34) | Unconditional `clearSession` on null refresh erases refresh token on transient failure (A2-1150). Empty effect dep array with `// eslint-disable-next-line react-hooks/exhaustive-deps` at line 79. |
| `useNativePlatform`            | `use-native-platform.ts`   | local state                                                                                        | —                         | yes                                                                            | Defaults to `{ platform: 'web', isNative: false }` on SSR; effect re-reads on mount.                                                                                                                |
| `useAppConfig`                 | `use-app-config.ts`        | `staleTime: 10 min`, `retry: false`                                                                | always                    | yes                                                                            | Missing `refetchOnReconnect` — if backend is down at first load then recovers, flags stay at defaults until the next full app restart.                                                              |
| `useMerchants`                 | `use-merchants.ts:32-51`   | `staleTime: 5 min`, `refetchOnWindowFocus: true`, `refetchOnReconnect: true`, `retry: shouldRetry` | always                    | yes                                                                            |                                                                                                                                                                                                     |
| `useAllMerchants`              | `use-merchants.ts:60-83`   | same as above                                                                                      | always                    | yes                                                                            |                                                                                                                                                                                                     |
| `useMerchantBySlug`            | `use-merchants.ts:86-109`  | same + `enabled: normalized.length > 0`                                                            | normalized slug nonempty  | yes                                                                            |                                                                                                                                                                                                     |
| `useMerchant`                  | `use-merchants.ts:119-145` | same + caller-controlled `enabled`                                                                 | caller                    | yes                                                                            | Hits authed `/api/merchants/:id`; caller must gate on isAuthenticated or else 401.                                                                                                                  |
| `useMerchantCashbackRate`      | `use-merchants.ts:159-170` | `staleTime: 5 min`, `retry: shouldRetry`                                                           | normalized nonempty       | yes                                                                            | No `refetchOnReconnect`; not important for a purely-additive badge.                                                                                                                                 |
| `useMerchantsCashbackRatesMap` | `use-merchants.ts:180-193` | same                                                                                               | always                    | yes                                                                            |                                                                                                                                                                                                     |
| `useOrders`                    | `use-orders.ts:28-55`      | `staleTime: 30s`, `refetchOnWindowFocus: true`, `refetchOnReconnect: true`, `retry: shouldRetry`   | `isAuthenticated`         | yes                                                                            | Correct.                                                                                                                                                                                            |
| `useOrder`                     | `use-orders.ts:58-83`      | `staleTime: 30s`, `refetchOnReconnect: true`, `retry: shouldRetry`                                 | `isAuthenticated && id>0` | yes                                                                            |                                                                                                                                                                                                     |

### 3.1 Components with inline `useQuery` that skip the `enabled: isAuthenticated` gate

Identified by `grep -rl "useQuery"` in `components/features/cashback` and `components/features/orders` and matching for absence of any `enabled[:=]`:

```
components/features/cashback/MonthlyCashbackChart.tsx:31      ['me', 'cashback-monthly']
components/features/cashback/CashbackBalanceCard.tsx:35       ['me', 'credits']
components/features/cashback/FlywheelChip.tsx:30              ['me', 'flywheel-stats']
components/features/cashback/PendingPayoutsCard.tsx:28        ['me', 'pending-payouts']
components/features/cashback/RailMixCard.tsx:50               ['me', 'payment-method-share', 'fulfilled']
components/features/cashback/LinkWalletNudge.tsx:38,44        ['me'], ['me', 'credits']
components/features/cashback/CashbackEarningsHeadline.tsx:36  ['me', 'cashback-summary']
components/features/cashback/PendingCashbackChip.tsx:76       ['me', 'pending-payouts-summary']
components/features/cashback/CashbackByMerchantCard.tsx:42    ['me', 'cashback-by-merchant']
components/features/orders/OrdersSummaryHeader.tsx:24         ['me', 'orders', 'summary']
```

Parents (`/settings/cashback`, `/settings/wallet`, `/orders`, `/admin/users/:userId`, `/admin/merchants/:merchantId`, `/auth`) gate rendering on authenticated state, so these are defensively fine in the happy path. During the `useSessionRestore` window on cold boot these fire against the API before `accessToken` is set, hit the memory-null branch in `authenticatedRequest`, call `tryRefresh`, coalesce through the shared promise — all safe but wasteful (N queries each wake the refresh path). (A2-1156 medium.)

### 3.2 Module-level boot work in `use-session-restore.ts`

Line 11: `let bootRestore: Promise<void> | null = null;` module-level singleton.
Line 34-36: fired at module import when `typeof window !== 'undefined'`.
Line 20: calls `tryRefresh()` → which on failure returns `null`, and line 25 `useAuthStore.getState().clearSession()` **wipes the refresh token from Keychain / sessionStorage** even on transient (5xx / 429 / network) failure (see 1.3 above — A2-1150 high).

### 3.3 Hooks import surface

`hooks/index.ts` re-exports: `useNativePlatform`, `useMerchants`, `useAllMerchants`, `useMerchant`, `useMerchantBySlug`, `useOrders`, `useOrder`, `useAuth`, `useSessionRestore`. Missing from the barrel: `useAppConfig`, `shouldRetry`, `useMerchantCashbackRate`, `useMerchantsCashbackRatesMap`. Callers therefore split between `~/hooks` (barrel) and `~/hooks/use-app-config` / `~/hooks/query-retry` / `~/hooks/use-merchants` (direct file import). The barrel is present but leaky — inconsistent import style shows up in grep (`grep -c "from '~/hooks/"` vs `"from '~/hooks'"`). (A2-1164 low.)

### 3.4 In-component `useQuery` using `shouldRetry`

All 42 components that call `useQuery` import `shouldRetry` (grep confirmed). The two components without `retry:`/`shouldRetry` in file-level grep (`MerchantResyncButton.tsx`, `CreditAdjustmentForm.tsx`) use `useMutation` only, not `useQuery` — no finding.

---

## 4. Components — dumb/smart split, a11y, dark-mode

### 4.1 Duplicated service-layer behaviour

- **`components/features/onboarding/signup-tail.tsx :: useOnboardingAuth`** (435-484) **duplicates** `hooks/use-auth.ts :: useAuth.{verifyOtp, requestOtp}` with a _different_ error translator (`friendlyError` from utils, vs the in-hook `authErrorMessage`). The onboarding form imports `requestOtp` / `verifyOtp` from `~/services/auth` directly and owns its own `sending` / `verifying` / `error` booleans. Two user-visible auth flows therefore have _different_ UX strings for the same backend error: OTP on `/auth` renders `authErrorMessage` ("Incorrect or expired code"), OTP on `/onboarding` renders `friendlyError` ("Invalid code. Please try again."). (A2-1154 medium.)
- **`routes/settings.wallet.tsx` credit/currency mutation** (out-of-scope for 8b) independently hand-rolls 409 `HOME_CURRENCY_LOCKED` translation — no consumer of that code in the services or hooks layer.

### 4.2 Dumb vs smart discipline

`components/ui/` (9 files) is pure-presentational: `Button.tsx`, `Input.tsx`, `LazyImage.tsx`, `OfflineBanner.tsx`, `PageHeader.tsx`, `Skeleton.tsx`, `Spinner.tsx`, `ToastContainer.tsx`. The one with side-effect exposure is `OfflineBanner.tsx:8-10` (subscribes to `watchNetwork` from `~/native/network` — that boundary is fine); `ToastContainer.tsx` subscribes to the UI store only; `PageHeader.tsx:46` reads `window.history.length` inside a click handler after an `isNative` early return, SSR-safe.

`components/features/` is more mixed: most feature components own their own `useQuery`/`useMutation` (e.g. `AdminAuditTail.tsx`, `PendingPayoutsCard.tsx`, `MobileHome.tsx`) and render. No feature component is entirely presentational-only _and_ bypasses services.

### 4.3 `dangerouslySetInnerHTML`

Single occurrence: `root.tsx:218` (inline theme-resolve script) — Phase 8a scope. Zero occurrences in `components/`.

### 4.4 Leaflet popup innerHTML + XSS surface

`components/features/ClusterMap.tsx:213-231` builds a popup HTML template string and calls `popup.setContent(popupContent)`. `divIcon` instances at `:172` and `:193` also set HTML. The auditor confirmed `escapeHtml` (defined `:22-29`) is applied to every interpolation: `${safeName}`, `${safePinLargeUrl}`, `${safePinSmallUrl}`, and the static `${safeHref}` goes through `encodeURIComponent(slug)`. The cluster count `${count}` at `:172` is an integer from the protobuf response, not escaped; backend Zod validates it as a number so injection is not feasible unless the protobuf decoder is subverted. Good.

### 4.5 `window.` / `document.` at module load (scope: components + hooks + utils)

Grep across `components`, `hooks`, `utils`: every `window.`/`document.` reference sits inside a function body, a React effect, or is wrapped in `typeof window !== 'undefined'` / `typeof document !== 'undefined'`. `ClusterMap.tsx:63` uses `typeof window !== 'undefined' && window.matchMedia(...)` in a `useRef` initialiser — runs once per mount, client-only after Leaflet lazy-import. No module-level DOM access. `utils/share-image.ts:38` guards on `typeof document === 'undefined'`. `utils/redeem-challenge-bar.ts` returns an IIFE-string — DOM access only happens when the emitted string runs inside a WebView.

### 4.6 External-link rel audit (plan G5-48)

`grep -rn 'target="_blank"'` in components returns 6 files. All 6 carry `rel="noopener noreferrer"`: `OrderPayoutCard.tsx:104`, `LoopPaymentStep.tsx:134`, `PendingPayoutsCard.tsx:135`, `ClusterMap.tsx:574,583`, `LoopOrdersList.tsx:127`. Good.

### 4.7 A11y spot checks (plan G4-18)

- **`components/ui/Button.tsx`** — `aria-busy` flips on `loading`; SVG spinner is `aria-hidden`. `min-h-[44px]` touch target ≥ 44 px. Focus ring present. Good.
- **`components/ui/Input.tsx`** — `aria-invalid`, `aria-describedby` wired through generated ids; `required` surfaced with `<span>*</span>` and native HTML `required` attribute. Good.
- **`components/ui/OfflineBanner.tsx`** — `role="alert"`. Good.
- **`components/ui/ToastContainer.tsx`** — error toasts use `role="alert"`, others `role="status"`. Good.
- **`components/features/NativeTabBar.tsx`** — `aria-label`, `aria-current="page"` on active tab. Good.
- **`components/features/Navbar.tsx`** — search combobox has `role="combobox"`, `aria-expanded`, `aria-haspopup="listbox"`, `aria-owns`, `aria-activedescendant`; dropdown buttons have `role="option"`, `aria-selected`. Good.
- **`components/features/admin/AdminNav.tsx`** — nav links have no explicit `aria-current` on active tab; status-pill has a static className but no `aria-label` describing the CTX health state. (A2-1157 low.)
- **`components/features/admin/CopyButton.tsx:33`** — `await navigator.clipboard.writeText(text)` with no `navigator.clipboard` existence check; older Safari / non-HTTPS contexts throw. No fallback to the `execCommand('copy')` trick (the redeem-challenge-bar IIFE does have one). (A2-1158 low.)
- **`components/features/admin/AdminAuditTail.tsx`** — refresh button not found; polling cadence unclear; table lacks `<caption>`. Low-impact.
- **`components/features/cashback/PendingPayoutsCard.tsx` / `OrderPayoutCard.tsx`** — state-pill carries `aria-label` including the state name at `OrderPayoutCard.tsx:127`; `PendingPayoutsCard` does not (only visible label). Minor.
- **`components/features/ClusterMap.tsx:352-358`** — `err.code === err.PERMISSION_DENIED` branch renders inline text via `setLocateError`; no `role="alert"` on the rendered `<p>` at `:585` (read below).

### 4.8 Dark-mode coverage

52 admin components + 8 feature roots + 9 ui + subdirs = ~101 `.tsx` files. `grep -c "dark:"` across components returns 896 variant utilities. Spot-check of every admin component (52 files) produces **zero** files that have colour classes without at least one corresponding `dark:` variant — the admin suite is fully paired. Cashback / home / onboarding / order / orders / purchase / wallet components likewise paired. UI primitives (Button / Input / PageHeader / Skeleton / Spinner / LazyImage / OfflineBanner / ToastContainer) all pair. Not a finding.

---

## 5. Utils — purity, import-time safety

| File                      | Purity at import                                                                                               | Notes                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `error-messages.ts`       | pure (module has `const STATUS_MESSAGES` + pure `friendlyError`)                                               | Covers only a subset of backend codes (§1.2).                                                        |
| `image.ts`                | pure; builds URLs                                                                                              | —                                                                                                    |
| `money.ts`                | pure; `Intl.NumberFormat` wrapped in try/catch                                                                 | —                                                                                                    |
| `redeem-challenge-bar.ts` | pure; emits a string to be executed inside a WebView                                                           | Challenge code is `JSON.stringify`-escaped before interpolation (line 24). Safe against injection.   |
| `security-headers.ts`     | pure; no `window`/`document`                                                                                   | Exists as a utility for Phase 8a's root; no consumers outside tests + root-level header computation. |
| `share-image.ts`          | `const WIDTH/HEIGHT` only at module load; `composeGiftCardShareImage` guards `typeof document === 'undefined'` | `loadImage` sets `crossOrigin='anonymous'` so `toDataURL` doesn't taint the canvas.                  |

No finding in utils.

---

## 6. Query-key taxonomy audit

### 6.1 Patterns observed (grep across `apps/web/app/{hooks,components,routes}` — 131 `queryKey:` occurrences, ≤-phase-8b filtered)

| Pattern                                | Examples                                                                                                                                                                          | Shape                                |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Flat hyphenated strings                | `['orders', …]`, `['merchants', …]`, `['merchant', id]`                                                                                                                           | `[<domain>, …args]`                  |
| Hierarchical `['me', '<resource>', …]` | `['me']`, `['me','credits']`, `['me','cashback-summary']`, `['me','orders','summary']`                                                                                            | tree by auth-scope                   |
| Mixed admin: `admin-<snake>` flat      | `['admin-users']`, `['admin-treasury']`, `['admin-payouts']`, `['admin-merchant-stats']`                                                                                          | no tree; group-invalidate impossible |
| Admin hierarchical outliers            | `['admin', 'cashback-monthly']` (`AdminMonthlyCashbackChart.tsx:41`, `TreasuryReconciliationChart.tsx:61`), `['admin', 'payouts-monthly']` (`TreasuryReconciliationChart.tsx:67`) | divergent shape for the same domain  |
| Public                                 | `['public-cashback-stats']`, `['public-flywheel-stats']`                                                                                                                          | flat                                 |
| Loop-native orders                     | `['loop-orders']`                                                                                                                                                                 | flat; **not** under `['me',…]`       |

Findings:

- **Group-invalidate sweep impossible for admin.** An operator performing a cross-resource mutation can only invalidate by flat key; `queryClient.invalidateQueries({ queryKey: ['admin'] })` won't match `['admin-users']` (different top-level token). `admin.cashback.tsx:122`, `admin.payouts*.tsx`, etc. all list invalidated keys individually; drift is inevitable. (A2-1155 medium.)
- **`['loop-orders']` not under `['me', …]`.** `['me', 'orders', 'summary']` exists (`OrdersSummaryHeader.tsx:24`) but `LoopOrdersList.tsx:20` uses flat `['loop-orders']`. After a successful `createLoopOrder` the client does not invalidate `['loop-orders']`, so the list stays at 30 s staleTime. No component invalidates. The user-observable effect: a just-purchased Loop-native order won't appear on `/orders` for up to 30 s unless they refocus the window. (A2-1159 medium.)
- **`['me', 'cashback-monthly']` clashes with admin's `['admin', 'cashback-monthly']`.** Not a bug, but an inconsistent taxonomy — admin elsewhere uses `admin-xxx` flat. Easy to mis-grep. (A2-1160 low.)

### 6.2 Missing cross-logout invalidation

After `useAuth.logout()` clears session, no call to `queryClient.clear()` or `queryClient.removeQueries`. Every `['me', …]` entry stays in cache for 5 min (default gcTime). On a shared device, user B signing in at the same browser tab will briefly see user A's balance / orders / pending-payouts on first render of any cached route. A2-1152.

---

## 7. SSR / hydration hazards (subset relevant to 8b scope)

- `stores/purchase.store.ts:147` — `loadPendingOrderSync()` executes at module import. Under SSR the `sessionStorage` read would throw `ReferenceError`; line 98-99 catch handles it silently. Store hydrates empty on SSR, then under client hydration the module re-evaluates and `restored` is consulted — React hydration mismatch unlikely because the persisted object is only merged into initial state (already synced with INITIAL_STATE). No finding.
- `stores/ui.store.ts:62` — `const initialPref = loadPreference()` runs at module import; under SSR returns `'system'` via fallback on `ReferenceError`; under client resolves from localStorage. Potential hydration-time mismatch between the first server-rendered `theme` class and the client store's `initialPref` once restored. The inline theme-resolve script in `root.tsx:218` runs before hydration and sets `html.dark` — mitigation present. However the store's `theme` field is also read at render time by `ToastContainer` / `Navbar`; a client that restores `'dark'` from localStorage but the SSR-rendered HTML already had `html.dark` applied (by the root script) stays consistent. No visible React warning, but the contract is load-bearing and undocumented in either store header. A2-1161 low.
- `hooks/use-session-restore.ts:34` — gated correctly on `typeof window !== 'undefined'`; boot work skipped on SSR.

---

## 8. Misc / low-severity observations

- `services/admin.ts` re-exports `LoopAssetCode` from `@loop/shared` (line 7) — deliberate to avoid every consumer learning the shared path. OK; ADR 019 notes this as a re-export pattern.
- `services/admin.ts` size: 1948 lines. No logical grouping beyond comment blocks. Search-and-modify risk is high for a single-file ~2k-line API client (A2-1165 low).
- `services/admin.ts` has a **duplicated** `AdminOrderState`-like union: `AdminOrderStateLocal` at `admin.ts:119-125` and `AdminOrderState` at `admin.ts:1147-1153`. Author comment acknowledges this at 114-118 ("NOTE: both declarations must agree. If you edit one, edit the other."). Drift risk manual-only. A2-1166 low.
- `ClusterMap.tsx` embeds inline `<style>` strings via Leaflet `divIcon`'s `html` prop; CSP allows inline styles (ADR-noted). Auditor confirmed no interpolated user input reaches a `style` attribute with concat.
- `services/config.ts :: API_BASE` falls back to hard-coded `'https://api.loopfinance.io'` in production if `VITE_API_URL` is unset (line 17). `services/clusters.ts:37` imports it — same base. `utils/image.ts:2` imports it — same base. No drift.
- No `ResetQueriesOnLogin` / `useQueryClient().clear()` sweep anywhere in `apps/web/app/{hooks,components,stores}`. See A2-1152.

---

## 9. Findings

Severity rubric per plan §3.4. IDs A2-1150..A2-1199 reserved for this phase; monotonic from A2-1150 as assigned.

### A2-1150 — Boot-time session restore wipes refresh token on transient failure

- **Severity:** High
- **Surface:** Phase 8b §1.3, §3.2
- **Files:** `apps/web/app/hooks/use-session-restore.ts:24-26`; compare with `apps/web/app/services/api-client.ts:163-178`
- **Evidence:** `doRefresh()` intentionally keeps the refresh token on disk when the failure is transient (5xx / 429 / network), clearing only on definitive 4xx-non-429 rejection. `getBootRestore` in `use-session-restore.ts:20-26`, however, calls `useAuthStore.getState().clearSession()` on _any_ `null` return, and `clearSession` in turn calls `clearRefreshToken()`, wiping the Keychain / sessionStorage entry. A cold boot under a brief backend / upstream blip therefore silently logs the user out and discards a still-valid refresh token.
- **Impact:** Users on flaky networks, or after any CTX / Loop backend incident during app launch, get forced back to the sign-in screen — even though their credentials were still valid when they booted.
- **Proposed remediation:** In `getBootRestore`, distinguish the transient-vs-definitive case (either re-throw a typed marker from `tryRefresh` / `doRefresh`, or only clear the in-memory `{ accessToken, email }` without invoking `clearRefreshToken`). Add a unit test covering 5xx + network-error + abort paths at boot.

### A2-1151 — `logout()` does not reset `purchase.store`

- **Severity:** High
- **Surface:** Phase 8b §2, G6-30
- **Files:** `apps/web/app/hooks/use-auth.ts:84-90`; `apps/web/app/stores/purchase.store.ts`
- **Evidence:** `grep -rn "usePurchaseStore.*reset" apps/web/app` returns only test files. `useAuth.logout` calls `store.clearSession()` (auth store) in a `finally`; nothing resets the purchase store. A user who logs out mid-`step='payment'` leaves `merchantId`, `paymentAddress`, `xlmAmount`, `orderId`, `memo` in memory (and partly in session storage via `savePendingOrder`). The next render of `PurchaseContainer` by another user (shared device / public kiosk / dev machine handed off) picks up the stale state.
- **Impact:** Cross-user state leak on shared devices; visibility of prior user's order id + Stellar memo. Pre-launch, not a live incident — but the audit flags it.
- **Proposed remediation:** In `useAuth.logout`'s `finally` block, call `usePurchaseStore.getState().reset()` alongside `store.clearSession()`. The `reset()` action already queues a `clearPending()` through the persist queue, so session storage is swept too.

### A2-1152 — `logout()` does not clear React Query cache

- **Severity:** High
- **Surface:** Phase 8b §2.1, §6.2, G6-30
- **Files:** `apps/web/app/hooks/use-auth.ts:84-90`
- **Evidence:** `grep -rn "queryClient\.clear\|queryClient\.resetQueries" apps/web/app` returns zero hits. Per-feature `invalidateQueries` calls exist (9 occurrences in routes + admin components) but none runs on logout. TanStack Query's default `gcTime` is 5 minutes, so cached `['me', …]`, `['admin-…']`, and `['order', id, 'payout']` responses remain in memory across a logout/login pair until garbage collection.
- **Impact:** User-B signing in on the same browser tab (or same mobile app session without kill-restart) sees cached fragments from user-A's session — lifetime cashback, orders list, pending-payout rows — until the first refetch completes. Privacy + correctness regression on shared devices.
- **Proposed remediation:** Extend `useAuth.logout` to call `queryClient.clear()` (or a targeted `removeQueries({ queryKey: ['me'] })` / `removeQueries({ queryKey: ['admin'] })` pair + similar sweeps for `['orders']`, `['order']`, `['loop-orders']`). Preferred: pass the `QueryClient` into the hook via a second argument so callers can test the sweep. Re-design query-key taxonomy (see A2-1155) to support a single root-level sweep.

### A2-1153 — Web never consumes backend error `code`s with UX intent

- **Severity:** High
- **Surface:** Phase 8b §1.2, plan G4-02
- **Files:** `apps/web/app/utils/error-messages.ts:13-18`; `apps/web/app/hooks/use-auth.ts:28-36`; plus consumers
- **Evidence:** Backend emits 17 distinct `code` values. Web UX translation layer (`friendlyError` + `authErrorMessage`) consults `err.status` and two client-synthesised codes (`TIMEOUT`, `NETWORK_ERROR`); no branch on `INSUFFICIENT_CREDIT`, `HOME_CURRENCY_LOCKED`, `INSUFFICIENT_BALANCE`, `WEBHOOK_NOT_CONFIGURED`, `UPSTREAM_REDIRECT`, `NOT_AN_IMAGE`, `IMAGE_TOO_LARGE`, `IDEMPOTENCY_KEY_REQUIRED`, `NOT_CONFIGURED`. Only `ClusterMap.tsx:137` switches on `err.code === 'TIMEOUT'`.
- **Impact:** Users who trip a code-carrying failure see the generic fallback ("Failed to create order. Please try again.") rather than the true cause. A `400 INSUFFICIENT_CREDIT` on Loop-native order creation reads as a retryable network error; a `409 HOME_CURRENCY_LOCKED` on the currency picker reads the same. Support tickets proliferate.
- **Proposed remediation:** (a) Add a `type ApiErrorCode = 'UNAUTHORIZED' | 'VALIDATION_ERROR' | … | 'TIMEOUT' | 'NETWORK_ERROR'` in `@loop/shared` (closed set, server + client pull from same file); (b) extend `friendlyError` (or introduce `codeMessages`) so every user-actionable code has a bespoke string; (c) consolidate `authErrorMessage` and `friendlyError` into one translator so `/auth` + `/onboarding` + purchase flows agree.

### A2-1154 — Two divergent error-translation layers (`friendlyError` vs `authErrorMessage`)

- **Severity:** Medium
- **Surface:** Phase 8b §1.2, §4.1
- **Files:** `apps/web/app/utils/error-messages.ts:13-18`; `apps/web/app/hooks/use-auth.ts:28-36`; `apps/web/app/components/features/onboarding/signup-tail.tsx:456,471`; `apps/web/app/routes/auth.tsx` (consumer of `useAuth`)
- **Evidence:** `authErrorMessage` covers 401/429/502/503 with hard-coded strings suited to OTP-verify ("Incorrect or expired code"). `friendlyError` covers 429/502/503/504 plus `TIMEOUT`/`NETWORK_ERROR` + offline detection. Onboarding uses `friendlyError`; `/auth` uses `authErrorMessage`. Same backend error therefore surfaces a different string on the two UX paths.
- **Impact:** Inconsistent UX copy; a user who starts at `/onboarding`, fails OTP, then retries via `/auth` sees "Invalid code. Please try again." vs "Incorrect or expired code." for the same backend response.
- **Proposed remediation:** Consolidate to a single translator with code- and status-aware mapping (tie-in with A2-1153 remediation). Delete `authErrorMessage`; call `friendlyError(err, '…')` everywhere.

### A2-1155 — Admin query-key taxonomy prevents group invalidation

- **Severity:** Medium
- **Surface:** Phase 8b §6.1
- **Files:** ~40 `useQuery` calls across `apps/web/app/components/features/admin/**` and `apps/web/app/routes/admin.*.tsx`
- **Evidence:** Admin queries predominantly use flat hyphenated keys (`['admin-users']`, `['admin-treasury']`, `['admin-payouts']`, `['admin-merchant-stats']`, …). Two outliers are hierarchical (`['admin','cashback-monthly']`, `['admin','payouts-monthly']`). TanStack Query's `invalidateQueries({ queryKey: ['admin'] })` with `exact: false` will match only the two outliers — not the 38 others.
- **Impact:** There is no single sweep that invalidates "everything admin". Operators writing a mutation that touches multiple admin surfaces (e.g. a cashback-config edit which affects config list + history + merchant stats) have to enumerate every downstream key manually; drift is inevitable as new admin cards land. Also blocks A2-1152's "clear on logout" remediation unless key taxonomy is fixed.
- **Proposed remediation:** Flip the taxonomy to hierarchical: `['admin', 'users']`, `['admin', 'users', userId]`, `['admin', 'users', userId, 'credits']`, `['admin', 'treasury']`, etc. Update the ~40 call sites in a single PR. Add a lint / test that grep-asserts every `queryKey` starting with the literal `'admin'` (array[0]) or the `'admin-'` string prefix is one of the allowed forms.

### A2-1156 — `['me', …]` queries fire before auth-restore completes

- **Severity:** Medium
- **Surface:** Phase 8b §3.1
- **Files:** 10 feature components enumerated in §3.1
- **Evidence:** Components in `features/cashback/` and `features/orders/` call `useQuery` without `enabled: isAuthenticated`. Parent routes are auth-gated but they _render_ the child (which calls `useQuery`) before the `useSessionRestore` side-effect flips `accessToken` non-null. The request hits `authenticatedRequest`, which calls `tryRefresh()`, which resolves the shared in-flight promise — defensively correct but wasteful.
- **Impact:** On cold boot every `['me', …]` query on the mounted route calls `tryRefresh` in parallel, each of which awaits the shared boot-restore promise; that's fine once but each triggers a 401-on-initial-then-retry dance if the component mounted before `useSessionRestore`'s `useState(true)` flipped. Also surfaces as a brief flash of `query.isPending` even for returning users whose token was live in storage.
- **Proposed remediation:** Thread `isAuthenticated` into each `['me', …]` query via `enabled: isAuthenticated`. Prefer a `useMeQuery` / `useAuthedQuery` factory so all 10 call sites agree.

### A2-1157 — `AdminNav` does not mark active tab with `aria-current`

- **Severity:** Low
- **Surface:** Phase 8b §4.7, G4-18
- **Files:** `apps/web/app/components/features/admin/AdminNav.tsx`
- **Evidence:** Tab `<Link>`s switch visual style on active location but no `aria-current="page"` on the active item. The CTX status pill uses classes keyed on `CtxStatus` but emits no text / `aria-label` when the visual colour is the only signal.
- **Impact:** Screen-reader operators can't tell which admin tab they're on; the CTX health pill is invisible to AT.
- **Proposed remediation:** Add `aria-current={isActive ? 'page' : undefined}` to each tab `<Link>`. Give the status pill an `aria-label={`CTX supplier pool: ${status}`}`.

### A2-1158 — `CopyButton` relies on `navigator.clipboard` without fallback

- **Severity:** Low
- **Surface:** Phase 8b §4.7
- **Files:** `apps/web/app/components/features/admin/CopyButton.tsx:33`
- **Evidence:** `await navigator.clipboard.writeText(text)` without a `typeof navigator.clipboard === 'undefined'` or feature-detection check; older Safari WebViews / non-secure contexts throw. Contrast with `utils/redeem-challenge-bar.ts:56-75` which has an `execCommand('copy')` fallback IIFE.
- **Impact:** Admin operators on misconfigured browsers / HTTP contexts see a silent failure when copying ids.
- **Proposed remediation:** Mirror the redeem-challenge-bar fallback: detect `navigator.clipboard`, fall back to a hidden `<textarea>` + `document.execCommand('copy')`. Share the logic with a new `utils/copy-to-clipboard.ts`.

### A2-1159 — New Loop-native orders don't refresh the orders list

- **Severity:** Medium
- **Surface:** Phase 8b §6.1
- **Files:** `apps/web/app/components/features/orders/LoopOrdersList.tsx:19-29`; `apps/web/app/components/features/purchase/LoopPaymentStep.tsx`; `apps/web/app/services/orders-loop.ts :: createLoopOrder`
- **Evidence:** `LoopOrdersList` uses `queryKey: ['loop-orders']` with 30 s `staleTime`. After `createLoopOrder` succeeds no one calls `queryClient.invalidateQueries({ queryKey: ['loop-orders'] })` (grep returns zero non-test matches).
- **Impact:** A user who completes a Loop-native purchase and navigates to `/orders` within 30 s doesn't see their order in the Loop-native section until focus-regain or a manual refresh. Low-severity UX regression but easy to fix.
- **Proposed remediation:** Add `queryClient.invalidateQueries({ queryKey: ['loop-orders'] })` to the `useMutation`/`createLoopOrder` success path in `PurchaseContainer` / `LoopPaymentStep`. Alternatively, rename the key to `['me', 'orders', 'loop']` and sweep along with the other `['me', …]` on logout (ties into A2-1155).

### A2-1160 — Query-key `['me', 'cashback-monthly']` vs `['admin', 'cashback-monthly']` clash

- **Severity:** Low
- **Surface:** Phase 8b §6.1
- **Files:** `apps/web/app/components/features/cashback/MonthlyCashbackChart.tsx:31`; `apps/web/app/components/features/admin/AdminMonthlyCashbackChart.tsx:41`; `apps/web/app/components/features/admin/TreasuryReconciliationChart.tsx:61,67`
- **Evidence:** User-scoped chart uses `['me', 'cashback-monthly']`; admin charts use `['admin', 'cashback-monthly']` — but the rest of admin uses flat `['admin-...']` keys. A grep for `cashback-monthly` returns 4 hits across two trees, easy to confuse.
- **Impact:** Cognitive load; future regex-based sweeps miss one. Minor.
- **Proposed remediation:** Re-taxonomy (see A2-1155) to unambiguous hierarchy.

### A2-1161 — Theme-preference SSR contract is undocumented and load-bearing

- **Severity:** Low
- **Surface:** Phase 8b §7
- **Files:** `apps/web/app/stores/ui.store.ts:44-62`; `apps/web/app/root.tsx:218` (the inline theme-resolve script is Phase 8a)
- **Evidence:** `loadPreference` is called at module import and under SSR returns `'system'` via the `ReferenceError` fallback; client-side the same call reads `localStorage['theme']`. The actual first-paint theme class on `<html>` is set by an inline script in `root.tsx` _before_ hydration; the store's `theme` field is re-resolved client-side. The contract ("root script sets `html.dark`; store mirrors after hydration via the `document.documentElement` class check in `toggleTheme`") is tribal-knowledge — no header comment in either file states it.
- **Impact:** Any refactor that moves the root inline script to a deferred load, or that changes the store's `loadPreference` to await, or a third consumer that reads the store at render time before the first effect fires, can regress the no-flash-of-wrong-theme behaviour.
- **Proposed remediation:** Add a cross-reference comment at the top of `ui.store.ts` noting that `root.tsx`'s inline script owns the first-paint class and that the store mirrors it; mirror the comment on `root.tsx`. Add a Playwright test asserting dark-to-light and light-to-dark don't flicker.

### A2-1162 — `clusters.ts` duplicates `api-client.ts`'s error-body normalisation

- **Severity:** Low
- **Surface:** Phase 8b §1.3
- **Files:** `apps/web/app/services/clusters.ts:51-82` vs `apps/web/app/services/api-client.ts:69-98`
- **Evidence:** Byte-for-byte parallel body-parsing branches. Author comment at `clusters.ts:54-56` acknowledges the duplication ("Mirrors the logic in api-client.ts (PR #36)").
- **Impact:** A fix applied to one doesn't automatically apply to the other.
- **Proposed remediation:** Extract `parseApiErrorBody(response: Response): Promise<ApiError>` into a shared helper; call from both sites.

### A2-1163 — Admin write envelope `audit.replayed` is never surfaced to operators

- **Severity:** Low
- **Surface:** Phase 8b §1.3
- **Files:** `apps/web/app/services/admin.ts:1110-1120`; consumers of `retryPayout` (`admin.payouts.$id.tsx`), `applyCreditAdjustment` (`CreditAdjustmentForm.tsx`)
- **Evidence:** ADR 017 wraps every admin mutation in `{ result, audit: { …, replayed: boolean } }`. The web client exposes the type (`AdminWriteAudit`) but no component reads `.audit.replayed`. An operator double-clicking a retry button, or refreshing mid-success, therefore can't tell a real retry from a replay of a cached idempotent response.
- **Impact:** Operator confusion on long-running retries. No financial impact.
- **Proposed remediation:** Surface a subtle "replayed" hint in the retry confirmation toast / CreditAdjustmentForm success banner when `audit.replayed === true`.

### A2-1164 — `hooks/index.ts` barrel is incomplete; consumers split between barrel and direct imports

- **Severity:** Low
- **Surface:** Phase 8b §3.3
- **Files:** `apps/web/app/hooks/index.ts`
- **Evidence:** Barrel exports 5 of the 7 actual hook entry points. `useAppConfig`, `shouldRetry`, `useMerchantCashbackRate`, `useMerchantsCashbackRatesMap` are only available via direct file import. Callers therefore split ~50/50 across `from '~/hooks'` vs `from '~/hooks/use-merchants'` / `from '~/hooks/query-retry'` / `from '~/hooks/use-app-config'`.
- **Impact:** Slightly higher cognitive load; minor.
- **Proposed remediation:** Either (a) add the missing exports to the barrel and standardise; (b) delete the barrel and use direct imports everywhere.

### A2-1165 — `services/admin.ts` is 1948 lines and growing

- **Severity:** Low
- **Surface:** Phase 8b §8
- **Files:** `apps/web/app/services/admin.ts`
- **Evidence:** Single file contains 90+ functions, 50+ interfaces, and comments-only section headers. `wc -l` = 1948. No enforced logical grouping; additions land wherever the author opened the file.
- **Impact:** Merge conflicts on concurrent admin work; harder to audit ("which of the 90 functions did that PR touch?"); slow editor tooling on some machines.
- **Proposed remediation:** Split into `services/admin/{payouts,treasury,orders,merchants,users,operators,assets,audit,discord,csv}.ts` mirroring the admin-route carve-up. Re-export from a barrel `services/admin/index.ts` so existing `import … from '~/services/admin'` callers keep compiling.

### A2-1166 — `AdminOrderStateLocal` + `AdminOrderState` duplicated in `services/admin.ts`

- **Severity:** Low
- **Surface:** Phase 8b §8
- **Files:** `apps/web/app/services/admin.ts:119-125` vs `apps/web/app/services/admin.ts:1147-1153`
- **Evidence:** Same union literal declared twice. Author comment at 114-118 acknowledges and enjoins future authors to "edit both".
- **Impact:** Drift risk.
- **Proposed remediation:** Collapse to a single declaration near top of file; remove the "NOTE: both declarations must agree" comment.

---

## 10. Summary

**Findings filed:** 17 (IDs A2-1150 — A2-1166).

| Severity | Count | IDs                                                                             |
| -------- | ----- | ------------------------------------------------------------------------------- |
| Critical | 0     | —                                                                               |
| High     | 4     | A2-1150, A2-1151, A2-1152, A2-1153                                              |
| Medium   | 4     | A2-1154, A2-1155, A2-1156, A2-1159                                              |
| Low      | 9     | A2-1157, A2-1158, A2-1160, A2-1161, A2-1162, A2-1163, A2-1164, A2-1165, A2-1166 |

No Critical findings — pre-launch context, no live customer data. Blockers for Phase 8b exit: none. Evidence captured against commit SHA above; remediation is post-audit per plan §3.4.
