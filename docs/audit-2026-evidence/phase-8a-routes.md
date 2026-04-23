# Phase 8a — Web routes + native + root (evidence)

**Commit SHA at capture:** `450011ded294b638703a9ba59f4274a3ca5b7187`
**Date captured:** 2026-04-23
**Auditor:** cold-reviewer (Phase 8a)
**Scope:** `apps/web/app/root.tsx`, `apps/web/app/routes.ts`, `apps/web/app/routes/**` (35 route files), `apps/web/app/native/**` (16 wrappers + `__tests__/`), `apps/web/public/`, `apps/web/app/app.css`. Out of scope: `components/`, `hooks/`, `services/`, `stores/`, `utils/` (Phase 8b).

Primary evidence: direct file reads with line numbers, grep across the routes/, root, native/, public/ trees. No source modified.

Scope discrepancy: `apps/web/app/native/` contains **16** files, not the 5 named in the phase briefing (app-lock, clipboard, haptics, secure-storage, platform). All 16 were audited; the extras are: `back-button.ts`, `biometrics.ts`, `keyboard.ts`, `network.ts`, `notifications.ts`, `purchase-storage.ts`, `screenshot-guard.ts`, `share.ts`, `status-bar.ts`, `webview.ts`. `apps/web/public/` does **not** contain a `manifest.json` (PWA) — see A2-1106. `public/sitemap.xml` is absent as a static asset; the `/sitemap.xml` URL is served by a resource route (`routes/sitemap.tsx`) that exports `loader`.

---

## 1. Route registry (`routes.ts`)

35 `.tsx` files in `routes/` (excluding `__tests__/`), 34 entries in `routes.ts` plus the splat `*` → `routes/not-found.tsx`. `routes/sitemap.tsx` is conditionally registered only when `BUILD_TARGET !== 'mobile'` (`routes.ts:7-8`) — static export drops it, as intended for Capacitor bundle. Index route = `home.tsx`. No duplicate paths. No nested layout routes.

---

## 2. Route matrix

Columns: **auth** — public / authed / admin-gate-local / admin-only-server; **loader** — yes/no with type (`async loader` returning Response, or none); **static-safe** — build passes with `BUILD_TARGET=mobile` (inferred — no SSR data fetch, no module-level window); **dark** — dark-mode classes present (`dark:` variants); **empty** / **error** / **loading** state present; **a11y** — at least one aria-label, role, or accessible label on interactive elements.

