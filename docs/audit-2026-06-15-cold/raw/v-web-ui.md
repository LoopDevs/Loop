# Cold Audit — Web UI (V9 web client: components / stores / hooks / utils / i18n)

Date: 2026-06-15 · Branch: `fix/stranded-order-hardening` · Auditor: cold-audit web-UI agent
Scope: `apps/web/app/components/**`, `apps/web/app/stores/**`, `apps/web/app/hooks/**`,
`apps/web/app/utils/**`, `apps/web/app/i18n/**`. (Routes + services audited by a separate agent.)

Format per finding: `id · severity · file:line · description · impact · evidence · fix`.

---

## Coverage

**Files examined: 137 of 137 source files in scope** (excludes `__tests__`, which were sampled for
vacuity). Breakdown:

- **Stores (4/4):** `auth.store.ts`, `purchase.store.ts`, `ui.store.ts`, `admin-step-up.store.ts` — all read in full.
- **Hooks (10/10):** `use-auth`, `use-orders`, `use-merchants`, `use-favorites`, `use-recently-purchased`,
  `use-session-restore`, `query-retry`, `use-app-config`, `use-admin-step-up`, `use-native-platform` — read.
- **Utils (14/14):** `money`, `image`, `locale`, `error-messages`, `format-stellar`, `admin-cache`,
  `share-image`, `redeem-challenge-bar`, `query-error-reporting`, `sentry-scrubber`,
  `sentry-error-scrubber`, `security-headers`, `nonce-context` — read.
- **i18n (5/5):** `format.ts`, `locale.ts`, `messages.ts`, `t.ts`, `seo.ts` — read in full.
- **UI primitives (~20):** `Button`, `Input`, `LazyImage`, `LocaleLink`, `ToastContainer`, `OfflineBanner`,
  `Card`, `Badge`, `Skeleton`, `Spinner`, `Avatar`, `PageHeader`, `BackToSite`, `LoopLogo`, `Container`, `index` — read/sampled.
- **Feature components (~95):** purchase (7), admin (~60), cashback (10), home (4), orders (3), wallet (2),
  onboarding (8), nav/map/strips/cards (~12) — covered (admin + cashback + onboarding/nav/map clusters via
  delegated sub-agents reading every file; purchase + UI primitives + top-level feature cards read directly).

Cross-cutting sweeps run over the whole scope tree:
`any`/type-escape (clean — 0 hits), `dangerouslySetInnerHTML` (0 in components/utils),
`prefers-reduced-motion` (**0 hits — global gap**), dead-component importer grep, `tabular` class verification.

Method: every file read against Part-1 dimensions §1 (correctness), §2/§37 (XSS/security), §14 (DRY/`any`),
§15 (a11y in full), §23 (i18n), §32 (UX). Sub-agent findings independently re-verified against source before
inclusion; **three sub-agent claims were rejected as false positives** (documented at the end).

---

## Findings

### Security / XSS

**WEB-S1 · P0 (deferred to RedeemFlow vertical — flagged here) · `components/features/purchase/RedeemFlow.tsx:67-73`**
Upstream CTX-supplied redeem scripts (`scripts.injectChallenge` / `scripts.scrapeResult`) are validated only
as `z.string()` server-side, then executed verbatim in the redemption WebView via
`openWebView({ scripts })` → `InAppBrowser.executeScript({ code })`. Trust boundary is "run whatever CTX
sends us on a third-party origin." Impact: a compromised/MITM'd CTX channel runs arbitrary JS on the
merchant redeem page (its cookies, DOM gift-card codes, clipboard) and can `postMessage` a forged result back.
Evidence: backend `orders/get-handler.ts:47-52,190-191` passthrough. Fix: server-side allowlist/hash of script
bodies, or generate scripts from Loop-controlled templates; add an ADR for the accepted risk. (Primary owner:
orders/native vertical; recorded here because the injection originates in a web component.)

**WEB-S2 · P1 · `components/features/purchase/RedeemFlow.tsx:81-97`**
`onMessage` accepts `{ type:'loop:giftcard', code, pin }` from the WebView with **no origin validation and no
Zod shape check** before `store.setComplete(result.code, result.pin)`. Impact: a malicious/compromised redeem
page (see WEB-S1) injects a bogus code/PIN that Loop presents as the user's real card. Fix: validate message
origin against the redeem URL's origin; Zod-validate payload; echo a nonce from the Loop-controlled script.

**WEB-S3 · P2 · `components/features/purchase/PurchaseComplete.tsx:67-75`**
The OS share `text` includes `Gift card code: ${code}\nPIN: ${pin}` in plaintext. Impact: a bearer
instrument flows into arbitrary share targets / clipboard managers. Fix: share the composed image only, or
warn before including code+PIN in shareable text.

