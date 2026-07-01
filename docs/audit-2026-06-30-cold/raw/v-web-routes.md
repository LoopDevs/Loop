# Vertical: Web routes/locale/SSR — raw findings

Cold adversarial audit, 2026-06-30 round. Scope: all 40 `apps/web/app/routes/*.tsx`
(17 admin routes skimmed by a narrow-scope sub-agent for cross-cutting concerns
only; full deep-dive on the other 23 by the primary agent), all 49
`apps/web/app/services/*.ts` (35 admin-prefixed by the sub-agent, 14 non-admin by
the primary agent), `apps/web/app/i18n/{format,locale,messages,t,seo}.ts` +
`__tests__`, `apps/web/app/root.tsx`, `apps/web/app/routes.ts`,
`apps/web/app/entry.server.tsx`, `apps/web/app/utils/{locale,security-headers,
sentry-lazy,redeem-message}.ts` + `__tests__`, plus supporting files pulled in by
the trail (`apps/web/app/utils/sentry-scrubber.ts`,
`apps/web/app/components/Phase2Gate.tsx`,
`apps/web/app/components/ui/LocaleLink.tsx`,
`apps/web/app/components/features/order/OrderPayoutCard.tsx`,
`apps/web/app/components/features/cashback/{PendingCashbackChip,
CashbackCalculator}.tsx`).

Files examined: 23/23 non-admin routes (direct) + 17/17 admin routes (sub-agent,
narrow scope) = 40/40 routes · 14/14 non-admin services (direct) + 35/35 admin
services (sub-agent) = 49/49 services · 4/4 i18n core files + seo.ts · 4/4
delta-flagged utils · root.tsx / routes.ts / entry.server.tsx.

## Findings

### W30-01 [P2 · LIVE] `/calculator` shows Phase-2 cashback-accrual copy and is not Phase-1-gated, unlike every sibling cashback surface

- File: `apps/web/app/routes/calculator.tsx:43-107`; compare
  `apps/web/app/routes/cashback.tsx:49-55`, `apps/web/app/routes/cashback.$slug.tsx:80-86`,
  `apps/web/app/routes/trustlines.tsx:49-55`, `apps/web/app/routes/settings.wallet.tsx:42-48`,
  `apps/web/app/routes/settings.cashback.tsx:84-90`