| #   | Path                           | File                              | auth                     | loader  | static-safe | dark | empty | error      | loading | a11y                                                                                  | Notes                                                                                     |
| --- | ------------------------------ | --------------------------------- | ------------------------ | ------- | ----------- | ---- | ----- | ---------- | ------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | `/`                            | `home.tsx`                        | public                   | none    | yes         | yes  | n/a   | impl.      | skel.   | ok                                                                                    | `MerchantCardSkeleton` for loading; `isError` observed L29; no OG/Twitter meta (A2-1112). |
| 2   | `/map`                         | `map.tsx`                         | public                   | none    | yes         | yes  | n/a   | ErrBd      | Spinner | ok                                                                                    | Lazy Leaflet via `Suspense`; has `ErrorBoundary`; browser-only code gated client-side.    |
| 3   | `/gift-card/:name`             | `gift-card.$name.tsx`             | mixed (authed=extra)     | none    | yes         | yes  | yes   | ErrBd      | Spinner | ok                                                                                    | `decodeURIComponent` try/catch hardens meta against `/gift-card/%ZZ` (L18-22).            |
| 4   | `/cashback`                    | `cashback.tsx`                    | public                   | none    | yes         | yes  | yes   | impl.      | Spinner | ok                                                                                    | Hits `/api/public/top-cashback-merchants` client-side.                                    |
| 5   | `/cashback/:slug`              | `cashback.$slug.tsx`              | public                   | none    | yes         | yes  | yes   | ErrBd      | Spinner | ok                                                                                    | Canonical meta emitted.                                                                   |
| 6   | `/calculator`                  | `calculator.tsx`                  | public                   | none    | yes         | yes  | yes   | impl.      | Spinner | ok                                                                                    | Canonical meta emitted.                                                                   |
| 7   | `/trustlines`                  | `trustlines.tsx`                  | public                   | none    | yes         | yes  | n/a   | impl.      | Spinner | ok                                                                                    | All external links carry `rel="noopener noreferrer"` (L118, 129, 169).                    |
| 8   | `/privacy`                     | `privacy.tsx`                     | public                   | none    | yes         | yes  | n/a   | n/a        | n/a     | ok                                                                                    | Canonical. Placeholder copy flagged pending legal (A2-1119 low).                          |
| 9   | `/terms`                       | `terms.tsx`                       | public                   | none    | yes         | yes  | n/a   | n/a        | n/a     | ok                                                                                    | Canonical. Placeholder copy (A2-1119 low).                                                |
| 10  | `/sitemap.xml`                 | `sitemap.tsx`                     | public                   | **yes** | excluded\*  | n/a  | n/a   | fails-open | n/a     | \*Skipped at `BUILD_TARGET=mobile` build; SSR server-side fetch documented in header. |
| 11  | `/auth`                        | `auth.tsx`                        | public/authed dual       | none    | yes         | yes  | yes   | ErrBd      | impl.   | partial                                                                               | **A2-1100**: no `autoComplete` on email/OTP (Input passes props but route omits).         |
| 12  | `/onboarding`                  | `onboarding.tsx`                  | public                   | none    | yes         | yes  | n/a   | n/a        | n/a     | n/a                                                                                   | Mount only; state lives in component.                                                     |
| 13  | `/orders`                      | `orders.tsx`                      | authed                   | none    | yes         | yes  | yes   | impl.      | Spinner | ok                                                                                    | `!isAuthenticated` branch with sign-in CTA L260.                                          |
| 14  | `/orders/:id`                  | `orders.$id.tsx`                  | authed                   | none    | yes         | yes  | n/a   | impl.      | Spinner | ok                                                                                    | `errText` maps 401 → "Please sign in" (L76-78).                                           |
| 15  | `/settings/wallet`             | `settings.wallet.tsx`             | authed                   | none    | yes         | yes  | impl. | impl.      | Spinner | ok                                                                                    | Has `autoComplete="off"` on Stellar-addr input (L292).                                    |
| 16  | `/settings/cashback`           | `settings.cashback.tsx`           | authed                   | none    | yes         | yes  | impl. | impl.      | impl.   | ok                                                                                    | —                                                                                         |
| 17  | `/admin`                       | `admin._index.tsx`                | **authed (see A2-1101)** | none    | yes         | yes  | yes   | 401→msg    | Spinner | ok                                                                                    | Surfaces "Admin access required" on 401/404 ApiException (L205-210).                      |
| 18  | `/admin/cashback`              | `admin.cashback.tsx`              | authed                   | none    | yes         | yes  | impl. | impl.      | Spinner | ok                                                                                    | Comment L45-46: "frontend does not gate on is_admin locally".                             |
| 19  | `/admin/treasury`              | `admin.treasury.tsx`              | authed                   | none    | yes         | yes  | impl. | impl.      | Spinner | ok                                                                                    | —                                                                                         |
| 20  | `/admin/payouts`               | `admin.payouts.tsx`               | authed                   | none    | yes         | yes  | impl. | impl.      | Spinner | ok                                                                                    | `window.prompt` used for retry reason (L113) — A2-1107.                                   |
| 21  | `/admin/payouts/:id`           | `admin.payouts.$id.tsx`           | authed                   | none    | yes         | yes  | impl. | impl.      | Spinner | ok                                                                                    | `window.prompt` for retry reason (L99) — A2-1107.                                         |
| 22  | `/admin/orders`                | `admin.orders.tsx`                | authed                   | none    | yes         | yes  | impl. | impl.      | Spinner | ok                                                                                    | —                                                                                         |
| 23  | `/admin/orders/:orderId`       | `admin.orders.$orderId.tsx`       | authed                   | none    | yes         | yes  | impl. | impl.      | Spinner | ok                                                                                    | —                                                                                         |
| 24  | `/admin/stuck-orders`          | `admin.stuck-orders.tsx`          | authed                   | none    | yes         | yes  | impl. | impl.      | Spinner | ok                                                                                    | —                                                                                         |
| 25  | `/admin/merchants`             | `admin.merchants.tsx`             | authed                   | none    | yes         | yes  | impl. | impl.      | Spinner | ok                                                                                    | —                                                                                         |
| 26  | `/admin/merchants/:merchantId` | `admin.merchants.$merchantId.tsx` | authed                   | none    | yes         | yes  | impl. | impl.      | Spinner | ok                                                                                    | External link at L145-146 has `rel="noopener noreferrer"`.                                |
| 27  | `/admin/users`                 | `admin.users.tsx`                 | authed                   | none    | yes         | yes  | impl. | impl.      | Spinner | ok                                                                                    | `aria-label` on search inputs (L163, 194); pagination nav has `aria-label` (L281).        |
| 28  | `/admin/users/:userId`         | `admin.users.$userId.tsx`         | authed                   | none    | yes         | yes  | impl. | impl.      | Spinner | ok                                                                                    | —                                                                                         |
| 29  | `/admin/operators`             | `admin.operators.tsx`             | authed                   | none    | yes         | yes  | impl. | impl.      | Spinner | ok                                                                                    | —                                                                                         |
| 30  | `/admin/operators/:operatorId` | `admin.operators.$operatorId.tsx` | authed                   | none    | yes         | yes  | impl. | impl.      | Spinner | ok                                                                                    | —                                                                                         |
| 31  | `/admin/assets`                | `admin.assets.tsx`                | authed                   | none    | yes         | yes  | impl. | impl.      | Spinner | ok                                                                                    | —                                                                                         |
| 32  | `/admin/assets/:assetCode`     | `admin.assets.$assetCode.tsx`     | authed                   | none    | yes         | yes  | impl. | impl.      | Spinner | ok                                                                                    | External link at L242-249 has `rel="noreferrer noopener"`.                                |
| 33  | `/admin/audit`                 | `admin.audit.tsx`                 | authed                   | none    | yes         | yes  | impl. | impl.      | Spinner | ok                                                                                    | —                                                                                         |
| 34  | `*` → 404                      | `not-found.tsx`                   | public                   | none    | yes         | yes  | n/a   | n/a        | n/a     | ok                                                                                    | Simple `<Button onClick navigate('/')>` — G4-16 catch-all.                                |

