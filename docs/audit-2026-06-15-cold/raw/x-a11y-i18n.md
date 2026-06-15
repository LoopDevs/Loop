# Cold Audit — Accessibility + i18n/Localization Completeness Sweep

**Scope:** Whole web (`apps/web/app` — 137 components + 40 routes) + mobile native layer.
**Checklist refs:** §15 (Accessibility), §23 (Internationalization/localization), §32 (UX correctness).
**Method:** grep sweeps (`aria`, `role`, `alt=`, `$`, `en-US`, `toLocaleString`, `refetchInterval`, `onClick`) + full reads of i18n seam (`i18n/{messages,t,format,locale,seo}.ts`, `utils/{money,locale}.ts`, `@loop/shared/money-format.ts`) + two parallel a11y sub-agents (customer components / admin+routes), with manual verification of every cited line.

Finding format: `id · severity · vertical · file:line · description · impact · evidence · fix · ref`.
Each finding tagged **[CONFIRMED]** (independently re-verified a web-ui agent claim) or **[NEW]**.

---

## Coverage

- **i18n seam read in full:** `i18n/messages.ts`, `i18n/t.ts`, `i18n/format.ts`, `i18n/locale.ts`, `i18n/seo.ts`, `utils/money.ts`, `utils/locale.ts`, `packages/shared/src/money-format.ts`, `packages/shared/src/countries.ts`. **VERDICT: the i18n architecture is built but almost entirely unwired.**
- **a11y across all 137 components + 40 routes:** every `components/ui/*`, `components/features/**` (incl. all ~57 admin, all purchase/cashback/orders/onboarding/wallet/home), every `routes/*.tsx`, and `root.tsx` audited for semantics, ARIA, keyboard/focus, focus-traps on every modal/dialog/sheet/listbox, contrast/color-only signaling, SR labels, form labels + error announcement, alt text, reduced-motion, touch targets, skip-links, lang attrs.
- **UX states:** all 10 `refetchInterval` poll surfaces, double-submit guards on every submit button, payment countdown + poll-stop logic (`PaymentStep`, `LoopPaymentStep`) read in full.
- **RTL / multi-locale:** `SUPPORTED_LANGS = ['en']` only — RTL is forward-looking; `<html dir>` never set.

**Confirmed-vs-new split:** ~14 web-ui claims independently re-verified and CONFIRMED (2 of them corrected/downgraded); ~46 NEW findings. Two web-ui claims **refuted** (see Corrections).

---

## P0 — Critical (blocks a core task for keyboard/SR users; or correctness on real traffic)

**A11Y-001 · P0 · web/i18n · components/features/purchase/LoopPaymentStep.tsx:61-71, 116-120, 135-177 · [CONFIRMED]**
The core payment-state label ("Waiting for payment" → "Payment received" → "Buying…" → "Ready") updates via a 3s poll inside a static `<h2>` with **no `aria-live`**; the failed-order banner (:116) and the redemption code/PIN/URL that appears at `fulfilled` (:135) are equally silent. **Impact:** a screen-reader user paying for a gift card gets zero feedback that payment landed or the order completed — the primary loop-native purchase outcome is imperceptible. **Fix:** wrap the state region in `aria-live="polite"`, the failure in `role="alert"`, and move focus / announce the redemption block on `fulfilled`. **Ref:** §15, §32, ADR 010.

**A11Y-002 · P0 · web · components/features/purchase/PaymentStep.tsx:74-94, 284-291 · [CONFIRMED]**
Hard payment-window countdown with **no way to pause/extend/adjust** (WCAG 2.2.1 Timing Adjustable); only recovery is "Start over" after expiry. Expiry block (:284) and "connection issue" banner (:270) also lack `role="alert"`/`aria-live`. **Impact:** AT and motor-impaired users who can't complete the XLM transfer inside the window silently lose the order. **Fix:** announce the countdown periodically via `aria-live`, surface expiry as `role="alert"`, and (WCAG) offer extend or a longer default. **Ref:** §15, §32.