- Description: Per `AGENTS.md`, `LOOP_PHASE_1_ONLY=true` (the documented current
  default) hides "every Phase 2+ surface (cashback links, /settings/wallet,
  /settings/cashback, /cashback, onboarding currency picker + wallet-intro,
  'you've earned X' copy)". Every other cashback-accrual surface in the app —
  `/cashback`, `/cashback/:slug`, `/trustlines`, `/settings/wallet`,
  `/settings/cashback` — is wrapped in `<Phase2Gate>`, which fails closed (defaults
  `phase1Only: true` until config resolves) and swaps the content for a "Coming
  soon" panel. `calculator.tsx` (`CalculatorRoute`) has no `Phase2Gate` wrapper at
  all — it renders unconditionally and is registered both top-level and under
  `:country/:lang` (`routes.ts` `locale/calculator`), and is the one cashback-
  preview surface `sitemap.tsx` actively lists for crawling
  (`urlTag(xDefault('/calculator'), now, 'weekly', '0.8')`). The page renders
  `CashbackCalculator`, whose copy is explicit Phase-2 wallet-accrual framing
  ("Loop pays cashback in LOOP-asset stablecoin you can spend on your next
  order" / "You'll earn …") — the same "you've earned X cashback" framing
  AGENTS.md says must be hidden in Phase 1.
- Impact: A Phase-1 visitor (or Googlebot, since the page is sitemap-indexed) can
  reach `/calculator`, pick any of the 50 top-cashback merchants, and see a dollar
  "You'll earn" figure for a wallet-accrual mechanic that does not exist yet in
  Phase 1 — inconsistent with the product's own Phase-1 launch framing and a
  plausible source of support tickets ("where's my cashback balance?").
- Evidence: `apps/web/app/routes/calculator.tsx` has no `Phase2Gate` import;
  `apps/web/app/components/features/cashback/CashbackCalculator.tsx:94` renders
  "Calculate your cashback" / "You'll earn" unconditionally.
- Minimal fix: Wrap `CalculatorRoute`'s body in `<Phase2Gate>` like its four
  siblings.
- Better fix: Same wrap, plus drop `/calculator` from `sitemap.tsx` while
  `phase1Only` is the deployed default (or have the sitemap loader read
  `/api/config` and conditionally omit Phase-2 URLs — heavier, only worth it if
  more Phase-2 marketing pages accumulate).

### W30-02 [P1 · LIVE] Native DSR data export only `console.log`s the payload — not actually retrievable by the user

- File: `apps/web/app/routes/settings.privacy.tsx:91-102`,
  `apps/web/app/services/user.ts:244-271`
- Description: `/settings/privacy` (CF-26 / X-PRIV-01) is deliberately **not**
  `Phase2Gate`'d — the route's own header comment says data export/deletion are
  "GDPR Art. 15/17 rights and an Apple App Store Guideline 5.1.1(v) submission
  requirement, so they must be reachable in Phase-1". On web, `downloadMyData()`
  correctly builds a `Blob` and triggers an anchor download. On native
  (`isNative === true`), `handleExport` instead does:
  `const payload = await getMyDataExport(); console.log('[loop] your data
export', payload); setExportState('done');` — and the UI then tells the user
  "Your data was prepared. To save a copy on mobile, contact
  privacy@loopfinance.io." There is no file write, no native share sheet, and no
  way for a non-developer user to actually retrieve their data on iOS/Android. The
  codebase already has the exact primitive needed —
  `apps/web/app/native/share.ts#nativeShare` writes a file via
  `@capacitor/filesystem` (`Filesystem.writeFile` into `Directory.Cache`) and
  opens the OS share sheet via `@capacitor/share` — built for image sharing
  (ADR-008) but directly reusable for a JSON blob.
- Impact: A native (iOS/Android) user tapping "Download my data" gets no usable
  artifact in production — `console.log` output is not visible to an end user
  (no devtools), so the GDPR Art. 15/20 data-portability right is not actually
  honoured for the mobile app's user base, and Apple Guideline 5.1.1(v) review
  could plausibly fail this flow at submission/spot-check since the advertised
  "Download my data" action produces nothing the reviewer can see. Untested:
  `settings.privacy.test.tsx` mocks `useNativePlatform` to `{ isNative: false }`
  for every test, so the native console.log path has zero test coverage either.
- Evidence: route comment explicitly says "A first-class native file-save is a
  follow-up; the data is the right that matters here" — i.e. a known, accepted
  gap, not a hidden regression, but the severity (compliance-facing, live in
  Phase 1) argues for re-litigating that acceptance now that the rest of CF-26
  has shipped.
- Minimal fix: On native, write the export JSON to `Directory.Cache` via
  `Filesystem.writeFile` (mirroring `writeTempShareImage` in
  `app/native/share.ts`) and open the native share sheet
  (`Share.share({ files: [uri] })`) so the user can save/AirDrop/email the file
  themselves; update the post-export copy accordingly.
- Better fix: Add a thin `app/native/share.ts` export (e.g. `shareJsonFile(name,
payload)`) reusing the existing temp-file + share + purge pattern, call it from
  both `settings.privacy.tsx` and any future native export surface, and add a
  native-path test (mock `isNative: true`) asserting the share call fires instead
  of `console.log`.

### W30-03 [P2 · LIVE] CF-23 bigint-exact money rendering inconsistently adopted — `/auth` Account screen still float-converts

- File: `apps/web/app/routes/auth.tsx:164-176` (`formatCashbackBalance`),
  `apps/web/app/routes/auth.tsx:223-237` (`formatLedgerAmount`); compare the
  correct pattern already shipped at
  `apps/web/app/routes/settings.cashback.tsx:50-72` (`formatAmount`)
- Description: PR #1445 ("bigint-exact currency rendering across money displays
  — CF-23") added the canonical bigint-safe split — divide/modulo in `bigint`
  space, `Number`-cast only the bounded whole/fraction parts — and
  `settings.cashback.tsx#formatAmount` explicitly documents using that exact
  pattern (with a comment explaining why it doesn't call the shared
  `formatMinorCurrency` helper directly: browser locale + `signDisplay` needs).
  `auth.tsx`'s `CashbackBalanceCard` and `CashbackHistoryCard` — which render the
  **same** data (home-currency balance, individual ledger-entry amounts) on the
  Account screen one click away — instead do
  `const asCents = BigInt(minor); const major = Number(asCents) / 100;`, the
  pre-CF-23 float-conversion pattern the fix was meant to retire everywhere.
  `PendingCashbackChip.tsx:43-58` (`formatAmount`, rendered inline on the same
  Account screen via `<PendingCashbackChip />`) and
  `CashbackCalculator.tsx:44-56` (`formatCashbackMinor`, rendered on
  `/calculator` and `/cashback/:slug`) have the identical `Number(BigInt(x))/100`
  pattern.
- Impact: Precision loss only manifests past 2^53 minor units (~$90 trillion),
  so this is not exploitable on any individual user's real balance today —
  but it's the exact class CF-23 was opened to eliminate fleet-wide, and three of
  the four call sites (`auth.tsx` x2, `PendingCashbackChip.tsx`,
  `CashbackCalculator.tsx`) were missed while a fourth, near-identical sibling
  (`settings.cashback.tsx`) got the fix. A future change that sums multiple
  ledger rows client-side before formatting (a natural next feature) would
  silently reintroduce the bug on these surfaces.
- Evidence: side-by-side diff of `auth.tsx:166-167` (`Number(asCents) / 100`) vs
  `settings.cashback.tsx:59-62`
  (`Number(abs / 100n) + Number(abs % 100n) / 100`).
- Minimal fix: Port the bigint-safe split from `settings.cashback.tsx#formatAmount`
  into `auth.tsx`'s two formatters, `PendingCashbackChip.tsx`, and
  `CashbackCalculator.tsx`.
- Better fix: Extract the bigint-safe split (not the locale-bound `formatMoney`)
  as a small shared helper in `i18n/format.ts` (e.g.
  `minorBigintToMajorNumber(minor): number`) so every hand-rolled formatter in
  the web app calls one audited implementation instead of four independently
  re-derived ones.

### W30-04 [P3 · GATED/LIVE-on-/calculator] CF-22 locale-format seam not threaded through every money/number render — `Intl.NumberFormat(undefined, …)` survives on 5 components

- File: `apps/web/app/components/features/cashback/CashbackCalculator.tsx:47`,
  `apps/web/app/components/features/cashback/PendingCashbackChip.tsx:50`,
  `apps/web/app/routes/auth.tsx:168,227`,
  `apps/web/app/routes/settings.cashback.tsx:63`,
  `apps/web/app/components/features/MerchantCard.tsx:28`
- Description: ADR 034's "i18n seam status" note (added for CF-22) claims
  `i18n/format.ts` is "now the single source of truth for currency/number/date
  formatting" and lists the migrated surfaces ("cashback cards, orders summary,
  order rows, rail-mix, Loop-payment step, and gift-card range"). That's true for
  the listed surfaces (verified: `orders.tsx`, `orders.$id.tsx`,
  `gift-card.$name.tsx`, and the cashback/purchase components all correctly call
  `useLocaleTag()` + `formatMoney`/`formatMinorCurrency`/`currencySymbol`). It is
  not true everywhere: the five files above still call
  `new Intl.NumberFormat(undefined, …)` directly (or, for `MerchantCard.tsx`,
  call `currencySymbol(currency)` with no `locale` arg at all, silently
  defaulting to `'en'`), bypassing the route-driven locale entirely. The most
  material instance is `CashbackCalculator.tsx`, which renders on two
  locale-prefixed routes (`/:country/:lang/calculator`,
  `/:country/:lang/cashback/:slug`) that ADR 034 explicitly calls out for full
  per-market treatment — yet its money formatting uses the **browser's/server's
  default locale**, not the URL's market, which both contradicts the "locale is
  derived from the route, never `navigator.language`" invariant in
  `i18n/format.ts`'s own module docstring and risks an SSR/client hydration
  mismatch (Node's default ICU locale on the server vs. the visitor's browser
  locale on the client) on first render before the debounced query settles.
  `auth.tsx`, `PendingCashbackChip.tsx`, `settings.cashback.tsx` are on
  deliberately single-locale routes per ADR 034 ("Auth/orders/settings stay
  single-locale … currency comes from the user's home-currency setting") so
  using a non-route locale there is closer to "as designed," but they still
  diverge from the one-true-formatter goal the ADR claims is closed.
- Impact: Low on its own (currency _symbol_ selection via `narrowSymbol` is
  largely locale-invariant for USD/GBP/EUR, so the visible output rarely
  differs) — flagged because it contradicts a specific, recently-written
  "this is now consolidated" claim in ADR 034, and because `CashbackCalculator`
  sits on a route ADR 034 says should be market-correct.
- Evidence: `grep -rln "Intl.NumberFormat" app/` outside `i18n/format.ts`
  returns the five files above (admin surfaces excluded — those intentionally
  pin `ADMIN_LOCALE`).
- Minimal fix: Swap each `Intl.NumberFormat(undefined, …)` call for
  `useLocaleTag()` + `formatCurrency`/`formatMinorCurrency` from `~/i18n/format`
  at minimum in `CashbackCalculator.tsx` (the only one on a locale-routed page).
- Better fix: Do the same for the remaining four for consistency, and update the
  ADR 034 "i18n seam status" note's surface list once true, or soften the "single
  source of truth" claim to "the canonical seam for the surfaces listed" so the
  doc doesn't overstate completion (§5 doc-integrity).

### W30-05 [P3 · DOCS] `root.tsx` CSP comment describes a superseded delivery mechanism

- File: `apps/web/app/root.tsx:257-263`; actual mechanism at
  `apps/web/app/entry.server.tsx:36-63`
- Description: The comment in `Layout()` says "HTTP headers that can't live in
  meta (X-Frame-Options, HSTS, Permissions-Policy, etc.) are applied at the
  deploy edge — Fly.io's `force_https=true` already delivers HSTS-equivalent."
  That description predates `entry.server.tsx`'s `applySecurityHeaders`, which
  now sets every header from `buildSecurityHeaders` (including
  `X-Frame-Options`, `Strict-Transport-Security`, `Permissions-Policy`, COOP,
  CORP) directly on the SSR response in application code — not at the Fly edge.
  `entry.server.tsx`'s own header comment correctly describes this (it's the
  newer file). The stale comment isn't harmful (the headers ARE being sent,
  just not the way the comment says), but it would mislead a future engineer
  auditing "where do these headers actually come from" into checking Fly config
  instead of `entry.server.tsx`.