**Totals:** 34 routes routed + `ErrorBoundary` in `root.tsx` catches any uncaught. 8 routes implement a route-local `ErrorBoundary` (home, map, cashback.$slug, auth, gift-card.$name, orders, orders.$id, and the inherited root). 1 resource route (`sitemap.xml`) with a `loader` — no component.

---

## 3. Loader-purity check (plan §2 rule #1 + §Phase 8)

Grep `export (async )?function (loader|clientLoader|action)|export const (loader|clientLoader|action)` across `apps/web/app/routes/**`:

```
apps/web/app/routes/sitemap.tsx:71:export async function loader(): Promise<Response>
```

Only `sitemap.tsx` ships a `loader`. It is:

- a **resource route** (returns `Response`, no React component export),
- conditionally registered only when `BUILD_TARGET !== 'mobile'` (`routes.ts:7`),
- self-documented as a deliberate exception to the pure-API-client rule (`sitemap.tsx:14-18`).

The `loader` fetches `/api/public/top-cashback-merchants` server-side but **fails open** — on any fetch error it still emits a valid sitemap with the static routes (`sitemap.tsx:72-98`). No server-side data fetch leaks into a hydrated page.

All 34 other routes rely on TanStack Query `enabled:` gates plus client-only `useQuery` — the "web is a pure API client" rule holds.

`root.tsx` has no loader. It performs module-top-level `window`/`localStorage` reads for the merchants cache seed (L75-121) guarded by `typeof window !== 'undefined'` — SSR-safe.

**Finding:** none on loader purity (clean).

---

## 4. Capacitor isolation (rule #3)

Grep `@capacitor/` across `apps/web/app`:

```
apps/web/app/root.tsx
apps/web/app/native/*.ts   (all 16 wrappers)
apps/web/app/native/__tests__/*.ts
```

The single match outside `native/` is `apps/web/app/root.tsx` — but that file does **not** import `@capacitor/*` directly; the grep hit is a comment reference to a wrapper (`audit A-005 — Capacitor boundary compliance`, L309). The actual imports in `root.tsx` all come from `~/native/*`. **Rule #3 holds: zero `@capacitor/*` imports in `routes/`.**

`apps/web/app/routes/` matches: 0 (audit clean).

---

## 5. SSR vs static-export safety

Grep `window.|document.|localStorage|sessionStorage` across `apps/web/app/routes`:

| File                    | Line | Context                                            | SSR-safe?                                                 |
| ----------------------- | ---- | -------------------------------------------------- | --------------------------------------------------------- |
| `orders.$id.tsx`        | L98  | `if (window.history.length > 1) void navigate(-1)` | Inside button handler — client-only path.                 |
| `gift-card.$name.tsx`   | L68  | `if (window.history.length > 1) { ... }`           | Inside button handler — client-only path.                 |
| `admin.payouts.tsx`     | L113 | `window.prompt(...)`                               | Click handler — client-only. UX issue (A2-1107), not SSR. |
| `admin.payouts.$id.tsx` | L99  | `window.prompt(...)`                               | Click handler — client-only. UX issue (A2-1107), not SSR. |

No module-top-level `window.` / `document.` reads in any route. All are inside callbacks or effects. `root.tsx` has two module-top-level guarded reads (`typeof window !== 'undefined'`) for theme seeding and merchants cache — both gated.

---

## 6. Native-wrapper matrix (16 files)

Columns: **plugin** — concrete `@capacitor/*` or third-party dep dynamic-imported; **web-fallback** — behaviour when `!isNativePlatform()`; **lazy** — dynamic `import()` used (avoids pulling plugin into web bundle); **cleanup** — disposer exported / awaited properly.