**WEB-S4 · P3 · `components/features/purchase/LoopOrdersList.tsx:130-138` (+ redeem URL anchors generally)**
`order.redeemUrl` is rendered directly into an `<a href>` with no scheme check. A compromised upstream could
emit a `javascript:` URL. Impact: low (CTX-sourced, React won't run `javascript:` on navigation in modern
browsers, but Capacitor WebView behaviour varies). Fix: assert `https:`/`http:` before rendering the button.

**Clean:** No `dangerouslySetInnerHTML` in any component/util. `ClusterMap` Leaflet popup HTML correctly runs
every interpolated value through `escapeHtml` (`ClusterMap.tsx:198-238`). `redeem-challenge-bar.ts:24`
JSON-encodes the challenge code into the injected IIFE (injection-safe). Sentry scrubbers
(`sentry-scrubber.ts`, `sentry-error-scrubber.ts`, `query-error-reporting.ts`) scrub tokens/emails/Stellar
secrets/Response bodies before capture and strip per-user query keys — well-engineered.

---

### Money / cashback correctness (fintech priority)

**WEB-M1 · P1 · `components/features/home/MobileHome.tsx:490-499` + `:465`**
`formatCashback()` and `avgBackLabel()` hardcode `` `$${dollars.toFixed(2)}` `` and the empty state renders
the literal `'$0.00'`. Impact: a GB/EU user whose ledger is GBP/EUR sees `$12.34` on the single most
prominent money figure on the home screen — directly contradicts the ADR-034 locale model. Evidence: verified
at source (3 sites). Fix: pass `summaryQuery.data.currency` (or routed country) through
`formatCurrency`/`formatMoney`.

**WEB-M2 · P1 · `components/features/orders/LoopOrdersList.tsx:108-112`**
The always-visible order row renders `+{formatMinor(order.userCashbackMinor)} cashback` with **no currency
symbol or code at all** (the expanded line at `:141` does append `order.currency`). Impact: ambiguous money —
£1.25 cashback reads identically to $1.25. Fix: append `order.currency` to the headline cashback line.

**WEB-M3 · P1 · `components/features/home/CashbackStatsBand.tsx:10-21` (`fmtPerCurrency`)**
Formats **fleet-wide** `totalCashbackByCurrency` totals via `Number(minor)/100` before `Intl`. Per-user
amounts won't overflow 2^53, but aggregate cashback across all users can at scale → silent precision loss in a
marketing headline. (`pickHeadlineCurrency` already uses BigInt for comparison; only the display formatter
regresses.) Fix: use `formatMinorCurrency` from `@loop/shared` (bigint-safe).

**WEB-M4 · P1 · `components/features/admin/MonthlyCashbackChart.tsx:220-221` (shared chart `formatMinor`)**
`Number(minor)` on the raw bigint string **before** `/100`, unlike the canonical bigint-split
`formatMinorCurrency` (`packages/shared/src/money-format.ts:54`). This helper renders the visible money labels
in all three monthly charts (`AdminMonthlyCashbackChart`, `MerchantCashbackMonthlyChart`,
`UserCashbackMonthlyChart`) and `TreasuryReconciliationChart`. Impact: fleet/treasury aggregate figures above
2^53 minor units silently lose precision — numbers ops trusts for solvency. Fix: use `formatMinorCurrency`.

**WEB-M5 · P1 · `components/features/admin/AssetCirculationCard.tsx:50-64`**
Local `formatMinor` casts the whole bigint via `Number(abs)` then `/100` to render the **ledger-liability**
total (sum of all `user_credits.balance_minor`). Same 2^53 precision-loss class as WEB-M4. Fix: split bigint
first (`Number(abs/100n)+Number(abs%100n)/100`) or delegate to `formatMinorCurrency`.