**A11Y-003 · P0 · web · components/features/purchase/PaymentStep.tsx:45, 239-266 · [NEW]**
Single `copied` boolean is shared by **both** copy buttons — copying the address flips _both_ "Copy address" and "Copy memo" to "Copied!" (and vice-versa). This is a real bug for **all** users, not just AT. **Impact:** users mis-believe they copied the memo (a Stellar payment with the wrong/absent memo strands funds at CTX). **Fix:** track copied state per-field (`copiedAddress` / `copiedMemo`) and add `aria-live` confirmation. **Ref:** §32, project_principal_switch_pay_ctx (memo correctness).

**A11Y-004 · P0 · web · components/features/CountrySelector.tsx:99-143 · [CONFIRMED]**
`role="dialog" aria-modal="true"` with **no focus trap** — Tab/Shift+Tab escape to the background page while the modal is open; focus is also **not restored to the trigger** on close (:54-67). The `role="listbox"`/`role="option"` (:117) has **no arrow-key navigation** and no `aria-activedescendant`. **Impact:** the country picker (ADR 034 market switch) is unusable/disorienting for keyboard+SR users. **Correction:** it _does_ auto-focus search on open (:35) and _does_ Escape-to-close (:37) — those web-ui claims were inaccurate. **Fix:** trap focus, restore to trigger, add roving arrow-key listbox nav. **Ref:** §15, ADR 034.

**A11Y-005 · P0 · web · components/features/MapBottomSheet.tsx:122-143, 106-120, 163-198 · [CONFIRMED]**
`role="dialog" aria-modal="true"` with **no focus trap, no initial focus, no focus restoration** to the triggering pin; backdrop is `role="button" tabIndex={-1}` (keyboard-unreachable) with a never-firing `onKeyDown`; the drag handle is a `<div>` with pointer-only handlers; the only dismissal is undiscoverable Escape (:55). **Impact:** the primary purchase surface reached from the map traps keyboard users behind it. **Fix:** focus trap + restore, a real focusable close button, Escape documented. **Ref:** §15.

**A11Y-006 · P0 · web · components/features/ClusterMap.tsx:176-191, 194-300 · [NEW]**
Cluster markers (Leaflet `divIcon`, count-only HTML, `click`-only) and location pins (CSS `background-image`, `marker.on('click')` only) have **no accessible name, no role, no keyboard activation**. `zoomControl: false` (:403) removes the only keyboard-operable zoom. **Impact:** keyboard/SR users cannot perceive, focus, or open any merchant on the map — the entire map-discovery + drill-in flow is blocked. **Fix:** provide a non-map list fallback (or accessible marker buttons with labels + keyboard), restore keyboard zoom. **Ref:** §15.

**A11Y-007 · P0 · web · components/features/onboarding/screen-currency.tsx:80-124 · [NEW]**
`role="radiogroup"`/`role="radio"` with **broken roving tabindex** (every radio gets `tabIndex={active?0:-1}` so all three are simultaneous tab stops) and **no arrow-key navigation** — violates the WAI-ARIA radio keyboard contract. Selected state is also color-only for sighted users (the radio "dot" is `aria-hidden`). **Impact:** the home-currency choice (drives the ledger currency — feedback_admin_only_user_writes) can't be operated per-spec by keyboard users. **Fix:** real roving tabindex + Arrow handling; add a visible non-color selected indicator. Same broken pattern in `settings.wallet.tsx:194-215` and `PurchaseContainer.tsx:394-412` (payment rail) — see A11Y-021.

---

## P1 — High (significant barrier / silent failure on real traffic)