| File                                      | plugin                                                                   | web-fallback                                        | lazy | cleanup              | Notes                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------- | ---- | -------------------- | ------------------------------------------------------------------------------------------------ |
| `platform.ts`                             | `@capacitor/core` (static)                                               | returns `'web'` / `false`                           | no   | n/a                  | Only static-imports `Capacitor` from core — thin shim.                                           |
| `app-lock.ts`                             | `@capacitor/preferences`, `./biometrics`                                 | early-return `false` / `() => {}`                   | yes  | disposer             | `cancelled` flag + overlay cleanup (L164-166).                                                   |
| `back-button.ts`                          | `@capacitor/app`                                                         | returns `() => {}`                                  | yes  | disposer             | Race-safe disposer — `disposed` flag tears down mid-flight listener (L29-34).                    |
| `biometrics.ts`                           | `@aparajita/capacitor-biometric-auth`                                    | `{available:false,biometryType:'none'}`             | yes  | n/a                  | Swallows errors.                                                                                 |
| `clipboard.ts`                            | `@capacitor/clipboard`                                                   | `navigator.clipboard.writeText/readText`            | yes  | n/a                  | Two-path native/web; `readClipboard` returns `null` on failure.                                  |
| `haptics.ts`                              | `@capacitor/haptics`                                                     | no-op                                               | yes  | n/a                  | —                                                                                                |
| `keyboard.ts`                             | `@capacitor/keyboard`                                                    | no-op (iOS-only, early-return on android/web)       | yes  | n/a                  | iOS-gated.                                                                                       |
| `network.ts`                              | `@capacitor/network`                                                     | `window.addEventListener('online'/'offline')`       | yes  | unsub                | Cancellation flag guards async setup (L11-34).                                                   |
| `notifications.ts`                        | `@capacitor/push-notifications`                                          | early-return (Android-only)                         | yes  | n/a                  | —                                                                                                |
| `purchase-storage.ts`                     | `@capacitor/preferences`                                                 | `sessionStorage`                                    | yes  | n/a                  | 15-min default TTL; migrates silently.                                                           |
| `screenshot-guard.ts`                     | none (`document.pause/resume` events)                                    | `() => {}`                                          | n/a  | disposer             | Overlay cleanup guards repeat-pause (L18-19).                                                    |
| `secure-storage.ts`                       | `@aparajita/capacitor-secure-storage`, `@capacitor/preferences` (legacy) | `sessionStorage`                                    | yes  | n/a                  | One-shot migration sweep (A-024). Preserves ADR-006.                                             |
| `share.ts`                                | `@capacitor/share`, `@capacitor/filesystem`                              | `navigator.share({files})` → text fallback          | yes  | n/a                  | ADR 008 implementation — matches spec (Directory.Cache for PNG).                                 |
| `status-bar.ts`                           | `@capacitor/status-bar`                                                  | no-op                                               | yes  | n/a                  | —                                                                                                |
| `webview.ts`                              | `@capgo/inappbrowser`                                                    | `window.open(url, '_blank', 'noopener,noreferrer')` | yes  | `close()` controller | URL scheme validation (`http`/`https`), rejects embedded creds, enforces https in prod (L23-46). |
| `__tests__/native-modules.test.ts`        | —                                                                        | —                                                   | —    | —                    | 77 describe/it blocks against the stack.                                                         |
| `__tests__/secure-storage-native.test.ts` | —                                                                        | —                                                   | —    | —                    | 13 describe/it blocks.                                                                           |

All 16 `native/*` files: each `@capacitor/*` / third-party plugin import is either `await import(...)` inside a function (lazy, web-safe) or limited to `@capacitor/core`'s static-safe `Capacitor` helpers. No violation of rule #3.

---

## 7. `public/` assets, `robots.txt`, manifest, sitemap

```
apps/web/public/
  hero.webp
  leaflet/marker-icon.png, marker-icon-2x.png, marker-shadow.png
  loop-favicon.ico, loop-favicon.png, loop-favicon.svg
  loop-logo.svg, loop-logo-white.svg, loop-logo-square.png, loop-logo.png
  robots.txt
```

**`robots.txt`** (full file):

```
User-agent: *
Allow: /

Sitemap: https://loopfinance.io/sitemap.xml
```

No admin paths disallowed (A2-1105). No `manifest.json` present (A2-1106). No static `sitemap.xml` (served dynamically via `routes/sitemap.tsx`). All public assets referenced in routes (`loop-logo.svg`, `loop-logo-white.svg`, `loop-favicon.*`, `hero.webp`, leaflet markers) are actually used.

---

## 8. `app.css` purge / dead-class review

- 432 lines total, `@import 'tailwindcss';` at top.
- `@custom-variant dark (&:where(.dark, .dark *));` per class-based Tailwind v4 variant.
- Prior `theme-icon-sun` / `theme-icon-moon` classes already dropped (commit `02870ed`, verified grep: no matches).
- Hand-rolled selectors present: `html.native body::before` (status-bar backdrop), `.hero-shape-fill`, `.route-enter`, `.native-safe-page`, `.native-tab-clearance`, `.native-full-bleed`, `.native-auth-screen`.
- Each hand-rolled class grepped: all referenced in `root.tsx`, `routes/map.tsx`, or `routes/auth.tsx`. No dead hand-rolled classes found.
- No leftover classes referencing removed features.

---

## 9. `root.tsx` walkthrough

