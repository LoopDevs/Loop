# V9 — Web Client: routes, locale routing, SSR/static, loaders, services

> Cold adversarial audit — 2026-06-15. Scope: `apps/web/app/routes/**` (all 40),
> `apps/web/app/services/**`, `react-router.config.ts`, `routes.ts`, locale layout
> files, `home-geo-redirect.tsx`, `sitemap.tsx`, `root.tsx`, `entry.server.tsx`,
> `i18n/{locale,seo,format}.ts`. Components / stores / hooks / a11y are owned by a
> separate agent — findings here are routing / SSR / loaders / data-fetching /
> services only.

## Summary

The web routing + services layer is in **strong shape**. The ADR-critical
"web is a pure API client" rule holds exactly: only `sitemap.tsx` and
`home-geo-redirect.tsx` fetch in loaders, and both are documented. The two other
SSR loaders (`not-found-ssr.tsx`, `locale-layout-ssr.tsx`) are pure param
validation with no I/O. ADR-034 locale routing is correct and well-tested:
self-canonicals (never cross-canonical), reciprocal hreflang + x-default from a
single sitemap source, geo 302 (not 301) before React renders, bot-exempt
x-default at `/`, and a clean SSR↔static (`BUILD_TARGET=mobile`) split that wires
component-only variants where SPA mode rejects `loader` exports. Services are
consistent: shared types (ADR 019), `encodeURIComponent` on every `:id` in a URL,
timeouts + AbortSignal composition, shared error-shape coercion, idempotency keys
on order creation, and React auto-escaping everywhere (no `dangerouslySetInnerHTML`
in any route). All 17 admin routes wrap content in `<RequireAdmin>` and gate inner
queries behind the resolved admin gate. CSP nonce, security headers, and Stellar
private-key-stays-on-device invariants all hold.

Severity counts: **P0: 0 · P1: 1 · P2: 3 · P3: 5**

The single P1 is the admin payout-retry step-up gap (ADR-028 control unreachable
from the payouts surface). No money-loss, auth-bypass, secret-leak, or SSR-injection
issues found in this vertical.

---

## Findings

### W-01 — P1 — Admin payout-retry can't satisfy step-up; first retry dead-ends

**File:** `apps/web/app/routes/admin.payouts.tsx:114-125`, `apps/web/app/routes/admin.payouts.$id.tsx:78-90`
**Vertical:** V8 (admin) / V9
The `retryPayout` service sends `withStepUp: true` (`services/admin-payouts.ts:120`),
but `withStepUp` in `api-client.ts:247-254` only _attaches_ an already-held step-up
token — it does **not** trigger the OTP mint flow. Both payout routes call
`retryMutation.mutate(...)` directly with no `useAdminStepUp().runWithStepUp(...)`
wrapper and no `<StepUpModal>`. The sibling destructive forms
(`CreditAdjustmentForm`, `AdminWithdrawalForm`, `HomeCurrencyForm`) all do this
correctly and are the reference pattern.
**Impact:** On the normal first-retry case (no fresh token held), the backend
returns `401 STEP_UP_REQUIRED` and the operator sees a raw "Retry failed: …" with
no way to elevate — the ADR-028 gate is effectively unreachable for payout-retry,
blocking incident remediation of a stuck on-chain payout.
**Evidence:** `retryMutation = useMutation({ mutationFn: retryPayout })` with no
`runWithStepUp` and no modal render; compare `CreditAdjustmentForm` which wraps the
mutationFn in `stepUp.runWithStepUp(...)`.
**Fix:** Adopt the credit/withdrawal pattern: `const stepUp = useAdminStepUp();`
`mutationFn: () => stepUp.runWithStepUp(() => retryPayout(args))` and render
`<StepUpModal>` when `stepUp.modalOpen`.
**Ref:** ADR 028.

### W-02 — P2 — `OrderPayoutCard` polls a terminal payout forever

**File:** `apps/web/app/components/features/order/OrderPayoutCard.tsx:65` (rendered on `routes/orders.$id.tsx`)
**Vertical:** V9 / §13 perf
`refetchInterval: 30_000` is a constant with no terminal stop condition. Once a
payout reaches `confirmed` or `failed` (terminal), the card keeps polling
`GET /api/users/me/orders/:id/payout` every 30s for as long as the tab is open.
Contrast `LoopPaymentStep.tsx:42`, which correctly returns `false` from the
`refetchInterval` callback on terminal state.
**Impact:** Unbounded background requests + backend cost on a fully settled order.
**Fix:** Make `refetchInterval` a function returning `false` when
`payout.state` is `confirmed`/`failed`.
**Note:** `PendingPayoutsCard.tsx:36`, `PendingCashbackChip.tsx:84`, and
`StellarTrustlineStatus.tsx:34` also poll on a flat interval, but those are
list/summary views whose contents can legitimately change (new pending items
arriving), so they are defensible — only the single-order terminal card is a clear
miss. (These components are formally the other agent's surface; flagged here because
the data-fetching pattern is the routing concern.)