**A11Y-010 · P1 · web · root.tsx:314 + all customer routes · [CONFIRMED]**
**No skip-to-content link** anywhere, and **several customer routes have no `<main>` landmark at all**: `home.tsx`/`MobileHome.tsx` (:115/:322), `gift-card.$name.tsx` (:118 — the conversion page), `brand.$slug.tsx` (:57), `map.tsx` (:50), `auth.tsx` (:425/:514), `onboarding.tsx`. **Impact:** keyboard/SR users tab through the full Navbar (logo, search combobox, nav, country selector, account menu) on every page, with no landmark to jump to and no `<main>` region to land in. **Fix:** add `<a href="#main">` as first focusable in the shared chrome; wrap each route body in `<main id="main">`. **Ref:** §15.

**A11Y-011 · P1 · web · root.tsx:284 · [CONFIRMED]**
`<html lang="en">` is hardcoded and `routes/locale-layout.tsx` never updates `document.documentElement.lang` for the ADR-034 country/lang segment. **Impact:** today benign (only `en` ships) but a forward-block — any `/de/de` etc. would still report `lang="en"`, giving SRs the wrong pronunciation; also no `dir` attr (RTL). **Fix:** set `lang`/`dir` from the active locale in the document layout. **Ref:** §15, §23, ADR 034 §7.

**A11Y-012 · P1 · web · components/features/onboarding/signup-tail.tsx:71-81, 264-289, 84-85, 292 · [NEW]**
The native-onboarding signup form — the primary auth path on mobile — has an **unlabeled email `<input>`** (placeholder only), **six unlabeled OTP `<input>`s** (no "Digit N of 6", no group label), and **email/OTP errors as plain `<div className="text-red-600">`** with no `role="alert"`/`aria-live`/`aria-describedby`/`aria-invalid`. **Impact:** SR users get unnamed fields and never hear "code invalid"/"failed to send". **Fix:** label all inputs, group the OTP fields, route errors through `role="alert"`. **Ref:** §15, §32, ADR 013.

**A11Y-013 · P1 · web · routes/auth.tsx:578, 608 · [NEW]**
Web sign-in email/OTP errors render as plain `<p className="text-red-500">` with no `role="alert"`; the `Input` component's own `error` prop (which would wire `aria-invalid`+`aria-describedby`) is **not** used — the error renders detached and unannounced. **Impact:** SR users on the web auth path don't hear failures. **Fix:** route through `Input`'s `error` prop or wrap in `role="alert"`. **Ref:** §15, §32.

**A11Y-014 · P1 · web · components/features/cashback/CashbackCalculator.tsx:123-134 · [CONFIRMED]**
The calculator's "Rate" / "You'll earn" outputs recompute as the user types but sit in plain `<div>/<span>` with **no `aria-live`** — the entire point of the calculator is silent to SR. **Fix:** `<output>` + `aria-live="polite"`. Same gap on `AmountSelection.tsx:150-154` ("You'll earn X" estimate). **Ref:** §15, §32.

**A11Y-015 · P1 · web · components/features/purchase/PurchaseComplete.tsx:107-208 · [CONFIRMED]**
Post-purchase success screen (the gift card) has **no heading and no `role="status"`/`aria-live`** — merchant name is a styled `<div>` (:118), "Ready" status + redeemable code mount silently. **Impact:** SR users aren't told the purchase succeeded or what the code is. (`<canvas>` barcode at :144 has `aria-label` but no `role="img"`; mitigated by the text code.) **Fix:** add an h1/h2 + `role="status"`. **Ref:** §15, §32.