- Impact: Documentation/comment drift only — no functional gap.
- Evidence: `entry.server.tsx:52` docblock: "This entry applies every header
  from `buildSecurityHeaders` on every SSR response," directly contradicting
  `root.tsx`'s "applied at the deploy edge" framing for the same header set.
- Minimal fix: Update the `root.tsx` comment to point at
  `entry.server.tsx#applySecurityHeaders` instead of "the deploy edge."
- Better fix: Same, plus a one-line cross-reference in `security-headers.ts`'s
  own docblock (which still says "the rest are expected at the deploy edge")
  pointing at `entry.server.tsx` as the actual consumer.

### W30-06 [P3 · TEST-GAP] Canonical locale-format seam (`i18n/format.ts`) and the lazy Sentry loader (`sentry-lazy.ts`) have zero direct unit tests

- File: `apps/web/app/i18n/format.ts`, `apps/web/app/utils/sentry-lazy.ts`
- Description: `i18n/format.ts` is described in its own docblock and in ADR
  034's CF-22 note as "the single source of truth" for money/number/date
  formatting, exercised by 14+ component/route call sites — yet
  `apps/web/app/i18n/__tests__/` has no `format.test.ts` (it has
  `country-model`, `locale-routing`, `locale`, `seo`), and no other test file
  under `app/` imports from `~/i18n/format`
  (`grep -rln "i18n/format" app --include="*.test.*"` is empty). The fallback
  branches (`catch` → `"1.23 XYZ"` on an invalid ISO code, the `fractionDigits`
  conditional-spread in `formatMinorCurrency`, `currencySymbol`'s `narrowSymbol`
  extraction) are therefore untested in isolation — only indirectly exercised
  through whichever component tests happen to render a money figure.
  `sentry-lazy.ts` (PERF-004/CF-29's lazy-load + `beforeSend` wiring) similarly
  has no `sentry-lazy.test.ts`; `sentry-scrubber.test.ts` and
  `sentry-error-scrubber.test.ts` test the two scrub functions directly but
  never assert that `runInit` actually wires `beforeSend: scrubSentryEvent` or
  that `initSentryLazily`/`captureExceptionLazily` no-op correctly when no DSN
  is configured.
- Impact: A future edit to either file (e.g. a refactor of the
  `exactOptionalPropertyTypes` opts-building in `formatMinorCurrency`, or a
  Sentry SDK upgrade that changes the `init` shape) has no regression net at
  the unit level for two security/correctness-sensitive seams (money rendering;
  PII-scrub wiring).
- Evidence: `find app -iname "*format*test*"` → only `format-stellar.test.ts`
  (a different module); `grep -rln "sentry-lazy" app --include="*.test.*"` →
  empty.
- Minimal fix: Add `i18n/__tests__/format.test.ts` covering the invalid-currency
  fallback paths and `formatMinorCurrency`'s opts-building; add
  `utils/__tests__/sentry-lazy.test.ts` asserting `runInit` passes
  `beforeSend: scrubSentryEvent` and that the DSN-unset path never calls
  `import('@sentry/react')`.
- Better fix: Same, plus a snapshot-style test asserting every money-rendering
  component test (`AmountSelection.test.tsx` etc.) actually imports the real
  `~/i18n/format` module rather than a mock, so a seam regression surfaces at
  the component layer too.

### W30-07 [P3 · CARRIED FORWARD, confirmed still open] `services/config.ts#fetchAppConfig` still bypasses `apiRequest`

- File: `apps/web/app/services/config.ts:68-76`
- Description: Re-verified from the 06-15 audit's W-03 (not part of this
  round's CF list, so no PR touched it). `fetchAppConfig` still calls raw
  `fetch()` directly: no `AbortSignal.timeout` (every other service gets 30s via
  `apiRequest`), no `X-Client-Version`/`X-Client-Platform` headers (so this one
  bootstrap call is invisible to the access-log client-version scoping A2-1529
  relies on), and `throw new Error(...)` instead of the shared `ApiException` +
  `parseErrorResponse` envelope. `geo.ts`, `merchants.ts`, `public-stats.ts`,
  `user.ts`, `orders.ts` all correctly route through `apiRequest`/
  `authenticatedRequest`.
- Impact: A hung `/api/config` response leaves `useAppConfig` spinning forever
  (no timeout) instead of failing over like every other fetch; `Phase2Gate`
  defaults `phase1Only: true` while config is pending, so a hang manifests as
  "every Phase-2 surface looks permanently gated" rather than a clean error —
  low severity but a real availability edge.
- Evidence: unchanged since the 06-15 finding; confirmed by direct read this
  round.
- Minimal fix: `return apiRequest<AppConfig>('/api/config')`.

### W30-08 [P3 · CARRIED FORWARD, confirmed still open] `gift-card.$name.tsx` / `brand.$slug.tsx` still have no canonical tag, duplicate-mounted at locale + legacy paths

- File: `apps/web/app/routes/gift-card.$name.tsx:15-30`,
  `apps/web/app/routes/brand.$slug.tsx:14-29`
- Description: Re-verified from 06-15's W-05. Both routes are mounted twice
  (top-level and under `:country/:lang` per `routes.ts`) and render identical
  content at both URLs for the same slug; neither `meta()` sets a
  `rel="canonical"` link (every other public route — home, cashback, cashback/
  :slug, calculator, trustlines, privacy, terms — does via `canonicalHref`).
- Impact: Minor duplicate-content SEO dilution if both mounts get crawled via
  inbound links; the home/brand directory already links almost exclusively
  through `LocaleLink`, which only prefixes when on an active locale route, so
  most internal links land on one canonical-ish form already — but nothing
  stops external links to either.
- Evidence: unchanged; `meta()` in both files returns only `title` +
  `description`.
- Minimal fix: Add `{ tagName: 'link', rel: 'canonical', href:
canonicalHref(params, '/gift-card/' + params.name) }` (and the brand
  equivalent), matching the pattern every other route already uses.

### W30-09 [P3 · CARRIED FORWARD, confirmed still open] `settings.cashback.tsx` order link skips `encodeURIComponent`

- File: `apps/web/app/routes/settings.cashback.tsx:276`
- Description: Re-verified from 06-15's W-06.
  `<Link to={`/orders/${entry.referenceId}`}>` interpolates the ledger row's
  `referenceId` without `encodeURIComponent`, unlike the codified pattern
  elsewhere (`orders.tsx:132`, `services/user.ts:162`,
  `services/orders.ts:24`). `referenceId` is a server-generated UUID today so
  this is not currently exploitable, but it's a latent inconsistency if a future
  reference type ever carries a non-UUID id.
- Minimal fix: `encodeURIComponent(entry.referenceId)`.

### W30-10 [P3 · INFORMATIONAL] Self-serve `home-currency` write vs. documented admin-only-writes default

- File: `apps/web/app/routes/settings.wallet.tsx:80-95,156-160`,
  `apps/web/app/services/user.ts:78-83`
- Description: Not a code bug — flagging for human-policy confirmation only.
  Team guidance on file (`feedback_admin_only_user_writes` in project memory)
  states: "User-state writes affecting ledger/payouts (home_currency, etc.)
  default to admin-only, not self-serve, in Phase 1/2." `/settings/wallet`
  wires a fully self-serve `POST /api/users/me/home-currency` (via
  `setHomeCurrency` in `services/user.ts`), gated only by the backend's
  pre-first-order 409 lock — there is no admin approval step in this path (a
  parallel admin-only path also exists per `admin-user-home-currency.ts`, found
  by the admin sub-agent). The route's own comment frames this as the
  intentional "onboarding-time picker," which is a plausible carve-out (no money
  has moved yet, and it's irreversible-by-design once locked) — but it's worth
  an explicit human check against the documented default given the explicit
  prior guidance on this exact field.
- Impact: None identified beyond a documentation/policy-consistency question;
  the backend-side 409 lock + admin override path mean this isn't a live gap on
  its own.
- Evidence: `services/user.ts:70-83` docblock: "onboarding-time picker
  (ADR 015). Server validates the currency against the enum and returns 409 if
  the user has already placed an order."
- Minimal fix: None required if the team confirms the pre-first-order carve-out
  is the intended reading of the admin-only-writes policy; otherwise gate this
  behind an admin-approval flow like the rest of that policy's surface.

## Delta re-verification

- **CF-22 (i18n seam wiring)** — **Mostly closed, partially open.** The
  documented split ("locale formatting LIVE / string translation deliberately
  scaffolded") is real, well-reasoned, and accurately described in ADR 034's
  "i18n seam status" note for the 14 files that import `~/i18n/format` and call
  `useLocaleTag()`. However, the ADR's claim that this is now "the single
  source of truth" with "no longer a second live currency formatter" is
  overstated: 5 components still call `Intl.NumberFormat(undefined, …)` or
  `currencySymbol()` with no locale directly, bypassing the route-driven
  locale (W30-04), and one of those (`CashbackCalculator.tsx`) sits on the
  exact kind of locale-routed marketing page (`/calculator`,
  `/cashback/:slug`) ADR 034 says should be market-correct. `t()`/
  `messages.ts` remain genuinely unwired but clearly and honestly documented
  as an intentional Phase-2 scaffold (not hardcoded-English-masquerading-as-
  done) — that part of CF-22 is cleanly closed. Verdict: **partial** — not a
  regression, but the "consolidated" claim needs either the remaining 5
  call sites migrated or the ADR note softened.
- **CF-23 (bigint-exact money rendering)** — **Partially closed.** The
  canonical bigint-safe split shipped and is correctly used in
  `settings.cashback.tsx`, `orders.tsx`, `orders.$id.tsx`, and the
  cashback/purchase components reached via `useLocaleTag()` +
  `formatMinorCurrency`. But `auth.tsx`'s two Account-screen formatters,
  `PendingCashbackChip.tsx`, and `CashbackCalculator.tsx` still do the
  pre-fix `Number(BigInt(x)) / 100` float conversion (W30-03) — the exact
  near-identical sibling of the now-fixed `settings.cashback.tsx`. Verdict:
  **partial** — real money-display surfaces (Account-screen balance + recent
  activity) were missed.
- **CF-26 (in-app DSR UI)** — **Closed on web, gap on native.** The web path
  (`settings.privacy.tsx` + `services/user.ts`'s `getMyDataExport` /
  `downloadMyData` / `requestAccountDeletion`) is solid: correctly calls the
  two backend DSR endpoints, maps the three typed 409 deletion-block codes to
  actionable copy, gates deletion behind a typed "DELETE" confirmation,
  signs out + redirects on success, uses `role="alert"`/`role="status"
aria-live="polite"` for SR announcements, and is deliberately exempted from
  `Phase2Gate` with a correct rationale (GDPR Art. 15/17 + Apple Guideline
  5.1.1(v) must work in Phase 1). The native path is not closed in any
  user-retrievable sense — it `console.log`s the full export payload instead
  of writing+sharing a file, despite the exact Filesystem+Share primitive
  already existing in the codebase (W30-02). Verdict: **partial** — web is
  done, native needs the file-write/share follow-up the route's own comment
  flags as outstanding.
- **W-01 (06-15 finding: admin payout-retry step-up unreachable)** —
  confirmed **closed** by PR #1451: both `admin.payouts.tsx` and
  `admin.payouts.$id.tsx` now wrap the retry mutation in
  `useAdminStepUp().runWithStepUp(...)` and render `<StepUpModal>`
  (re-verified by the admin-scope sub-agent this round).
- **W-02 (06-15 finding: `OrderPayoutCard` polls terminal payout forever)** —
  confirmed **closed**: `refetchInterval` is now a function returning `false`
  once `state` is `confirmed`/`failed`, with an inline comment citing "W-02"
  directly.
- **W-03/05/06/09 (06-15 findings: config.ts raw fetch, missing canonicals on
  gift-card/brand, missing encodeURIComponent, exact-multiple Load-more edge)**
  — confirmed **still open**, unrelated to this round's CF list (carried
  forward as W30-07/08/09; the Load-more edge case W-09 is unchanged and not
  re-numbered since it's purely cosmetic and already self-documented in code).
- No new loader-side-fetch violations of the "web is a pure API client" rule
  were found anywhere in the 40 routes. The only two server-side fetches
  remain `sitemap.tsx` and `home-geo-redirect.tsx`, both already documented
  exceptions; `locale-layout-ssr.tsx` and `not-found-ssr.tsx` loaders are pure
  param validation / unconditional 404 throws with no I/O.
- A genuine CSP now exists (Part-6 item, prior-audit gap): `security-headers.ts`
  builds a real `Content-Security-Policy` (nonce-based `script-src` on SSR via
  `entry.server.tsx`, `'unsafe-inline'` fallback only on the mobile static
  export), delivered as both an HTTP header (full policy, including
  `frame-ancestors 'none'`) and a `<meta>` tag (header-incompatible directives
  stripped) — locked by `security-headers.test.ts`. No CSP gap remains; only
  the stale comment at W30-05.

## Coverage confirmation

**Routes (40/40):**
auth.tsx, brand.$slug.tsx, calculator.tsx, cashback.$slug.tsx, cashback.tsx,
gift-card.$name.tsx, home-geo-redirect.tsx, home.tsx, locale-layout-ssr.tsx,
locale-layout.tsx, map.tsx, not-found-ssr.tsx, not-found.tsx, onboarding.tsx,
orders.$id.tsx, orders.tsx, privacy.tsx, settings.cashback.tsx,
settings.privacy.tsx, settings.wallet.tsx, sitemap.tsx, terms.tsx,
trustlines.tsx (23, direct full read) · admin.\_index.tsx,
admin.assets.$assetCode.tsx, admin.assets.tsx, admin.audit.tsx,
admin.cashback.tsx, admin.merchants.$merchantId.tsx, admin.merchants.tsx,
admin.operators.$operatorId.tsx, admin.operators.tsx, admin.orders.$orderId.tsx,
admin.orders.tsx, admin.payouts.$id.tsx, admin.payouts.tsx,
admin.stuck-orders.tsx, admin.treasury.tsx, admin.users.$userId.tsx,
admin.users.tsx (17, sub-agent narrow-scope read for loader-fetch/fetch-bypass/
secrets/error-swallow/Capacitor-boundary/step-up-consistency only — full admin
vertical depth owned by the sibling admin agent).

**Services (49/49):**
api-client.ts, auth.ts, clusters.ts, config.ts, favorites.ts, geo.ts,
merchants.ts, orders-loop.ts, orders.ts, parse-error-response.ts,
public-stats.ts, recently-purchased.ts, stellar-wallet.ts, user.ts (14, direct
full read) · admin-activity.ts, admin-assets.ts, admin-audit.ts,
admin-cashback-config.ts, admin-cashback-realization.ts, admin-csv.ts,
admin-discord.ts, admin-merchant-activity.ts, admin-merchant-drill.ts,
admin-merchant-flows.ts, admin-merchant-stats.ts, admin-merchants-resync.ts,
admin-monthly.ts, admin-operator-drill.ts, admin-operator-mixes.ts,
admin-operator-stats.ts, admin-orders.ts, admin-payment-method-activity.ts,
admin-payment-method-share.ts, admin-payouts-by-asset.ts, admin-payouts.ts,
admin-settlement-lag.ts, admin-step-up.ts, admin-stuck.ts,
admin-supplier-spend.ts, admin-top-users.ts, admin-treasury.ts,
admin-user-cashback-by-merchant.ts, admin-user-credits.ts, admin-user-drill.ts,
admin-user-fleet-activity.ts, admin-user-home-currency.ts, admin-users-list.ts,
admin-write-envelope.ts, admin.ts (35, sub-agent narrow-scope read).

**i18n / locale / SEO / root / utils (direct full read):**
i18n/format.ts, i18n/locale.ts, i18n/messages.ts, i18n/t.ts, i18n/seo.ts,
i18n/**tests**/{country-model,locale-routing,locale,seo}.test.ts, root.tsx,
routes.ts, entry.server.tsx, utils/locale.ts, utils/security-headers.ts,
utils/sentry-lazy.ts, utils/redeem-message.ts, utils/sentry-scrubber.ts,
utils/**tests**/security-headers.test.ts, utils/**tests**/redeem-message.test.ts.

**Supporting files pulled in by evidence trail (direct full read):**
components/Phase2Gate.tsx, components/ui/LocaleLink.tsx,
components/features/order/OrderPayoutCard.tsx,
components/features/cashback/PendingCashbackChip.tsx,
components/features/cashback/CashbackCalculator.tsx,
components/features/MerchantCard.tsx (imports only re: i18n seam check),
native/share.ts (imports only re: W30-02 evidence),
routes/**tests**/settings.privacy.test.tsx.

ADR 034 (`docs/adr/034-path-based-locale-routing.md`, including the 2026-06-16
"i18n seam status" addendum) re-read in full as part of CF-22 verification.