### W-03 — P2 — `services/config.ts` `fetchAppConfig` bypasses the shared API client

**File:** `apps/web/app/services/config.ts:68-76`
**Vertical:** V9 / §14 DRY
`fetchAppConfig` uses raw `fetch()` directly instead of `apiRequest`. Consequence:
no request timeout (a hung backend leaves the config query spinning — `api-client.ts`
gives every other call a 30s `AbortSignal.timeout`), no `X-Client-Version` /
`X-Client-Platform` header (so this one request is invisible to the access-log
client-version scoping A2-1529 relies on), and a bespoke `throw new Error(...)`
instead of the shared `ApiException` + `parseErrorResponse` envelope every other
service throws. `geo.ts`, `merchants.ts`, `public-stats.ts`, `user.ts`, etc. all
correctly route through `apiRequest`/`authenticatedRequest`; `config.ts` is the
lone exception.
**Impact:** Missing timeout (UI hang risk) + observability/error-shape
inconsistency on the app-config bootstrap call.
**Fix:** Route through `apiRequest<AppConfig>('/api/config')`.

### W-04 — P2 — Sitemap omits localized merchant variants while pages self-canonical to them

**File:** `apps/web/app/routes/sitemap.tsx:122-126` vs `routes/cashback.$slug.tsx:56`
**Vertical:** V9 / §23 i18n / SEO
`/cashback/:slug` pages emit a _self-referencing_ canonical via
`canonicalHref(params, '/cashback/' + slug)` — so a crawl of
`/gb/en/cashback/amazon` canonicals to `/gb/en/...`. But the sitemap lists these
merchant pages only as `x-default` (`/us/en/...`, line 124). The localized mounts
are therefore only discoverable via internal links, not the sitemap.
**Impact:** Per-country merchant pages have weaker crawl/discovery than the
country-varying home/`/cashback` index pages (which DO get one `<url>` per country
with reciprocal hreflang). This is _documented intent_ in the sitemap header comment
(the public merchant feed carries no country/currency yet, so per-country merchant
variants would be thin pages) — recorded as P2 for the audit trail, not a defect.
**Fix:** None required while the merchant feed is country-agnostic; revisit when
ADR-035 order-path currency lands and merchant pages become per-country meaningful.

### W-05 — P3 — `gift-card.$name.tsx` and `brand.$slug.tsx` set no canonical and are not in the sitemap

**File:** `apps/web/app/routes/gift-card.$name.tsx`, `apps/web/app/routes/brand.$slug.tsx`
**Vertical:** V9 / SEO
Both render identical content on the localized `/:country/:lang/...` mount and the
legacy unprefixed mount (`routes.ts`), with no `rel=canonical` and no
`robots: noindex`. A duplicate-content surface if crawled via inbound links.
**Impact:** Minor SEO dilution across the two mounts; low risk since neither is a
primary acquisition target.
**Fix:** Either add a self-canonical via `canonicalHref(params, ...)` to collapse
the dup mounts, or add `meta` `robots: noindex`.

### W-06 — P3 — `settings.cashback.tsx` builds an order link without `encodeURIComponent`

**File:** `apps/web/app/routes/settings.cashback.tsx:275`
**Vertical:** V9 / §14
`/orders/${entry.referenceId}` is interpolated without `encodeURIComponent`, unlike
the codified pattern elsewhere (`orders.tsx:131`, `user.ts:162`). Server-generated
UUID so practically safe, but inconsistent with the established convention.
**Fix:** `encodeURIComponent(entry.referenceId)`.

### W-07 — P3 — Admin payout-retry surfaces raw upstream `err.message`

**File:** `apps/web/app/routes/admin.payouts.tsx:121-123`, `admin.payouts.$id.tsx:86-88`
**Vertical:** V8 / §4
`setRetryError(err.message)` reflects the backend error string verbatim (React-
escaped, so not XSS) — can leak internal codes (STEP*UP*\*, idempotency conflicts)
un-mapped to friendly copy on the admin surface.
**Fix:** Map known `ApiException.code`s to guidance per `docs/error-codes.md`.

### W-08 — P3 — Redundant in-route `denied` handling in admin index implies the gate is bypassable

**File:** `apps/web/app/routes/admin._index.tsx:162-191` (and dead branches)
**Vertical:** V8 / §14
`AdminIndexRouteInner` re-derives `denied` from a treasury 401/404 even though
`RequireAdmin` already blocked non-admins before the inner renders. Dead code that
muddies the security story.
**Fix:** Drop the in-route `denied` branch; rely on `RequireAdmin`.