- `meta()` L123-128: single generic title + description. No OG/Twitter meta (A2-1112). No `link rel="canonical"` (per-route concern).
- `links()` L134-143: preconnect + Google Fonts (Inter). **`hero.webp` is not preloaded** — used as `background-image` on `/` hero at L79, so LCP-eligible but not preloaded (A2-1113, G5-53).
- Module-level `Sentry.init()` guarded by `typeof window !== 'undefined'` (L38-45) — SSR-safe. `tracesSampleRate: PROD ? 0.1 : 1.0`.
- Module-level merchants cache seed (L75-121): `try/catch` guards around `localStorage.getItem`, `JSON.parse`, `localStorage.setItem`. Malformed / corrupt entries are swallowed. TTL 24h. SSR-safe.
- `Layout`: inline theme script `dangerouslySetInnerHTML` (L218) — static string, no user data interpolated; CSP meta tag emitted with `frame-ancestors`/`report-uri`/`sandbox` stripped (browsers would warn on meta-delivered values). Document comment acknowledges these must be delivered via HTTP header at edge (A2-1104, G5-40 — edge config is out of this phase's repo scope but the web tree emits CSP + declines to guarantee edge).
- `NativeShell` (L234-384): wires `registerBackButton`, `registerAppLockGuard`, `setKeyboardAccessoryBarVisible`, `setupNotificationChannels`, `MutationObserver` on `<html class>` for theme sync. All disposers cleaned up in effect-return.
- `ErrorBoundary` (L461-496): Sentry-keyed to `[error]` to prevent dup capture on re-render. Renders `error.statusText` and, in DEV, `error.stack`. **In prod non-DEV `error.message` is never shown** — only `statusText` for `isRouteErrorResponse` paths. Non-Route Error with a meaningful message is swallowed to "An unexpected error occurred." (A2-1114 Info — UX completeness).

---

## 10. Findings

Severity per plan §3.4. IDs A2-1100..A2-1149 (50 slots allocated; 20 used).

### A2-1100 — Sign-in form missing `autoComplete` on email/OTP inputs (G5-54)

- **Severity:** Medium.
- **File:** `apps/web/app/routes/auth.tsx:540-572`.
- **Evidence:** email `<Input type="email" ... />` at L540-547 and OTP `<Input type="text" inputMode="numeric" ... />` at L561-572 omit `autoComplete`. The `Input` component spreads `...props` to `<input>` (`apps/web/app/components/ui/Input.tsx:97`), so the wrapper would accept the prop — the route simply doesn't pass it. `apps/web/app/components/features/onboarding/signup-tail.tsx:75` (email) and L277 (OTP) do set `autoComplete="email"` and `autoComplete="one-time-code"` — so the onboarding flow is correct and only the marketing-site `/auth` route is missing it.
- **Impact:** Password managers / iOS Safari SMS-code autofill won't suggest the user's email or the one-time code, increasing sign-in friction on the web marketing route.
- **Remediation:** Add `autoComplete="email"` to the email input and `autoComplete="one-time-code"` to the OTP input in `auth.tsx`.

### A2-1101 — Admin UI shell rendered to any authenticated user

- **Severity:** Medium (UX / information disclosure; NOT a privilege escalation).
- **Files:** every `apps/web/app/routes/admin.*.tsx` — the auth gate pattern is `const { isAuthenticated } = useAuth(); if (!isAuthenticated) return <SignInCTA/>;`. Example: `admin.users.tsx:41, 111`. Backend handlers are `requireAdmin`-gated (Phase 5a/b evidence confirms); the client reveals the admin layout chrome, nav tabs, and page headings before the data fetches 401/403.
- **Evidence:** `admin.cashback.tsx:45-46` comment acknowledges: _"frontend does not gate on is_admin locally — it's not the source of truth (see `requireAdmin` in the backend)."_ `admin._index.tsx:189-211` surfaces a user-friendly "Admin access required" banner on 401/403. The other admin subpages (`admin.merchants.tsx`, `admin.users.tsx`, `admin.audit.tsx`, `admin.operators.tsx`, etc.) render the full `<AdminNav/>` layout + page `<header>` before the 401 comes back, briefly exposing admin page titles + card structure to non-admin signed-in users during the request flight.
- **Impact:** Minor information disclosure (attacker learns admin surface names + nav structure). No data leak — the server 401/403 fires on the list/detail fetch. Distinct from G5-71 (privilege escalation — which this is not).
- **Remediation:** Either (a) read `isAdmin` from the user store and render `AdminAccessRequired` before `<AdminNav/>` on all admin.\* routes (not just admin.\_index), or (b) accept this is UX polish and the server remains the source of truth. Note that `UserMeView` already carries `isAdmin` (Phase 5b evidence); a client-side gate is a one-line add.

### A2-1102 — No route-level admin role gate ⇒ admin nav flashes on non-admin users (G4-18)

- **Severity:** Low.
- **Files:** `apps/web/app/components/features/admin/AdminNav.tsx` (rendered by every admin page). Related to A2-1101.
- **Evidence:** grep shows zero `isAdmin` / `is_admin` checks inside `routes/admin.*.tsx` beyond two _display_ references (`admin.users.tsx:260`, `admin.users.$userId.tsx:146`) for rendering an admin badge on other users. The route itself never branches on `me.isAdmin`.
- **Impact:** On an admin-user-who-signed-out-then-landed-on-`/admin`, the nav chrome flashes before the redirect. On a non-admin user typing `/admin` into the bar, the nav+header render for the duration of the first API call.
- **Remediation:** Same as A2-1101.

### A2-1103 — No route-level 403 ("forbidden") page / taxonomy (G4-16)

- **Severity:** Low.
- **Files:** `apps/web/app/root.tsx:474-483` `ErrorBoundary`; `apps/web/app/routes/not-found.tsx`.
- **Evidence:** `ErrorBoundary` branches on `status === 404` vs other. There's no explicit 403 render — a `throw redirect('/auth')` pattern is not used anywhere (grep for `redirect(` in routes = no matches for `react-router` `redirect`). Any 403 from a fetch inside a component surfaces as a generic "Error" banner via route-local error branches (e.g. `admin._index.tsx:189-211`), not a dedicated 403 page.
- **Impact:** Split UX — 404 has a dedicated page, 403 varies per route.
- **Remediation:** Add a 403-specific branch in `root.tsx ErrorBoundary` mapping `error.status === 403` to a "you don't have access" template; or a per-admin-route `<AccessDenied/>` component.

### A2-1104 — CSP meta drops `frame-ancestors`/`report-uri`/`sandbox`; edge-header parity is doc-only

- **Severity:** Low.
- **File:** `apps/web/app/root.tsx:190-200`.
- **Evidence:** The `Layout` strips `frame-ancestors`, `report-uri`, `sandbox` from the meta-emitted CSP (correct — browsers ignore these in meta). Comment L183-189 notes these are "applied at the deploy edge — Fly.io's `force_https=true` already delivers HSTS-equivalent" and that `X-Frame-Options: DENY` must come from the edge. There is no in-repo assertion that the edge actually delivers these — no fly.toml header block, no Dockerfile `nginx` config for them.
- **Impact:** Clickjacking defense depends on an edge config that's not evidenced in this phase's scope. Defer to Phase 12 (security) + Phase 4 (build/release) for the actual HTTP-header edge behaviour.
- **Remediation:** None in this phase — flag for cross-reference in Phase 12 §HSTS / secure-headers middleware scope.

### A2-1105 — `robots.txt` lacks explicit admin disallow (G5-45)

- **Severity:** Low.
- **File:** `apps/web/public/robots.txt`.
- **Evidence:** Contents are `User-agent: *\nAllow: /\n\nSitemap: https://loopfinance.io/sitemap.xml\n`. No `Disallow: /admin`, `Disallow: /auth`, `Disallow: /orders`, `Disallow: /settings`. The admin routes return HTML shells that would be crawled (and 401/403 on API calls is post-render, so the HTML of the shell is still cacheable by Googlebot if it followed a link).
- **Impact:** Admin page titles (e.g. "Admin · Users — Loop") could be indexed. There is no inbound link to `/admin` from any public route grep-checked, so practical exposure is low. Per plan G5-45 intent this is explicit "admin paths disallowed" — not present.
- **Remediation:** Add `Disallow: /admin`, `Disallow: /admin/*`, `Disallow: /settings`, `Disallow: /orders` to `robots.txt`. (Note: `sitemap.tsx` does not include admin URLs, so this is additive hardening.)

### A2-1106 — `manifest.json` (PWA) absent (G5-47)

- **Severity:** Low.
- **File:** `apps/web/public/` — no `manifest.json`.
- **Evidence:** `ls apps/web/public/` shows no `manifest.json` / `site.webmanifest`. `root.tsx links()` does not emit `<link rel="manifest">`. The app is a Capacitor shell on native, but the loopfinance.io SEO surface still benefits from a web-app manifest for "Add to home screen" on mobile Safari/Chrome (the same visitors who land on `/cashback`).
- **Impact:** No installable web-app experience. iOS/Android Safari can't add a proper Loop icon to the home screen.
- **Remediation:** Ship `public/manifest.json` with name/short_name/icons/start_url/theme_color/background_color/display=standalone, and add `<link rel="manifest" href="/manifest.json" />` to `root.tsx links()`.

### A2-1107 — `window.prompt` used for admin-action reason capture

- **Severity:** Low (UX + a11y).
- **Files:** `apps/web/app/routes/admin.payouts.tsx:113`, `admin.payouts.$id.tsx:99`.
- **Evidence:** Both retry-payout actions collect the "Reason" via `window.prompt('Reason for retrying this payout? (2–500 chars, logged in audit)')`.
- **Impact:** `window.prompt` is not styleable, not screen-reader-consistent, and on native Capacitor may trigger the system UI's "This page says:" chrome, which users rarely trust. Because the reason is then "logged in audit" (ADR 017), the UX channel for an ops-critical input matters.
- **Remediation:** Replace with a modal that reuses the existing `~/components/ui/Modal` or equivalent, matching the keyboard-navigable ops surface G4-18 raises.

### A2-1108 — Per-route Open Graph / Twitter meta absent (G5-52)

- **Severity:** Low.
- **Files:** every `routes/*.tsx` `meta()` export. Grep `property=.?og:|name=.?twitter:` across `apps/web/app` returned zero matches.
- **Evidence:** `/cashback/:slug` SEO landing (L40-55) emits only `title`, `description`, `canonical`. No `og:title` / `og:description` / `og:image` / `twitter:card`. Same for every other public route (`home.tsx`, `cashback.tsx`, `calculator.tsx`, `trustlines.tsx`, `privacy.tsx`, `terms.tsx`, `gift-card.$name.tsx`).
- **Impact:** Social-share previews (Slack, Twitter, Discord, WhatsApp) render a fallback thumbnail instead of a branded card. Acquisition funnel loss.
- **Remediation:** Add a shared `socialMeta({title, description, slug})` helper emitting og:/twitter: tags, plugged into every public route's `meta()`.

### A2-1109 — LCP hero image not preloaded (G5-53)

- **Severity:** Low.
- **Files:** `apps/web/app/routes/home.tsx:78-80` (uses `/hero.webp` as `background-image`), `apps/web/app/root.tsx:134-143` (`links()` lists fonts preconnect but no hero preload).
- **Evidence:** Hero uses inline `style={{ backgroundImage: 'url(/hero.webp)' }}`. Not discoverable by the preload scanner because it's an inline-style URL, not an `<img src>`. No `<link rel="preload" as="image" href="/hero.webp">` in `root.tsx` or `home.tsx`.
- **Impact:** Measurable LCP delay on cold load of the marketing home page.
- **Remediation:** Either replace the background-image with `<img>` + `fetchpriority="high"` for the LCP element, or preload via `links()` conditional on the route being `/`.

### A2-1110 — Inter fonts loaded from Google Fonts at runtime (third-party) (G5-50)

- **Severity:** Info (already explicitly deferred).
- **File:** `apps/web/app/root.tsx:134-143`.
- **Evidence:** `rel="preconnect"` + `rel="stylesheet"` → `fonts.googleapis.com`. Comment L130-133: "documented and accepted third-party runtime dependency — see `docs/adr/005-known-limitations.md` §10. Allowlisted in CSP by `buildSecurityHeaders`. Audit A-032."
- **Impact:** Per-request tracking opportunity for Google; recorded as accepted limitation. Third-party dependency for font rendering.
- **Remediation:** None for this phase. Cross-reference in Phase 12 privacy section.

### A2-1111 — Splat route to `not-found.tsx` rather than an `ErrorBoundary` thrown 404

- **Severity:** Info.
- **File:** `apps/web/app/routes.ts:44`.
- **Evidence:** `route('*', 'routes/not-found.tsx')` returns `200 OK` with a "Page not found" body, rather than a true 404 response status. On the SSR server, the HTTP status is still 200 — crawlers cannot distinguish the missing page from a real page.
- **Impact:** SEO: soft-404 behaviour. A link indexer that respects 404 will still index the splat page as valid content.
- **Remediation:** Either (a) set `status: 404` in the splat's loader via `throw new Response(null, { status: 404 })` on SSR, or (b) emit `<meta name="robots" content="noindex" />` in `not-found.tsx`'s `meta()`.

### A2-1112 — Root `meta()` generic; no Twitter/OG fallback for all routes

- **Severity:** Info.
- **File:** `apps/web/app/root.tsx:123-128`.
- **Evidence:** Root emits only `title` + `description`. Routes that don't override (e.g. `/onboarding`, `/settings/*`) fall back to a generic title but with no OG card.
- **Impact:** Any path that hasn't overridden `meta()` lacks social-share chrome.
- **Remediation:** Add minimum OG defaults in root `meta()` (og:type, og:site_name, og:image).

### A2-1113 — `hero.webp` background-image delays LCP — duplicate of A2-1109

(merged into A2-1109.)

### A2-1114 — `ErrorBoundary` suppresses non-route `error.message` in production

- **Severity:** Info.
- **File:** `apps/web/app/root.tsx:470-483`.
- **Evidence:** In production (`!import.meta.env.DEV`), the `Error instanceof Error` branch does not expose `error.message` — only `statusText` for `isRouteErrorResponse` paths. Generic "An unexpected error occurred." is rendered.
- **Impact:** Debuggability trade-off — production users cannot relay a specific error message to support. Sentry captures the stack, but the user-facing channel is opaque.
- **Remediation:** Show a truncated `error.message` for non-sensitive error classes, or surface a short request-id the user can reference in support.

### A2-1115 — Admin routes under `routes.ts` do not lazy-split; full admin bundle loaded for every user

- **Severity:** Info.
- **Files:** `apps/web/app/routes.ts:27-43` — admin routes use `route(...)` which statically imports the module at build time. React Router v7 split-chunks per route by default via Vite, so this may already be chunked — evidence is an inspection of a real build output (out of this phase's scope; flag for Phase 4).
- **Impact:** If not chunked, every public visitor downloads the full admin bundle.
- **Remediation:** Verify in Phase 4 build inspection that `admin.*` chunks are separate from the entry.

### A2-1116 — `sitemap.tsx` server-side fetches upstream backend — deliberate exception, no test

- **Severity:** Info.
- **File:** `apps/web/app/routes/sitemap.tsx:38-49, 71-118`.
- **Evidence:** Resource route `loader` hits `/api/public/top-cashback-merchants?limit=50`. Documented as an exception to the pure-API-client rule (L15-18). Fails open on error. No unit test under `routes/__tests__/` exercises this loader.
- **Impact:** Regression risk — a change to the public endpoint's shape could silently produce a malformed sitemap for weeks before anyone notices, because the fail-open swallows the error.
- **Remediation:** Add a unit test that mocks `fetch` and asserts (a) merchant URLs appear in the output, (b) on `fetch` error the static routes still emit, (c) the XML validates.

### A2-1117 — No service worker registered / declared (G5-49)

- **Severity:** Info (decision-record).
- **Files:** grep `service-worker|sw\.js|serviceWorker` across `apps/web` → no matches.
- **Evidence:** No SW bundle, no registration. Mobile uses Capacitor (native webview); web offline story is limited to `OfflineBanner` (`apps/web/app/components/ui/OfflineBanner.tsx`) + the in-memory TanStack cache.
- **Impact:** Web marketing visitor offline experience is minimal. Unregister path (for users who enabled one in a prior experiment) is moot because none exists.
- **Remediation:** Decision — either ship a minimal SW for offline SEO-page caching, or record the decision in an ADR that Loop web deliberately does not use SW.

### A2-1118 — `robots.txt` sitemap URL hard-coded to canonical domain

- **Severity:** Info.
- **File:** `apps/web/public/robots.txt`.
- **Evidence:** `Sitemap: https://loopfinance.io/sitemap.xml`. Any preview deploy (vercel branch build, fly staging) would still advertise the production sitemap — crawlers on the preview domain would either 404 the sitemap URL (wrong host) or follow it to prod. Usually harmless because preview domains block indexing at the platform level.
- **Impact:** Low — preview domains are usually `X-Robots: noindex`'d by the platform.
- **Remediation:** None required; doc-only.

### A2-1119 — `/privacy` and `/terms` contain placeholder legal copy

- **Severity:** Low.
- **Files:** `apps/web/app/routes/privacy.tsx:6-22`, `apps/web/app/routes/terms.tsx:6-22`.
- **Evidence:** Self-documented: "counsel will drop in the final text before submission", "Don't use the placeholder text in any binding context." App Store submission gates on these URLs.
- **Impact:** Cannot ship to production / App Store until replaced. Finding tracks the TODO so a later phase doesn't re-discover it.
- **Remediation:** Legal review + final copy before any user-facing launch.

---

## 11. What is NOT a finding

- **Capacitor isolation:** clean. Zero `@capacitor/*` imports in `routes/`.
- **Loader purity:** clean. Only `sitemap.tsx` has a loader and it's documented, build-target-gated, and fails open.
- **Dark mode:** every route audited has `dark:` variants.
- **External-link safety:** every `target="_blank"` in `routes/` carries `rel="noopener noreferrer"` (7 occurrences across 4 files — trustlines L117-118, 128-129, 168-169; admin.payouts.$id L278-279; admin.merchants.$merchantId L145-146; admin.assets.$assetCode L244-245).
- **Error-page routing (G4-16):** 404 handled (`not-found.tsx` via splat + `ErrorBoundary` `status===404`); 500/other handled via root `ErrorBoundary`; 401 handled per-route with sign-in CTA. 403 is the only gap (A2-1103).
- **Empty / loading / error states:** every data-driven route audited has all three states (see matrix column).
- **Native wrapper safety:** every wrapper lazy-imports the plugin, has a web fallback or a documented no-op, and disposers are well-behaved.
- **`app.css`:** no stale classes, no dead hand-rolled selectors. Theme-icon cleanup from commit `02870ed` verified.
- **`webview.ts`:** URL validation (scheme allowlist, embedded-credentials rejection, prod-http rejection) audited clean.
- **`secure-storage.ts`:** the Proxy-`then`-collision workaround (L37-52) is defensive and correctly isolates plugin façade from Promise machinery. One-shot migration preserves ADR-006 semantics.

---

## 12. Exit check

- [x] Every file in scope has a disposition (34 route files + 16 native files + root.tsx + routes.ts + robots.txt + app.css = 53 files).
- [x] Loader grep ran, 1 hit (sitemap) — reviewed.
- [x] `@capacitor/*` grep in routes/ — 0 matches (clean).
- [x] `window.|document.|localStorage` grep in routes/ — 4 client-only matches, 0 module-level.
- [x] Native-wrapper matrix filled for all 16 wrappers.
- [x] Public assets + robots + manifest + sitemap reviewed.
- [x] Findings A2-1100..A2-1119 logged — 20 findings, 50 slots allocated, remaining A2-1120..A2-1149 unused and available for Phase 8b if it needs overflow.