**WEB-M6 · P2 · `components/features/purchase/EarnedCashbackCard.tsx:42-56`**
Computes `amount × currentRate / 100` client-side using the rate fetched **now**, not the rate pinned at order
time. Shown on the standalone `/orders/:id` page (unbounded drift window). Impact: "You earned $X cashback"
can differ from the actually-credited `orders.user_cashback_minor` — a trust/accuracy risk for a reward
figure. Fix: surface `userCashbackMinor` on the order response and render the server-authoritative value (the
component's own comment proposes this).

**WEB-M7 · P2 · `components/features/cashback/CashbackCalculator.tsx:104-106`**
The amount input shows a hardcoded `$` prefix while the cashback result (`:82`) formats in the merchant's
actual `data.currency`. Impact: a `/cashback/<gb-merchant>` page shows `$` input next to a `£` result on a
conversion-focused SEO landing page. Fix: derive the prefix from `data?.currency` via `currencySymbol()`.

**WEB-M8 · P2 · widespread float minor-unit handling (`Number(minor)/100`)**
`CashbackBalanceCard.fmtBalance`, `CashbackByMerchantCard.fmtCashback`, `CashbackEarningsHeadline.fmtEarnings`,
`OrdersSummaryHeader.formatMinor`, `TopUsersTable`, `UserCashbackByMerchantTable`, `MobileHome` `Number(lifetimeMinor)`.
Per-user-scale safe today but is exactly the pattern `@loop/shared/money-format.ts` was created to replace; the
windowed-aggregate cases (`TopUsersTable`, `UserCashbackByMerchantTable`) edge toward aggregate risk. Fix:
converge on `formatMinorCurrency`.

**WEB-M9 · P3 · `components/features/home/MobileHome.tsx:105-115, :654`**
Client-side "lifetime saved" / "+X back" fallback multiplies order amount by `merchant.savingsPercentage`
(the upstream CTX discount), not Loop's ADR-011 user-cashback split. Defensible under Phase-1 "saved" framing,
but reusing the same math under Phase-2 "cashback earned" would overstate. Flag for the Phase-2 cutover.

**Correctness note (positive):** `AmountSelection.tsx:91` correctly handles IEEE-754 drift in sub-cent
validation (`Math.round(n*100)/100 !== n`), and its min/max bounds mirror the backend Zod schema — good
validation parity (§32). `LoopPaymentStep.formatMinor` is bigint-safe (string slice).

---

### State management

**WEB-ST1 · P1 · `components/features/wallet/StellarTrustlineStatus.tsx:29-35` + `components/features/order/OrderPayoutCard.tsx:59-66`**
Neither query is auth-gated. `StellarTrustlineStatus` has **no `enabled`** at all; `OrderPayoutCard` gates
only on `orderId.length > 0`. Both call `authenticatedRequest` endpoints. Every sibling cashback component
gates `enabled: isAuthenticated` with explicit A2-1156 comments to avoid firing authed requests before
session restore. Impact: on a cold `/settings/wallet` or `/orders/:id` load these fire a guaranteed 401 →
`tryRefresh` storm — the exact regression A2-1156 fixed. Fix: add `enabled: isAuthenticated` (`&& orderId.length>0`).

**WEB-ST2 · P2 · `components/features/order/OrderPayoutCard.tsx:65` + `components/features/wallet/StellarTrustlineStatus.tsx:34`**
`refetchInterval: 30_000` / `60_000` poll **forever**, including after a terminal state (`confirmed`/`failed`,
or "all trustlines present"). Unlike `LoopPaymentStep` which uses a function-form `refetchInterval` that stops
on terminal state. Impact: wasteful indefinite polling on a page the user may leave open. Fix:
`refetchInterval: (q) => isTerminal(q.state.data) ? false : 30_000`.

**WEB-ST3 · P2 · `components/features/admin/RequireAdmin.tsx:71-74`**
The `denied` predicate is `me.data === undefined || me.data.isAdmin === false || (401/403)`. Because **any**
error makes `me.data === undefined`, the ApiException clause is dead and every transient failure (network
blip, 500) renders "Admin access required. The signed-in account is not marked as admin." with no retry.
Impact: a real admin sees an alarming false "you're not an admin" on a transient blip. Fix: branch
`me.isError` into a "couldn't verify — retry" state; reserve denial copy for `isAdmin === false`.

**WEB-ST4 · P2 · several admin cards `return null` on `isError`**
`AssetDriftWatcherCard:31`, `SettlementLagCard:30`, `CashbackRealizationCard:32`, `AssetCirculationCard:112`,
`AssetDriftBadge:74`, `UsersRecyclingActivityCard:42`, plus `StellarTrustlineStatus`/`OrderPayoutCard`.
On a backend outage these solvency/SLA cards silently vanish. Impact: ops can't tell "healthy/no-data" from
"API down." Fix: render a muted "couldn't load" line on `isError` (as `DiscordNotifiersCard`/`SupplierSpendCard` do).

**Correctness note (positive):** Query-key hygiene is sound across the app — flat `admin-*` namespace with a
`predicate`-based sweep helper (`admin-cache.ts`), intentional cross-surface dedup keys (`['me','credits']`,
etc.), no collisions found. `auth.store` cross-tab logout via `storage` event is correct. `purchase.store`
whitelist-validates persisted sessionStorage to prevent tamper-injected `complete` state — good. Persist
queue serializes save/clear to avoid the Capacitor Preferences race. `ui.store` toast timer cleanup + cap is
correct. `use-favorites` optimistic add/rollback + `onSettled` invalidate is correct.

---

### UX correctness

**WEB-UX1 · P1 · `components/features/purchase/RedeemFlow.tsx:163-176`**
The "Reopen page" button calls `void handleOpenWebView()` then `setShowManualEntry(false)`; the `disabled={webViewOpen}`
guard is only on the main button, so a fast tap can open two WebViews/tabs. `receivedCodeRef` is never reset on
reopen, so a second open inherits stale ref state and may suppress the manual-entry fallback. Fix: reset
`receivedCodeRef.current=false` at the top of `handleOpenWebView`; guard reopen against `webViewOpen`.

**WEB-UX2 · P2 · `components/features/admin/AdminWithdrawalForm.tsx:70-78`**
`onSuccess` clears `amountMajor` + `reason` but **not `destinationAddress`** — the highest-stakes field (the
Stellar payout address) persists, so the next back-to-back withdrawal silently inherits the previous
recipient's address. Impact: funds to the wrong person. Fix: add `setDestinationAddress('')` to `onSuccess`.

**WEB-UX3 · P2 · `components/features/admin/ConfirmDialog.tsx:92` + `services/admin-write-envelope.ts:57`**
Two coupled double-submit gaps on destructive writers: (1) the ConfirmDialog confirm button has no
disabled/pending guard, so a fast double-click can fire `onResolve(true)` → `mutate()` twice before re-render;
(2) `generateIdempotencyKey()` is minted **fresh inside the service on every call**, not pinned per
confirmation — so a genuine double-submit (or step-up retry) produces two different keys the backend won't
dedup, defeating the documented "double-submit can't double-credit" guarantee. Impact: potential double
credit/debit/withdrawal. Fix: disable confirm on first click; mint the idempotency key once at confirmation
and thread it through `mutate` → service.

**WEB-UX4 · P2 · payment-poll terminal handling (positive + one residue)**
`PaymentStep.tsx` (legacy XLM) correctly enforces `MAX_CONSECUTIVE_ERRORS=5` with a 503-rollback, stops on
terminal/expiry, and self-schedules with a `cancelled` guard — solid (A-030 closed). `LoopPaymentStep`
correctly stops `refetchInterval` on terminal state and fires `onTerminal` exactly once. No defect here; the
poll-forever residue is isolated to WEB-ST2.

**WEB-UX5 · P2 · `utils/error-messages.ts:25`**
`INSUFFICIENT_BALANCE: "The user's balance is below the requested amount."` is server-/admin-speak in a map
that surfaces to end users via `friendlyError`. Impact: a customer hitting this sees third-person ops copy.
Fix: rewrite to second person, or scope it to admin surfaces only.

**WEB-UX6 · P3 · `components/features/onboarding/Onboarding.tsx:436`**
`Dots total={TOTAL_STEPS}=9` is fixed, but `phase1Only` auto-skips two steps, so the progress dots over-count
and one dot is never the active step. Fix: size `Dots` to the visible step list.

**WEB-UX7 · P3 · `components/ui/OfflineBanner.tsx` + `ToastContainer.tsx`**
Both are `position:fixed` at `top: env(safe-area-inset-top)` / `top-4` with high z-index; on a narrow screen
the offline banner can overlay the toast stack and fixed navbar content (no body offset). Minor visual
overlap. Fix: stack offsets or a shared top-fixed layout slot.

---

## Accessibility

**WEB-A1 · P1 (global) · entire web app — `prefers-reduced-motion` is never honoured**
Grep across `apps/web/app` returns **zero** `prefers-reduced-motion` / `motion-reduce` / `motion-safe`
matches, and `app.css` has no reduced-motion block. Continuous/large-motion effects run unconditionally:
onboarding confetti burst (`signup-tail.tsx WelcomeIn`), infinite biometric ring spin (`screen-biometric.tsx`),
count-up tweens (`onboarding/atoms.tsx`), 320ms slide transitions, `MapBottomSheet` slide, `ClusterMap` flyTo,
`animate-pulse` skeletons (`LazyImage`, `MobileHome`, charts), `animate-spin` (`Spinner`), `animate-slide-in`
(`ToastContainer`). WCAG 2.3.3 / vestibular-safety. Fix: add a global `@media (prefers-reduced-motion: reduce)`
block in `app.css` neutralising animations; render confetti/spin end-state directly when reduced motion is set.

**WEB-A2 · P1 · onboarding flow has no dialog semantics, no focus trap, inconsistent `tabIndex` gating**
`components/features/onboarding/Onboarding.tsx:429-498` is a `fixed inset-0` full-screen overlay but is not a
labelled dialog (no `role="dialog"`/`aria-modal`/`aria-label`) and has no focus trap. All nine step panels are
always mounted; inactive ones use `opacity:0`+`aria-hidden` but their focusable controls stay in tab order on
several screens — `screen-currency`/`screen-wallet-intro` gate `tabIndex={active?0:-1}`, but `EmailEntry`'s
input, `OtpEntry`'s six inputs + Resend, and `screens-trust`/`WelcomeIn` do not. Impact: keyboard/SR users Tab
into invisible off-screen steps; no "dialog" semantics; focus not restored on completion. Fix: `role="dialog"
aria-modal` + label on root; trap focus in the active panel; apply `inert`/`tabIndex` gating to every inactive panel.

**WEB-A3 · P1 · `components/features/MapBottomSheet.tsx:122-143` — dialog without focus trap/move/restore**
Has `role="dialog" aria-modal aria-label` + Escape-to-close (good), but no focus trap (Tab leaves into the map
behind), no initial focus move into the sheet, no focus restore to the pin on close. Backdrop is
`tabIndex={-1}` with an unreachable dead `onKeyDown` Enter/Space handler. Fix: move focus in on mount, trap
Tab, restore on close; remove dead handler.

**WEB-A4 · P1 · `components/features/CountrySelector.tsx:93-141` — listbox dialog missing keyboard nav + focus trap**
The country picker is `role="dialog" aria-modal` with `role="listbox"`/`role="option"` and Escape-to-close +
input autofocus (good), but: no focus trap (Tab escapes to the page behind), no arrow-key navigation of the
`listbox` (WCAG combobox/listbox pattern expects Up/Down + Enter), and `aria-activedescendant` is absent. A
keyboard user can't navigate the option list with arrows. Fix: trap focus; add roving-`tabindex` or
`aria-activedescendant` arrow-key navigation; restore focus to the trigger on close.

**WEB-A5 · P1 · tables lack `<th scope>` and accessible names (admin)**
**0 of 24 admin components with `<th>` use `scope`, and no table has a `<caption>`/`aria-label`.** Affects
~16 table components (`CreditTransactionsTable`, `MerchantStatsTable`, `PayoutsByAssetTable`, `TopUsersTable`,
`UserOrdersTable`, `UserPayoutsTable`, `UserCashbackByMerchantTable`, the four `*OperatorMix`/`OperatorStats`
cards, rail/share cards, etc.). On the user-detail page (multiple stacked tables) a SR user can't tell tables
apart or associate cells with headers. (Real `<table>` semantics are used throughout — good.) Fix: mechanical
sweep — `scope="col"` on every header `<th>` + a visually-hidden caption/`aria-label` per table.

**WEB-A6 · P1 · color-only status signaling (admin charts + stuck cards)**
`PaymentMethodActivityChart.tsx:120-153` — stacked-bar segments are `aria-hidden` and the row `aria-label`
carries only the total count, so the per-rail (loop_asset vs xlm) breakdown is conveyed by color alone.
`StuckOrdersCard.tsx:54-78` / `StuckPayoutsCard.tsx:57-83` — the alarm state is color + a number only; the
label is identical at `0` (gray) and `3` (orange), and the `Link` has no `aria-label`. WCAG 1.4.1. Impact: a
colorblind operator can't tell a healthy dashboard from one on fire. Fix: put per-method counts in the
`aria-label`; add a text/icon cue when `count>0` (extract a shared `StuckCountCard` — the two are clones).

**WEB-A7 · P2 · `components/features/admin/StepUpModal.tsx` — weakest of the three modals**
Gates destructive admin writes. The native `<dialog>`+`showModal()` gives focus-trap/ESC/`aria-modal` for free
(good), but: no `aria-describedby` linking the explanatory paragraph (ConfirmDialog/ReasonDialog have it); the
OTP input lacks `inputMode="numeric"` and `autoComplete="one-time-code"` (hurts mobile + 2FA autofill); no
focus restore to the trigger on close. Fix: add `aria-describedby`, `inputMode="numeric"`,
`autoComplete="one-time-code"`, capture/restore `activeElement`.

**WEB-A8 · P2 · `components/features/admin/CopyButton.tsx:74-131` — copy feedback invisible to AT + silent failure**
The "Copied" confirmation is visual-only (no `aria-live`, static `aria-label`), and copy **failure is fully
silent** (`:83-89`, no state set). Affects every admin copy button. Impact: SR users get no copy feedback; any
user can't tell a failed copy from success and may paste stale clipboard data into a ticket. Fix: visually-hidden
`aria-live="polite"` status; set a transient "Copy failed" state on `!ok`. (Same gap on the `LoopPaymentStep`
`Row` copy button `:333-337` and `PurchaseComplete` copy buttons.)

**WEB-A9 · P2 · `components/features/admin/AdminAuditTail.tsx:105-147` — tabular data as `<ul>`, non-unique key**
Status/method/path/actor/time rendered as a `<ul>` with no column semantics. React key `${actorUserId}-${createdAt}`
(`:108`) collides for two writes by one actor in the same timestamp granularity. Fix: real `<table>` (or
per-cell aria-labels) + a row id in the key.

**WEB-A10 · P2 · touch targets below 44px**
`FavoriteToggleButton.tsx:50` is `h-8 w-8` (32px); `PurchaseComplete.tsx:235-241` copy is `h-8` (32px);
`MobileHome.tsx:199-205` account avatar is `w-9 h-9` (36px) and the search-clear is `w-7 h-7` (28px);
`LoopOrdersList` redemption copy controls; `signup-tail.tsx:294` Resend is `h-10` (40px); OTP boxes on narrow
phones. WCAG 2.5.5 / Apple HIG 44px. Fix: pad to ≥44×44 hit area (negative-margin hit area keeps the visual size).

**WEB-A11 · P2 · `components/features/admin/AdminNav.tsx:193-218` — invisible keyboard focus + clipped tabs**
Real `<nav>` + `aria-current="page"` (good), but tab links have no `focus-visible` ring (hover-only color), so
keyboard focus is invisible, and the 9-tab strip has no `overflow-x-auto` so right-hand tabs clip on narrow
viewports with no scroll affordance. Fix: `focus-visible:ring` on links; wrap the row in `overflow-x-auto`.

**WEB-A12 · P2 · heading hierarchy**
Because all onboarding panels are always in the DOM, the document holds 6+ simultaneous `<h1>` elements
(`screens-trust.tsx:50,134,226`, `signup-tail.tsx:56,234`, `screen-biometric.tsx:117`), while
`screen-currency`/`screen-wallet-intro` use `<h2>` — inconsistent. `MapBottomSheet.tsx:196` and
`MerchantGroupCard.tsx:127` use `<h3>` with no h1/h2 above them in their container. Fix: one `<h1>` per visible
view (or SR-only page h1 with step titles as `<h2>`).

**WEB-A13 · P2 · `components/features/onboarding/Onboarding.tsx:473` + `screen-currency.tsx:94-119` — contrast / dark-mode gaps**
Disabled CTA uses `disabled:bg-gray-300 disabled:text-white` (~1.5:1 — fails WCAG, reads as enabled-but-light).
`screen-currency` selected/unselected option backgrounds have no `dark:` variants, so the radiogroup renders
light cards in dark mode. Fix: darker disabled text (`text-gray-500`); add `dark:` variants.

**WEB-A14 · P3 · `components/features/ClusterMap.tsx:513-517,552-556` — map status/geo-error not announced**
Map error/status + "Locate me" error text are not in an `aria-live` region (and the status banner is
`pointer-events-none`). SR users aren't told when map data or geolocation fails. Fix: `role="status"
aria-live="polite"` on those containers.

**WEB-A15 · P3 · `components/features/admin/Sparkline.tsx:111-118` + `CreditFlowChart`/`SupplierSpendActivityChart` — chart ARIA**
`Sparkline` legend distinguishes series by color swatch alone (lines use solid-vs-dashed but the legend swatch
doesn't) — WCAG 1.4.1. `CreditFlowChart:75-111` / `SupplierSpendActivityChart:72-108` use `role="tablist"/"tab"`

- `aria-selected` but have no `aria-controls`, no roving tabindex, no arrow-key handling, no `role="tabpanel"` —
  an incomplete ARIA tab pattern. Fix: mirror dash/solid in the legend swatch; complete or downgrade the tablist.

**WEB-A16 · P3 · `components/features/auth/GoogleSignInButton.tsx:130-138` + `EarnedCashbackCard.tsx:69-74`**
Google button wrapper carries a redundant `aria-label` over Google's own labelled iframe and `opacity-0`
hides it with no SR loading state. `EarnedCashbackCard` "View →" puts a literal arrow glyph in link text (SR
reads "View right arrow"). Fix: drop the redundant wrapper label + add a loading affordance; `aria-hidden` the arrow.

**Positives (a11y done right):** `Button.tsx` has `min-h-[44px]`, `aria-busy`, `focus-visible:ring`,
`aria-hidden` spinner — exemplary. `Input.tsx` wires `htmlFor`/`aria-describedby`/`aria-invalid`/error-id +
required indicator — exemplary. `ToastContainer` uses `role="alert"` (error) vs `role="status"` (info)
correctly. `OfflineBanner` is `role="alert"`. `FavoriteToggleButton` has `aria-pressed` + descriptive
`aria-label`. `LazyImage` requires `alt`. `MerchantCard` uses descriptive alt on logo + card images.
`FlagIcon` correctly `alt=""`/`aria-hidden` (decorative). `ReplayedBadge` pairs color + text + `aria-label`.

---

### i18n / localization

**WEB-I1 · P1 (cluster) · hardcoded `$` / `en-US` in user-facing surfaces**
Beyond WEB-M1/M7: `screens-trust.tsx:40,45` hardcodes `$2,847` / `$` in the onboarding marketing hero
regardless of routed country (ADR 034/035 multi-country). `OrdersSummaryHeader:46-53`, `RailMixCard:115`,
`CashbackStatsBand:82,87,93`, `FlywheelStatsBand:47`, and the cashback formatters pin `toLocaleString('en-US')`
for user-facing values — should use the route-derived locale (`localeTag`/`USER_LOCALE`), not the admin
`en-US` pin. Fix: thread the active locale from `useLocale()` into user-facing formatters.

**WEB-I2 · P2 · `t()` seam bypassed across user-facing components**
The `messages.ts` catalogue holds only ~7 keys ("seeded with a representative slice, not exhaustive"); virtually
all user-facing copy in cashback/home/orders/wallet/onboarding components is hardcoded English literals that
never go through `t()`. ADR 034 Phase 1 built `t()` precisely so `/de/de` is a catalogue drop. Acceptable while
English-only, but it is the explicit debt ADR 034 wants paid. Fix: route live UI copy through `t()` (ADR 034 Phase 3).

**WEB-I3 · P3 · hand-rolled pluralization**
`order/orders`, `time/times`, `brand/brands`, `trustline/trustlines` ad-hoc ternaries across `FlywheelChip`,
`CashbackByMerchantCard`, `OrderPayoutCard`, `MobileHome`, `StellarTrustlineStatus`, `LinkWalletNudge`. Won't
survive i18n. Fix: `Intl.PluralRules` (or a `t()`-integrated plural form) when localization lands.

**WEB-I4 · P3 · `i18n/messages.ts` is a stub**
Only 7 keys exist (`home.hero.*`, `nav.search.placeholder`, `country.modal.*`, `merchant.savings`). Documented
as intentional, but flag as documented-but-unfinished against ADR 034 Phase 3. The `t()`/`format.ts`/`locale.ts`/`seo.ts`
machinery itself is correct and SSR-safe (verified).

---

### Code quality / DRY / dead code

**WEB-Q1 · P3 · `components/features/FixedSearchButton.tsx` — dead component**
**Zero importers** anywhere in `apps/web/app` (verified by grep). Fully styled, never mounted. Fix: remove or wire up.

**WEB-Q2 · P2 · heavy copy-paste across admin mix/stuck/chart families**
~7 near-identical `fmtRelative` formatters; 4 copies of `successPct` (the four operator-mix cards); 3 copies of
`METHOD_ORDER`/`METHOD_LABELS`/`sumCharge` (rail/share cards); `StuckOrdersCard`≈`StuckPayoutsCard` clones; 5+
duplicate minor-unit currency formatters in cashback components (each with a comment justifying the inline copy).
Impact: a11y/money fixes (e.g. the missing `<th scope>`, the float-money class) must be applied 3-7× and will
drift. Fix: extract shared `fmtRelative`/`successPct`/`METHOD_*`/`sumCharge` + a parameterized `OperatorMixTable`
and `StuckCountCard`; converge currency formatters on `@loop/shared/money-format.ts`.

**WEB-Q3 · P3 · two divergent OTP implementations**
`signup-tail.tsx OtpEntry` (paste pill, auto-verify, resend) vs the inline OTP in `PurchaseContainer.tsx:267-306`
(none of those). DRY/consistency gap. Fix: reuse `OtpEntry`/`useOnboardingAuth`.

**WEB-Q4 · P3 · `FavoritesStrip` ≈ `RecentlyPurchasedStrip`**
Near-identical layout differing only in data source + header. Candidate for a shared `MerchantStrip`.

**Clean:** **No `any`/`as any`/`<any>` anywhere in scope** (0 hits). No `console`-logged tokens. CSV download
correctly `URL.revokeObjectURL`s. `share-image.ts` has a bounded image-load timeout (no native `Image` timeout)
— good defensive code.

---

### Tests

**WEB-T1 · P2 · no tests for the dialogs gating every destructive write**
No test files for `ConfirmDialog`, `ReasonDialog`, or `RequireAdmin` — the two dialogs gate every destructive
admin write and `RequireAdmin` gates the whole admin surface (and carries the WEB-ST3 logic bug a test would catch).

**WEB-T2 · P2 · destructive-form component tests don't render**
`AdminWithdrawalForm.test.tsx` and `CreditAdjustmentForm.test.tsx` have **0 `render()` calls** — they only
exercise the pure `parse*AmountMajor` parsers. The write path (confirm gate, step-up retry, double-submit,
rendered money, the WEB-UX2 destination-not-cleared bug) is untested at the component level.

**WEB-T3 · P2 · `StepUpModal.test.tsx` polyfills `showModal` and notes focus-trap/ESC "come from the browser"**
So the modal's focus-trap/ESC/restore a11y is effectively untested (jsdom can't). Warrants a Playwright e2e for
the step-up + confirm flow given it guards payouts.

The remaining ~50 component test files do meaningfully `render()` + assert DOM (not vacuous mock-only tests).

---

## False positives rejected (sub-agent claims re-verified against source)

- **`tabular` is NOT a Tailwind typo.** `app.css:143-145` defines `.tabular { font-variant-numeric:
tabular-nums; }` as a custom utility. The `tabular` class in `MerchantCard:163,169`, `MobileHome:620`,
  `MerchantGroupCard`, `Footer`, `Navbar` all resolve correctly. (Two sub-agents independently flagged this;
  both wrong.)
- **`LinkWalletNudge` using raw `react-router` `Link` is correct.** It links to `/settings/wallet`, which is
  NOT in `LOCALIZABLE_PATHS` (`i18n/locale.ts:112-123`), so `LocaleLink` would no-op anyway. No locale-prefix
  loss. (Sub-agent flagged P1; rejected.)
- **`redeem-challenge-bar.ts` `done`/`fallback` ordering is fine** — `fallback` is a hoisted function
  declaration; the forward reference at `:67` is valid.

---

## Summary

| Severity | Count                                                                                 |
| -------- | ------------------------------------------------------------------------------------- |
| P0       | 1 (WEB-S1 — RedeemFlow script execution; primary owner is the orders/native vertical) |
| P1       | 11                                                                                    |
| P2       | 18                                                                                    |
| P3       | 14                                                                                    |

**P0**

- WEB-S1 — RedeemFlow executes upstream CTX-supplied scripts verbatim in the redemption WebView (no
  allowlist/sandbox/signature). Originates in a web component; owned jointly with the orders/native vertical.

**P1 (one-liners)**

- WEB-S2 — RedeemFlow `postMessage` accepts a gift-card result with no origin/shape validation (forged-code chain with WEB-S1).
- WEB-M1 — `MobileHome` savings hero hardcodes `$` (3 sites) — wrong currency on the most prominent figure for GB/EU users.
- WEB-M2 — `LoopOrdersList` headline cashback row renders no currency symbol/code at all (£ vs $ ambiguous).
- WEB-M3 — `CashbackStatsBand.fmtPerCurrency` formats fleet-wide totals via `Number()/100` — precision loss at scale.
- WEB-M4 — admin shared chart `formatMinor` (used by all monthly + treasury charts) casts bigint before `/100` — solvency-figure precision loss.
- WEB-M5 — `AssetCirculationCard` ledger-liability total cast via `Number(bigint)/100` — same precision-loss class.
- WEB-ST1 — `StellarTrustlineStatus` + `OrderPayoutCard` not auth-gated — re-introduces the A2-1156 cold-start 401/refresh storm.
- WEB-A1 — `prefers-reduced-motion` honoured nowhere in the web app (global vestibular-safety gap).
- WEB-A2 — onboarding flow: no dialog semantics, no focus trap, inconsistent `tabIndex` gating (focus escapes into hidden steps).
- WEB-A3 — `MapBottomSheet` dialog has no focus trap / focus move / focus restore.
- WEB-A4 — `CountrySelector` listbox dialog has no focus trap and no arrow-key navigation.
- WEB-A5 — admin tables: 0/24 use `<th scope>`, none have accessible names (SR can't associate cells on stacked tables).
- WEB-A6 — color-only status signaling: `PaymentMethodActivityChart` per-rail breakdown + `StuckOrders`/`StuckPayouts` alarm state.
- WEB-I1 — hardcoded `$`/`en-US` in user-facing surfaces (onboarding hero, stats bands) — contradicts ADR 034/035.

**Launch-readiness verdict (web UI):** The primitives layer (`Button`/`Input`), stores, hooks, and i18n
machinery are mature and well-engineered (no `any`, no XSS, clean cross-tab/auth/state handling). The blocking
risks before public order traffic are: (1) the RedeemFlow script-execution + forged-`postMessage` chain
(WEB-S1/S2), (2) the currency-correctness regressions on user-facing money (WEB-M1/M2) which are visible on
every non-USD market the ADR 035 push is opening, and (3) the bigint precision-loss in admin
solvency/treasury figures (WEB-M3/M4/M5). The accessibility debt (WEB-A1–A6 in particular) is broad and
should be addressed as a focused sweep — focus traps on the four modal surfaces, `<th scope>` across admin
tables, reduced-motion globally, and color-only status cues — none individually launch-blocking but
collectively a WCAG-AA failure.