**A11Y-016 · P1 · web · order/payout polling surfaces · [CONFIRMED]**
Live-polled status with no `aria-live`/`role="alert"` recurs across every async surface: `OrderPayoutCard.tsx:58-66` (30s, payout queued→confirmed→failed), `PendingPayoutsCard.tsx:30-37` (30s), `PendingCashbackChip.tsx:84` (30s), `LoopOrdersList.tsx:118-147` (state + redemption code appears, disclosure not tied to button via `aria-controls`), `StellarTrustlineStatus.tsx` (60s; the amber "missing trustline" warning silently means cashback won't pay — should be `role="alert"`). **Impact:** settlement/payout outcomes never announced. **Fix:** add live regions; warrant `role="alert"` for failure/blocking states. **Ref:** §15, §32, §6.

**A11Y-017 · P1 · web · components/features/AmountSelection.tsx:134-148 · [CONFIRMED]**
Denomination chips are a `<div>` of independent `<button>`s with **no group semantics and no `aria-pressed`/`aria-checked`** — selected state is border/color only; SR users can't tell which amount is chosen. **Fix:** radiogroup or `aria-pressed`. **Ref:** §15.

**A11Y-018 · P1 · web · components/features/Navbar.tsx:187-225, 312-348, 405-420 · [CONFIRMED, partly corrected]**
(a) Search input has **no accessible name** (placeholder only). (b) Account `role="menu"` opens but focus is **not moved into the menu** and there's no arrow-key roving between `menuitem`s (broken menu contract). (c) Desktop nav links signal the active page by **color only** — no `aria-current="page"`. **Correction:** the `role="combobox"`+`aria-activedescendant` search wrapper IS a valid, keyboard-functional ARIA-1.1 pattern — NOT the P0 the web-ui pass implied; only the missing input label is the defect. **Fix:** label the input; implement menu focus/roving or drop `role="menu"`; add `aria-current`. **Ref:** §15.

**A11Y-019 · P1 · web · components/features/onboarding/Onboarding.tsx:438-463 + OnboardingDesktop.tsx:42-56 · [NEW]**
Carousels have no `role`/`aria-roledescription="carousel"` and **no `aria-live`** announcing slide changes; focus is never moved to the newly-active screen on step change, and interactive children of `aria-hidden` inactive slides (email/OTP inputs in signup-tail) **remain tab-focusable inside an `aria-hidden` subtree** (ARIA violation — A11Y-012's inputs are reachable while hidden). **Fix:** carousel roles + live region, move focus per step, `tabIndex={-1}` on inactive-slide controls. **Ref:** §15.

**A11Y-020 · P1 · web · components/features/onboarding/screen-biometric.tsx:203-210 · [NEW]**
Biometric-setup status ("Use Face ID" → "Scanning…" → "Face ID enabled") updates live in plain `<div>`s with no `role="status"`/`aria-live` — the security-setup outcome is not announced. **Fix:** live region. **Ref:** §15, ADR 027.

**A11Y-021 · P1 · web · components/features/purchase/PurchaseContainer.tsx:394-412 + settings.wallet.tsx:194-215 · [NEW]**
Two more `role="radiogroup"`s (payment-rail picker, home-currency picker) with `aria-checked` but **no roving tabindex and no arrow-key nav** — each button is an independent tab stop; arrows do nothing. Order/auth errors in PurchaseContainer (:256/:286/:425) are plain `<p className="text-red-500">` with no `role="alert"`. **Fix:** real radiogroup keyboard pattern; `role="alert"` on errors. **Ref:** §15. (Companion to A11Y-007.)

**I18N-001 · P1 · web/i18n · entire app · [CONFIRMED + expanded]**
**The `t()` translation seam and `messages.ts` catalogue are completely unused — ZERO imports in any component or route.** `messages.ts` holds 7 keys for `en` only and self-describes as "a representative slice, not exhaustive." **Every user-facing string in the app is a hardcoded English literal.** **Impact:** ADR 034 §7's promise that "adding a language is a JSON drop, not a refactor" is false — the entire UI would need extraction first. Pervasive naive inline pluralization (`order/orders`, `brand/brands`, `trustline/trustlines` at `RecentlyPurchasedStrip.tsx:46`, `MobileHome.tsx:338/470`, `CashbackByMerchantCard.tsx:101`, `FlywheelChip.tsx:77`, `StellarTrustlineStatus.tsx:67`, `OrderPayoutCard.tsx:121`, `AdminNav.tsx:144`, etc.) hard-blocks any locale with non-binary plural rules. **Today's live impact is low (only `en` ships)** but the i18n infrastructure is dead weight that gives a false sense of readiness. **Fix:** either extract copy through `t()` per ADR 034 Phase 3, or document the seam as deferred and stop implying readiness. **Ref:** §23, ADR 034.

**I18N-002 · P1 · web/i18n · customer money/number/date formatting · [CONFIRMED + expanded]**
**The route-locale-aware formatting seam (`i18n/format.ts`: `formatCurrency`/`currencySymbol`/`formatNumber`/`localeTag`) is imported by ZERO components.** Instead, customer-facing surfaces format with **hardcoded `'en-US'`** — `CashbackBalanceCard.tsx:18`, `CashbackByMerchantCard.tsx:19`, `CashbackEarningsHeadline.tsx:16`, `MonthlyCashbackChart.tsx:224`, `OrdersSummaryHeader.tsx:46-94`, `RailMixCard.tsx:115`, `LoopOrdersList.tsx:288`, `LoopPaymentStep.tsx:370`, `home/CashbackStatsBand.tsx:14/82/94`, `home/FlywheelStatsBand.tsx:47` — or import `utils/money.ts` (`MerchantCard`, `gift-card.$name`, `AmountSelection`, `EarnedCashbackCard`, `orders.tsx`, `orders.$id.tsx`) whose `currencySymbol` pins `'en'` internally. **Even `@loop/shared/money-format.ts:63` pins `'en-US'` for ALL callers** (its docstring tells user-facing surfaces to "format themselves with `USER_LOCALE`"). And **`USER_LOCALE` (utils/locale.ts:23, the browser-locale escape hatch) is also imported by NOBODY.** **Impact:** a `/de/en` or `/gb/en` visitor sees US grouping/decimals (`€1,234.56` instead of `1.234,56 €`, `$` symbol placement) regardless of route country — defeating ADR 034's "no US flash, market-correct page." (Note: `currencySymbol` does get the _symbol_ right per-currency — £/€/$ — so this is partial, not total, mis-localization.) **Also note** the correct seam is route-driven (`i18n/format.ts`), so even `USER_LOCALE`'s browser-locale intent contradicts ADR 034 — there are THREE competing/abandoned locale seams. **Fix:** wire customer formatters to `i18n/format.ts` keyed on `useLocale()`; delete `utils/money.ts` (overdue — ADR 034 Phase 5) and `USER_LOCALE`. **Ref:** §23, ADR 034.

---

## P2 — Medium (moderate barrier / weak control)

**A11Y-030 · P2 · web · ~40 admin tables · [CONFIRMED]** Nearly every admin data `<table>` is missing `<th scope="col">` (and `scope="row"` on the identifier cell), and almost none has `<caption>`/`aria-label`. Reps: `CreditTransactionsTable.tsx:140`, `MerchantStatsTable.tsx:74/86`, `OperatorStatsCard.tsx:88/100`, `RailMixCard.tsx:93-99` (this one is customer-facing), `admin.assets.tsx:144`, `admin.cashback.tsx:256-261/473-478`, `admin.treasury.tsx:179-285`, `admin.payouts.tsx:268-285`, `admin.stuck-orders.tsx:94/225`, `admin.users.tsx:221`, `admin.users.$userId.tsx:191`. Internal-staff → P2. **Fix:** codemod `scope` + table labels. **Ref:** §15.

**A11Y-031 · P2 · web · routes/admin.orders.tsx:407-532 · [NEW]** Orders list is a div-grid (header `<div>`s + row `<div>`s), not real `<table>`/`<th>` — SR users get no column association on a columnar dataset. **Ref:** §15.

**A11Y-032 · P2 · web · routes/admin.cashback.tsx:507-516 · [NEW]** `PctInput` (`<input type="number">`) editable percentage cells have no `<label>`/`aria-label`. **Ref:** §15, ADR 011.

**A11Y-033 · P2 · web · routes/admin.payouts.tsx:186-216, admin.stuck-orders.tsx:156-164 · [NEW]** Payout filter chips signal active selection by background color only (no `aria-pressed`/`aria-current`; contrast `admin.orders.tsx:148` which does it right). Stuck-orders Age severity (yellow→orange→red) is color-only — only the raw `{ageMinutes}m` shown, no text severity. **Ref:** §15.

**A11Y-034 · P2 · web · app.css (no `@media (prefers-reduced-motion)`) · [CONFIRMED]** Zero reduced-motion guard exists anywhere except `ClusterMap.tsx`. Keyframes (`route-fade-in`, `slide-in-right`, `slide-up`, `tab-ripple`, `loop-user-location-pulse`, `animate-spin/pulse`) and hundreds of `transition-*`/`transform`/`active:scale`/`hover:-translate` classes are unguarded. Strongest vestibular triggers: signup confetti (`signup-tail.tsx:344-424`), spinning biometric ring (`screen-biometric.tsx:139`), bouncy tile reveals (`screens-trust.tsx:240`), full-screen slide translateX (`Onboarding.tsx:445`), map pulse halo (`ClusterMap.tsx:330`). **Fix:** one global `@media (prefers-reduced-motion: reduce)` block. **Ref:** §15.

**A11Y-035 · P2 · web · duplicate alt text · [NEW]** Merchant logo/cover `alt` duplicates the adjacent visible name → double/triple announcement: `MerchantCard.tsx:144/194` (+ h3 :204), `MerchantGroupCard.tsx:77/117`, `MobileHome.tsx:515`, `Navbar.tsx:70` (search row), `atoms.tsx:53`. Decorative logos should be `alt=""`. (CountrySelector flag `alt=""` :165 and PurchaseComplete barcode alt are CORRECT.) **Ref:** §15.

**A11Y-036 · P2 · web · touch targets < 44px · [NEW]** `FavoriteToggleButton` h-8/w-8 (32px, MerchantCard corner), `FixedSearchButton` close h-7/w-7 (28px), `ClusterMap` "Locate me" 40px + credits "i" 28px, `OnboardingDesktop` arrows 40px, `ToastContainer` dismiss glyph, `BackToSite` 36px, `PageHeader` back 40px. **Ref:** §15, §24.

**A11Y-037 · P2 · web · semantic list/landmark gaps · [NEW]** Card grids are `<div>` collections of `<Link>`s, not `<ul>/<li>` (loses count/nav): `FavoritesStrip.tsx:45-83`, `RecentlyPurchasedStrip.tsx:49-89`, `MobileHome.tsx:230-367`, `screens-trust.tsx:147-253`. Stat label/value pairs are unassociated `<div>`s instead of `<dl>/<dt>/<dd>`: `CashbackStatsBand.tsx:81`, `CashbackBalanceCard.tsx:77`, `CashbackEarningsHeadline.tsx:64`, `OrdersSummaryHeader.tsx:67`, `MobileHome.tsx:441-486` (the savings hero — the screen's biggest number is unlabeled). **Ref:** §15.

**A11Y-038 · P2 · web · color-only earning/status emphasis · [CONFIRMED]** Green `+amount` earnings rely on `text-green-*` + a `+`/`−` glyph (often unannounced) with no sr-only "earned"/"spent": `CashbackByMerchantCard.tsx:104`, `MobileHome.tsx:684`, `OrdersSummaryHeader.tsx:72` ("In flight" yellow), `RailMixCard.tsx:87`. (Admin `ReplayedBadge`/`AssetDriftBadge` are CLEAN — text labels.) **Ref:** §15.

**A11Y-039 · P2 · web · async error/empty regions lack live roles · [NEW]** Plain `<p>`/`<div>` (no `role="alert"`/`aria-live`) on load-error/empty across `home.tsx:231`, `calculator.tsx:70`, `cashback.tsx:84-88`, `cashback.$slug.tsx:186`, `map.tsx:54`, `orders.tsx:285`, `orders.$id.tsx:119-138`, `settings.cashback.tsx:225`, `trustlines.tsx:87-91`. Correct pattern already exists (`settings.wallet.tsx:217`, `orders.$id.tsx:322`) — apply uniformly. **Ref:** §15, §32.

**A11Y-040 · P2 · web · heading order · [NEW]** `gift-card.$name.tsx:236+:378` two `<h1>` in DOM at once (breakpoint show/hide, not conditional render); `trustlines.tsx:70→:171` H1→H3 skip (section :95 has no H2); onboarding screens mix `<h1>` (signup) and `<h2>` (currency/wallet-intro) inconsistently; `orders.tsx:222` has no `<h1>` inside `<main>` on web (PageHeader returns null on web). **Ref:** §15.

**A11Y-041 · P2 · web · WCAG 2.2.1 secondary timeout · [CONFIRMED]** `RedeemFlow.tsx:122-128` silently swaps to manual entry after a 5-min WebView timeout with no warning/extension; on swap, focus is not moved to the new heading/input (:138-179). **Ref:** §15.

**A11Y-042 · P2 · web · GoogleSignInButton.tsx:132-137 · [NEW]** `aria-label="Sign in with Google"` is on a non-interactive `<div>` (GSI iframe target) — ineffective; until `ready` the container is `opacity-0` (focusable-but-invisible) with no `aria-hidden`. **Ref:** §15, ADR 014.

**A11Y-043 · P2 · web · charts color-only · [NEW]** `PaymentMethodActivityChart.tsx:100-127` conveys the 4-rail split by color, and the per-day `<li>` `aria-label` gives only the day total — the per-rail breakdown is color-only (the one genuine color-alone gap among the otherwise-clean admin charts, which mostly use `aria-hidden` bars + text fallbacks). **Ref:** §15.

**UX-001 · P2 · web · copy-success silent throughout · [CONFIRMED]** "Copied!" is a visual-only text swap with no live-region announcement across `PaymentStep`, `PurchaseComplete:235`, `LoopOrdersList:233`, `RedeemFlow:199`, `LoopPaymentStep:322` (codes/PINs/addresses — the values most worth confirming). **Ref:** §32.

**I18N-003 · P2 · web/i18n · RTL not handled · [NEW]** No `dir=` attribute is ever set (`root.tsx`/layout) and there's no `getLangDir` helper. Forward-looking only (`SUPPORTED_LANGS=['en']`), but ADR 034 §7 anticipates added languages. **Ref:** §23.

---

## P3 — Low (quality / nit)

- **A11Y-050 · P3** — Decorative SVGs not `aria-hidden`: Navbar search icon (:226), BackToSite chevron, NativeBackButton chevron, `home.tsx:181-220/283-295` feature icons, `gift-card.$name.tsx:169-185` wave/feature SVGs, trailing `→`/`←` glyphs in CTA/back links (`calculator.tsx:98`, `EarnedCashbackCard:69`, `brand.$slug:61`, `trustlines:155`). **[CONFIRMED for several]**
- **A11Y-051 · P3** — `Avatar.tsx:39` `alt={name}` reads the full email aloud when name is an email (verbose/PII-ish). **[CONFIRMED]**
- **A11Y-052 · P3** — `RequireAdmin.tsx:60` bare `<Spinner/>` for the `/me` fetch is fine (Spinner has internal `role="status"`); denied state correctly `role="alert"`. **[CONFIRMED — minor]**
- **A11Y-053 · P3** — Multiple unlabeled `<nav>` landmarks (Footer:18, NativeTabBar:131) make landmark navigation ambiguous. **[NEW]**
- **A11Y-054 · P3** — `Onboarding.tsx:472` disabled CTA `disabled:bg-gray-300 disabled:text-white` ≈ 1.5:1 contrast (fails 4.5:1 even for disabled). **[NEW]**
- **A11Y-055 · P3** — External `target="_blank"` links with no "opens in new tab" cue: `PendingPayoutsCard:136`, `OrderPayoutCard:101`, `trustlines:124-145`. **[NEW]**
- **A11Y-056 · P3** — `CreditFlowChart.tsx:83` / `SupplierSpendActivityChart.tsx:80` `role="tablist"` without Arrow roving-tabindex (buttons stay operable). **[NEW]**
- **A11Y-057 · P3** — `not-found.tsx` h1 is the glyph "404" rather than "Page not found". **[NEW]**
- **UX-002 · P3** — `MobileHome` `PctPill` (:585) renders a bare "5.0%" with no label distinguishing savings vs cashback vs interest (color-coded only). **[NEW]**

---

## Corrections to the web-ui pass

1. **Spinner is NOT bare** — `components/ui/Spinner.tsx` carries `role="status"` + sr-only "Loading" internally. **Every "bare Spinner has no role/label" finding is a false positive.** Loading states are announced.
2. **Navbar search is NOT a P0** — the `role="combobox"` + `aria-activedescendant` wrapper is a valid, keyboard-functional ARIA-1.1 pattern. The only real defect is the missing input _name_ (A11Y-018).
3. **CountrySelector partials** — it _does_ auto-focus search on open and _does_ Escape-to-close (web-ui implied otherwise); the real gaps are focus-trap, focus-restore, and listbox arrow-keys (A11Y-004).
4. **`<main>` is per-route, not in the layout** — by design; so the gap is the _routes that omit it_ (A11Y-010), not the layout.
5. **Admin dialogs are CLEAN** — `ConfirmDialog`/`ReasonDialog`/`StepUpModal` use native `<dialog>`+`showModal()` (free focus-trap/Escape/aria-modal), set `aria-labelledby`, manage initial focus, restore on close. Not findings.

---

## Summary

| Severity | Count | Theme                                                                                                                                                                                                                                                                                                 |
| -------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0**   | 7     | Payment-status not announced (×2) + WCAG timing limit; dual copy-button bug (memo-strand risk); 3 unusable modals/maps for keyboard (CountrySelector, MapBottomSheet, ClusterMap); broken radiogroup keyboard (currency)                                                                              |
| **P1**   | ~12   | No skip-link + missing `<main>` on key routes; hardcoded `<html lang>`; unlabeled onboarding/auth inputs + silent errors; **dead i18n seams (t() + format.ts + USER_LOCALE all unused) → all copy hardcoded en-US**; calculator/success live-region gaps; broken account-menu + payment-rail keyboard |
| **P2**   | ~16   | ~40 admin tables missing `scope`; no global reduced-motion; duplicate alt; <44px targets; list/dl semantics; color-only emphasis; async regions lack live roles; heading order; RTL/`dir` absent                                                                                                      |
| **P3**   | ~9    | decorative-SVG aria-hidden, contrast nits, new-tab cues, tablist keyboard                                                                                                                                                                                                                             |

**New vs confirmed:** ~46 NEW, ~14 CONFIRMED (2 corrected/downgraded), 2 web-ui claims refuted (Spinner, combobox).

**Headline verdict.** Two separate but reinforcing failures:

- **a11y:** the _purchase + payment + onboarding-auth_ happy paths — the only flows that move money — are the **least accessible** surfaces (no live regions on the polled state, unlabeled OTP/email, broken radiogroups, a WCAG timing limit, and the dual-copy bug that can strand a Stellar payment). Static marketing/legal pages and admin dialogs are comparatively clean.
- **i18n:** the app ships a full locale architecture (`t()`, `messages.ts`, `i18n/format.ts`, `USER_LOCALE`) that is **entirely unwired** — every string is hardcoded English and every customer amount is formatted `en-US`, so ADR 034's "market-correct page" is only true for the `<title>`/meta, not the rendered UI. Live impact today is low (one language, mostly USD/GBP/EUR symbols render correctly), but the infrastructure signals a readiness that doesn't exist. The honest move is either to wire it (ADR 034 Phase 3) or mark it explicitly deferred.