### W-09 — P3 — `settings.cashback.tsx` "Load more" yields an empty page on exact-multiple totals

**File:** `apps/web/app/routes/settings.cashback.tsx:254`
**Vertical:** V9 / §32 UX
`hasMore = entries.length === PAGE_SIZE` shows a "Load more" that returns an empty
page when the total is an exact multiple of 25 (acknowledged in an in-code comment).
**Fix:** Cursor/`hasMore`-flag from the API, or accept the documented nit.

### W-10 — P3 — Admin queries fire only after the gate resolves (defense-in-depth note, NOT a defect)

**File:** all 17 `routes/admin*.tsx`
**Vertical:** V8 — verified clean
Inner query hooks are children of `RequireAdmin` and only mount once `me.data.isAdmin
=== true`, so no admin data is fetched/flashed before the gate. Recorded as
explicitly-checked-and-clean (the audit asked for it).

---

## Coverage

Routes examined (40 modules across 51 route mounts incl. locale mirrors):

Core / config:

- `react-router.config.ts` — SSR gated on `BUILD_TARGET !== 'mobile'` ✓
- `routes.ts` — locale mirrors, SSR/mobile splat + sitemap split ✓
- `root.tsx` — CSP nonce, security headers, merchant disk-cache, QueryClient ✓
- `entry.server.tsx` — per-request nonce, security headers, abort-timer cleanup ✓

Locale / SEO / SSR plumbing:

- `home-geo-redirect.tsx` — geo 302, bot x-default, cookie precedence ✓ (loader-fetch exception, documented)
- `sitemap.tsx` — loader-fetch exception (documented), fail-open, hreflang ✓ (W-04)
- `locale-layout.tsx` (mobile, component-only) ✓
- `locale-layout-ssr.tsx` (SSR, 404-throwing loader, pure validation) ✓
- `not-found.tsx` / `not-found-ssr.tsx` (real HTTP 404 vs SPA) ✓
- `i18n/locale.ts`, `i18n/seo.ts` (canonical, hreflang, localizedHref, cookie) ✓

Public locale routes (each mounted at `/` and `/:country/:lang`):

- `home.tsx` (per-country meta + self-canonical) ✓
- `cashback.tsx`, `cashback.$slug.tsx` (W-04) ✓
- `calculator.tsx` (self-canonical + in sitemap) ✓
- `trustlines.tsx`, `privacy.tsx`, `terms.tsx` (self-canonical) ✓
- `gift-card.$name.tsx`, `brand.$slug.tsx` (W-05) ✓
- `map.tsx`, `onboarding.tsx` ✓

Authed routes:

- `auth.tsx` (OTP + social + account view) ✓
- `orders.tsx`, `orders.$id.tsx` (auth-gated, polling W-02) ✓
- `settings.wallet.tsx` (public-key only, no secret leak), `settings.cashback.tsx` (W-06, W-09) ✓

Admin routes (all 17, all `<RequireAdmin>`-wrapped, no loader fetches):

- `admin._index.tsx` (W-08), `admin.cashback.tsx`, `admin.treasury.tsx`,
  `admin.payouts.tsx` + `.$id.tsx` (W-01, W-07), `admin.orders.tsx` + `.$orderId.tsx`,
  `admin.stuck-orders.tsx`, `admin.merchants.tsx` + `.$merchantId.tsx`,
  `admin.users.tsx` + `.$userId.tsx`, `admin.operators.tsx` + `.$operatorId.tsx`,
  `admin.assets.tsx` + `.$assetCode.tsx`, `admin.audit.tsx` ✓

Services (all read):

- `api-client.ts` (timeout, refresh coalescing, step-up plumb, client-id pairing) ✓
- `config.ts` (W-03), `geo.ts`, `merchants.ts`, `public-stats.ts`, `user.ts`,
  `orders.ts`, `orders-loop.ts` (idempotency key), `clusters.ts` (protobuf+JSON),
  `auth.ts`, `favorites.ts`, `recently-purchased.ts`, `stellar-wallet.ts` (stub),
  `parse-error-response.ts`, `admin.ts` barrel + `admin-payouts.ts` ✓

Tests present and meaningful: `home-geo-redirect.test.ts`, `sitemap.test.tsx`,
`locale-routing.test.ts`, `locale.test.ts`, `seo.test.ts`, `locale-layout.test.ts`,
`not-found.test.ts`, `entry-server-headers.test.ts`, plus per-route admin/settings/
calculator/brand tests and a full `services/__tests__` suite.

**Coverage: 40/40 route modules + 51/51 route mounts + 28/28 service files +
all config/SSR/locale plumbing = 100% of the assigned surface.**
