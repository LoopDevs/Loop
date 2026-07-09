# Vertical Web UI money/purchase — raw findings

Files examined: 26/26 in-scope source files (+ 14 `__tests__` siblings = 40/40 files in the assigned
globs), plus 9 adjacent files read for load-bearing context (native/webview.ts, utils/redeem-message.ts,
utils/redeem-challenge-bar.ts, i18n/format.ts, stores/purchase.store.ts, components/Phase2Gate.tsx,
routes/settings.cashback.tsx, routes/orders.$id.tsx, routes/orders.tsx, components/features/admin/CopyButton.tsx,
packages/shared/src/money-format.ts). Method: independent read-through against Part 1 §§1/2/15/25/32 and
Part 2 V9, then cross-checked against `docs/audit-2026-06-15-cold/raw/v-web-ui.md` to verify prior findings
in this vertical's scope and confirm/refute the CF-02/CF-23/CF-24/CF-35 closure claims.

No P0s found. The audited delta (CF-02/23/24/35) is real, substantial hardening and most of it is
correctly implemented — see the Delta re-verification section for what's cleanly closed. The findings
below are residue: gaps the cited commits explicitly left open (by their own commit messages), a narrower
recurrence of the same bug classes in files the fixes didn't reach, and a few previously-flagged items
this round re-confirms are still open.

## Findings

### WUM-01 [P1 · LIVE] RedeemFlow `postMessage` accepted with no origin/source check — CF-02 closed shape validation, not origin validation

- File: `apps/web/app/components/features/purchase/RedeemFlow.tsx:85-100`, `apps/web/app/native/webview.ts:64-77`, `apps/web/app/utils/redeem-message.ts:38-46`
- Description: CF-02 (`20307af7`, #1442) added `parseGiftCardMessage` — a real improvement: it rejects non-`loop:giftcard` shapes, oversized fields, and control characters. But the commit's own message says: _"Trust boundary documented: scripts run in the merchant redeem page... A full per-script signature scheme (requires CTX cooperation) is a tracked follow-up."_ The follow-up is the **origin check**, and it was never added. `InAppBrowser.addListener('messageFromWebview', ...)` (`@capgo/inappbrowser` v8, confirmed via `node_modules/@capgo/inappbrowser/dist/esm/definitions.d.ts:1236-1240`) hands the listener `{ id?, detail?, rawMessage? }` — no origin/URL field at all. `onMessage` in `RedeemFlow.tsx` accepts any well-shaped `loop:giftcard` payload regardless of which page within the WebView session sent it.
- Impact: Any page reachable via in-WebView navigation after the trusted `redeemUrl` loads (an ad redirect, a compromised third-party widget embedded in the merchant's redemption flow, a redemption-portal bounce through an intermediary) can call `window.mobileApp.postMessage({type:'loop:giftcard', code, pin})` and have it accepted as the user's gift-card result — `store.setComplete()` is purely client-local UI state (verified: no backend write follows it), so the blast radius is bounded to "the app displays a forged code/PIN to the user" (support/confusion, not a ledger or balance change), but that's still a real fintech-product trust failure on the money-redemption screen.
- Evidence: `parseGiftCardMessage` (redeem-message.ts) has zero origin awareness by design; `webview.ts`'s native listener wiring (`InAppBrowser.addListener('messageFromWebview', ...)`) forwards every message regardless of which loaded page sent it; the plugin's own `urlChangeEvent` (which _does_ carry `{ id, url }`, confirmed in the same `.d.ts`) is never subscribed to.
- Minimal fix: track the WebView's current URL via `InAppBrowser.addListener('urlChangeEvent', ...)` in `webview.ts`, and have `openWebView` drop/ignore `onMessage` calls once the tracked URL's origin no longer matches the original `redeemUrl`'s origin (pass the expected origin down from `RedeemFlow`).
- Better fix: the documented "tracked follow-up" — a per-script nonce or signature CTX embeds in its `scrapeResult` script and echoes back in the message, verified before acceptance. Track this as its own ticket since it needs CTX-side cooperation; until then, origin-pinning via `urlChangeEvent` closes most of the gap cheaply.

### WUM-02 [P2 · LIVE] RedeemFlow `onMessage` has no idempotency guard — a second valid message silently overwrites the first

- File: `apps/web/app/components/features/purchase/RedeemFlow.tsx:88-100`
- Description: `onMessage` sets `receivedCodeRef.current = true` and calls `store.setComplete(result.code, result.pin)` on _every_ valid `loop:giftcard` message, with no `if (receivedCodeRef.current) return;` guard at the top. `controller.close()` is async (`void controller.close()`), so there's a window where a second message — a legitimate script firing twice, or (combined with WUM-01) an attacker-controlled page racing the legitimate scraper — overwrites the already-captured code/PIN with different values. Once `store.setComplete` fires, `PurchaseContainer` (lines 136-158) routes straight to `PurchaseComplete` with no way back to `RedeemFlow` to recover the original value.
- Impact: A user could see a different (possibly wrong) code than the one their gift card actually redeemed under, with no in-app path back to the original capture.
- Evidence: re-read `RedeemFlow.tsx:88-100` — no first-message-wins guard; `PurchaseContainer.tsx:136-158` — the `step === 'complete'` branch has no escape hatch back to `'redeem'`.
- Minimal fix: `if (receivedCodeRef.current) return;` as the first line of `onMessage`.
- Better fix: same, plus surface a `<button>` on `PurchaseComplete`/order-detail to "view the original redemption page again" using the still-known `redeemUrl`, for the case where the captured value is later disputed.

### WUM-03 [P1 · LIVE] No host-pinning on script (re-)injection — WEB-S1 (06-15 audit) is still open; CF-02 only capped script size

- File: `apps/web/app/native/webview.ts:86-93`
- Description: `InAppBrowser.addListener('browserPageLoaded', () => { for (const script of scripts) { void InAppBrowser.executeScript({ code: script }); } })` re-injects the challenge-bar script **and** the CTX-supplied `injectChallenge`/`scrapeResult` scripts on _every_ page load for the lifetime of the WebView session — there is no check that the page that just loaded is still on the original `redeemUrl`'s origin. `browserPageLoaded`'s event payload (`{ id?: string }`, per the plugin's `.d.ts`) doesn't even carry a URL, so the code couldn't filter even if it wanted to today. CF-02 (#1442) added a 100KB cap on the injected scripts but did not change this injection trigger at all.
- Impact: this is the actual mechanism that makes WUM-01/WUM-02 reachable without a CTX-side compromise — a same-flow third-party redirect (ad network, embedded reward-fulfillment widget, a common pattern on gift-card redemption portals) gets Loop's own bridge-calling scripts re-executed in _its_ page context, which is the cheapest way for an off-path actor to call `window.mobileApp.postMessage(...)` with a forged `loop:giftcard` shape.
- Evidence: `webview.ts:86-93`; plugin `.d.ts:1251-1254` confirms `browserPageLoaded` carries no URL; `.d.ts:1-20` confirms `urlChangeEvent` does.
- Minimal fix: same as WUM-01's — subscribe to `urlChangeEvent`, and skip the `executeScript` loop on `browserPageLoaded` once the tracked URL's origin has diverged from the original `redeemUrl`'s origin.
- Better fix: combine with WUM-01's signature-based message verification so the fix doesn't rely solely on origin tracking (which is best-effort against a sufficiently fast same-origin XSS, even if it closes the realistic redirect/ad-network case).

### WUM-04 [P2 · LIVE] CF-23's bigint-exact formatter rollout missed 4 call sites in this vertical — the literal `Number(bigint)/100` anti-pattern still exists, and produces inconsistent display for the identical value within one component

- File:
  - `apps/web/app/components/features/orders/LoopOrdersList.tsx:292-299` (local `formatMinor`)
  - `apps/web/app/components/features/purchase/LoopPaymentStep.tsx:393-405` (identical duplicate of the above)
  - `apps/web/app/components/features/cashback/CashbackCalculator.tsx:44-56` (`Number(BigInt(minor)) / 100`)
  - `apps/web/app/components/features/cashback/PendingCashbackChip.tsx:43-59` (`Number(minor) / 100` where `minor` is already a `bigint`)
- Description: `apps/web/app/i18n/format.ts`'s docstring states _"this is the single source of truth for currency/number formatting... there is no second live currency formatter"_ and CF-23 (`3df0e386`, #1445) fixed 5 named call sites (WEB-M1 through WEB-M5). It did not touch the four sites above, all four of which still construct a major-unit value via `Number()` before dividing/formatting — the exact pattern `money-format.ts`'s own docstring says was eliminated ("no `Number` ever touches displayed digits"). Worse: `LoopOrdersList.tsx` uses its local non-canonical `formatMinor` (code-suffixed: `"10.00 USD"`) for the row's face-value amount (`:70`) and the expanded-panel cashback line (`:147`), while the _same component_'s collapsed-row cashback teaser two lines away (`:114`) correctly delegates to the canonical `formatMinorCurrency` (symbol-prefixed: `"+£2.50"`) for the **same** `order.userCashbackMinor`/`order.currency` pair. The inconsistency is locked in by the test suite itself: `LoopOrdersList.test.tsx:90` asserts `/10\.00 USD/` while `:141` asserts `'+£2.50 cashback'` for sibling lines in the same row.
- Impact: Practically bounded today — order/cashback amounts are capped at $10,000 (`AmountSelection.BACKEND_MAX`), nowhere near the 2^53 minor-unit threshold where `Number()` actually loses precision — so this is a correctness/DRY/consistency finding, not a live precision-loss bug. But it's the literal anti-pattern this audit was briefed to hunt for, in delta-flagged files, and it visibly contradicts the "one format seam" claim made in the same release.
- Minimal fix: delete the four local re-implementations; import `formatMinorCurrency` from `~/i18n/format` everywhere a currency code is available, matching the pattern already used 2 lines away in `LoopOrdersList.tsx`.
- Better fix: same, plus a lint rule / `grep` CI check (mirroring `scripts/check-openapi-parity.mjs`'s pattern) that fails on `Number(` immediately preceding a `bigint`-typed minor-unit variable anywhere under `apps/web/app/components/features/**`, so this class can't silently reappear a third time.

### WUM-05 [P2 · LAUNCH-GATE] EarnedCashbackCard / OrderPayoutCard render unconditionally — not gated behind `phase1Only`, unlike every sibling cashback/wallet surface

- File: `apps/web/app/components/features/purchase/EarnedCashbackCard.tsx` (whole file), `apps/web/app/components/features/order/OrderPayoutCard.tsx` (whole file), `apps/web/app/components/features/purchase/PurchaseContainer.tsx:143-149`, `apps/web/app/routes/orders.$id.tsx:187-197`
- Description: AGENTS.md documents `LOOP_PHASE_1_ONLY=true` as hiding "every Phase 2+ surface (cashback links, /settings/wallet, /settings/cashback, /cashback, onboarding currency picker + wallet-intro, 'you've earned X' copy)". `routes/settings.cashback.tsx:84-90` and `routes/settings.wallet.tsx` correctly wrap their bodies in `<Phase2Gate>` (verified — `Phase2Gate.tsx` renders a "Coming soon" panel when `config.phase1Only`). `LinkWalletNudge.tsx:60` explicitly checks `if (config.phase1Only) return null;`. But `EarnedCashbackCard` (rendered unconditionally by `PurchaseContainer.tsx:143-149` right after every completed purchase, and by `routes/orders.$id.tsx:187-197` on every order-detail page) and `OrderPayoutCard` (same route, line 197) have **no `phase1Only` check anywhere** — confirmed via `grep phase1Only` across the purchase/order/cashback directories: the only hits in `PurchaseContainer.tsx` are stale comments, not code.
- Impact: `EarnedCashbackCard`'s copy is literally "You earned $X cashback. **Credited to your Loop balance.**" — but `routes/auth.tsx:184-187`'s own comment states the actual Phase-1 model is _"delivers cashback as instant discount at order creation — no balance accumulates, no wallet to withdraw to"_. So if any merchant gets an active cashback config configured while `LOOP_PHASE_1_ONLY=true` is still the production default (plausible during pre-launch QA/dogfooding of the cashback-config admin tooling, which is independent of the payment-rail flag), every purchase-complete screen and every `/orders/:id` page for that merchant shows a claim ("credited to your balance") that's false under the documented Phase-1 model, with a "View →" link into a `<Phase2Gate>` "Coming soon" dead end.
- Evidence: `grep -n "phase1Only" apps/web/app/components/features/{purchase,cashback,order,orders,wallet,auth}` returns only `LinkWalletNudge.tsx` and comments in `PurchaseContainer.tsx`; `routes/orders.$id.tsx` has no `Phase2Gate` import at all (contrast `routes/settings.cashback.tsx:21,86`).
- Minimal fix: add `const { config } = useAppConfig(); if (config.phase1Only) return null;` to `EarnedCashbackCard` and `OrderPayoutCard`, mirroring `LinkWalletNudge`.
- Better fix: centralize the gate — wrap the post-purchase cashback block in `PurchaseContainer`/`orders.$id.tsx` once rather than duplicating the `phase1Only` read per leaf component, the way `Phase2Gate` does for whole routes.

### WUM-06 (WEB-M6 re-confirmed, still open) [P2 · LIVE] EarnedCashbackCard recomputes cashback from the _current_ rate, not the rate pinned at order time

- File: `apps/web/app/components/features/purchase/EarnedCashbackCard.tsx:42-50`
- Description: Re-confirms the 06-15 audit's WEB-M6, not touched by this delta. `(amount * pct) / 100` uses `useMerchantCashbackRate(merchantId)`'s **live** rate, not the order's actually-credited `userCashbackMinor`. The component's own comment admits this: _"a follow-up can expose that field on the Order response and replace the computation."_ Rendered on the standalone `/orders/:id` page (unbounded time window since the order was placed), so an admin rate change between order and page-view produces a drift between the displayed "You earned $X" and the real `credit_transactions` entry.
- Impact: trust/accuracy risk on the literal headline reward figure for a cashback product.
- Minimal fix: as the code comment proposes — add `userCashbackMinor` to the order response shape and render that instead of recomputing client-side wherever it's available (it already exists on `LoopOrderView` per `LoopPaymentStep.tsx`'s `RedemptionBody`, which correctly uses the server value).
- Better fix: same, and delete the client-side recompute path entirely once the field is wired everywhere `EarnedCashbackCard` is mounted (it would need `PurchaseContainer`'s legacy non-loop path to also carry the field, or fall back only there).

### WUM-07 (WEB-M7 re-confirmed, still open) [P3 · LIVE] CashbackCalculator hardcodes a `$` prefix on the amount input regardless of merchant currency

- File: `apps/web/app/components/features/cashback/CashbackCalculator.tsx:104-106`
- Description: Re-confirms 06-15's WEB-M7; `CashbackCalculator.tsx` was not touched by CF-22/CF-23 (`git log` shows its only commit is the original feature PR #741). The amount-input affordance still renders a literal `<span aria-hidden="true">$</span>` while the result (`cashbackLabel`) correctly formats in `data.currency` via `formatCashbackMinor`.
- Impact: a `/cashback/:slug` SEO landing page for a GBP/EUR merchant shows a `$` input prefix next to a `£`/`€` result — a visible currency-symbol mismatch on a conversion-focused page.
- Minimal fix: derive the prefix from the query result's `currency` once loaded (fall back to a neutral prefix, e.g. no symbol, before the first response arrives) via `currencySymbol()` from `~/i18n/format`.

### WUM-08 (WEB-ST2 partially re-confirmed) [P2 · LIVE] StellarTrustlineStatus polls forever even once "all trustlines present" — sibling OrderPayoutCard was fixed, this wasn't

- File: `apps/web/app/components/features/wallet/StellarTrustlineStatus.tsx:35-42`
- Description: 06-15's WEB-ST2 flagged both `OrderPayoutCard` and `StellarTrustlineStatus` for polling forever past a terminal/settled state. `OrderPayoutCard.tsx:71-74` is now correctly fixed with a function-form `refetchInterval` that returns `false` once `state === 'confirmed' || 'failed'`. `StellarTrustlineStatus.tsx:41` still has a flat `refetchInterval: 60_000` with no stop condition — it keeps polling every 60s indefinitely even in the "Wallet ready to receive cashback" (all-present) terminal state, for as long as `/settings/wallet` stays open.
- Impact: low-severity but real waste — an indefinitely-open settings tab keeps firing an authed request every minute after there's nothing left to change.
- Minimal fix: `refetchInterval: (q) => { const d = q.state.data; return d !== undefined && d.accountLinked && d.accountExists && d.rows.every(r => r.present) ? false : 60_000; }`.

### WUM-09 (WEB-UX1 re-confirmed, still open) [P2 · LIVE] RedeemFlow "Reopen page" has no double-submit guard

- File: `apps/web/app/components/features/purchase/RedeemFlow.tsx:166-175`
- Description: Re-confirms 06-15's WEB-UX1, untouched by CF-02. The "Reopen page" button's `onClick` calls `void handleOpenWebView(); setShowManualEntry(false);` with no `disabled` guard (the main "Open redemption page" button does have `disabled={webViewOpen}`, this one doesn't). `handleOpenWebView` itself doesn't reset `receivedCodeRef.current` at entry either (not currently exploitable into a bad state since the button is only reachable when the ref is already `false`, but it's a latent footgun if the component's state machine changes).
- Impact: a fast double-tap while `showManualEntry` is still `true` (same React task, before the state flush hides the button) can fire `openWebView` twice — two concurrent WebViews/popups, with the second `controller` silently overwriting `webViewRef.current` and the first's `onClose` never properly handled.
- Minimal fix: add `disabled={webViewOpen}` to the "Reopen page" button (it already has access to the same `webViewOpen` state in scope); add `receivedCodeRef.current = false;` as the first line of `handleOpenWebView` for defense-in-depth.

### WUM-10 [P2 · LIVE] CF-35's copy-confirmation `aria-live` fix landed on 2 of 5 "copy to clipboard" sites in this vertical

- File:
  - Fixed: `apps/web/app/components/features/purchase/PaymentStep.tsx:211-218` (copiedField aria-live), `apps/web/app/components/features/purchase/LoopPaymentStep.tsx:382-388` (`Row`'s aria-live span)
  - Not fixed: `apps/web/app/components/features/purchase/PurchaseComplete.tsx:210-245` (`CodeField` — visual-only "Copied"/"Copy" button text, no `aria-live`), `apps/web/app/components/features/purchase/RedeemFlow.tsx:202-210` (challenge-code copy button — visual-only), `apps/web/app/components/features/orders/LoopOrdersList.tsx:238-263` (`RedemptionField` — visual-only), `apps/web/app/components/features/admin/CopyButton.tsx:74-131` (used by `wallet/TrustlineSetupCard.tsx` for issuer-pubkey copy — visual-only, and copy failure is fully silent by design per its own comment)
- Description: 06-15's WEB-A8 called out this exact gap across all of these sites ("Same gap on the LoopPaymentStep Row copy button... and PurchaseComplete copy buttons"). CF-35 (`5dfce00d`, #1447) added the aria-live confirmation to `PaymentStep` and `LoopPaymentStep`'s `Row`, but not to `PurchaseComplete`, `RedeemFlow`, `LoopOrdersList`, or the shared admin `CopyButton` that `TrustlineSetupCard` (in this vertical's scope) depends on for copying the anti-spoofing-critical issuer pubkey.
- Impact: a screen-reader user copying their gift-card code (`PurchaseComplete`), the redemption challenge code (`RedeemFlow`), an order's redeem code/PIN (`LoopOrdersList`), or — most consequentially — the LOOP-asset issuer address they're about to trustline (`TrustlineSetupCard` via `CopyButton`) gets no spoken confirmation that the copy succeeded.
- Minimal fix: copy the same `<span aria-live="polite" className="sr-only">{...}</span>` pattern already used in `PaymentStep`/`LoopPaymentStep.Row` into the four remaining sites.
- Better fix: extract a single `useCopyToClipboard()` hook (state + aria-live span + the existing fallback-chain logic already duplicated between `clipboard.ts`, `redeem-challenge-bar.ts`'s inline JS, and `CopyButton.tsx`) so this class of fix only has to land once.
- **Status: CLOSED 2026-07-09.** The minimal fix landed on all four remaining sites, matching the fixed sites' aria-live semantics/timing exactly (inline, no hook extraction — the "Better fix" hook is still open, tracked separately, not required to close this finding): `PurchaseComplete.CodeField` (top-level `copied`-field region, mirroring `PaymentStep`'s shape since both track a `field | null` state), `RedeemFlow`'s challenge-code button (sibling `sr-only` span), `LoopOrdersList.RedemptionField` (sibling span, mirroring `LoopPaymentStep.Row` exactly), and the shared admin `CopyButton` (derives the announcement subject from its existing `label` prop — e.g. `"Copy USDLOOP issuer"` → `"USDLOOP issuer copied to clipboard."`). Each site has a Testing-Library test asserting the region's content on copy and its reset after the existing flash window. 5 of 5 sites now confirm copy to assistive tech.

### WUM-11 (WEB-S4 re-confirmed, now spans 2 delta files) [P3 · LIVE] `redeemUrl` rendered into `<a href>` with no scheme allowlist

- File: `apps/web/app/components/features/purchase/LoopPaymentStep.tsx:181-189` (`RedemptionBody`), `apps/web/app/components/features/orders/LoopOrdersList.tsx:133-142`
- Description: Re-confirms 06-15's WEB-S4, now present in 2 of this delta's touched files (neither was updated to add the check). Both render `order.redeemUrl` directly as `<a href={order.redeemUrl}>` with no scheme assertion, unlike `RedeemFlow.tsx`'s `openWebView` path, which routes every redeem URL through `assertSafeUrl()` (`native/webview.ts:23-46`) and rejects non-`http(s)` schemes, embedded credentials, and (in production) plain `http:`.
- Impact: low in practice — `target="_blank" rel="noopener noreferrer"` is present on both anchors, and modern browsers refuse `javascript:` navigation from such links — but it's an inconsistent trust boundary: the exact same field (`redeemUrl`, CTX-sourced) gets real validation on one rendering path and none on two others.
- Minimal fix: extract `assertSafeUrl`'s scheme check (or a read-only variant that returns a boolean instead of throwing) into a shared util and call it before rendering either anchor; fall back to no link (the redemption code/PIN rows still render) when it fails.

### WUM-12 [P3 · LIVE] Date formatting bypasses the route-locale seam CF-22 established for everything else

- File: `apps/web/app/components/features/order/OrderPayoutCard.tsx:50-56`, `apps/web/app/components/features/cashback/PendingPayoutsCard.tsx:108-116`
- Description: `formatDate(iso)` in both files calls `new Date(iso).toLocaleString(undefined, {...})` — browser/OS locale, not the route locale. `LoopOrdersList.tsx:71-75` and `PendingCashbackChip.tsx` correctly thread `useLocaleTag()` into their date formatting. CF-22's stated goal ("route-locale-aware formatting... one format seam") was scoped to currency in practice; dates in these two files were never migrated.
- Impact: minor SSR/client locale mismatch risk (the documented reason ADR 034 avoids `navigator.language`) plus a visible inconsistency — a `/gb/en` page shows a route-correct `£` amount next to an OS-locale (possibly `en-US`-formatted) date on the same card.
- Minimal fix: thread `useLocaleTag()` into both `formatDate` calls, matching `LoopOrdersList`'s pattern.

### WUM-13 [P3] GoogleSignInButton has zero test coverage; its sibling AppleSignInButton (added in the same CF-27 commit era) has 4

- File: `apps/web/app/components/features/auth/GoogleSignInButton.tsx` (no `__tests__/GoogleSignInButton.test.tsx` exists)
- Description: `auth/__tests__/` contains only `AppleSignInButton.test.tsx`. Both buttons share the same lazy-script-load → init → credential-callback → `onCredential`/`onError` structure; `GoogleSignInButton` predates CF-27 and was apparently never backfilled with tests when its sibling got 4 well-constructed ones (init-with-clientId, credential hand-off, cancel-swallow, error-surface).
- Minimal fix: port `AppleSignInButton.test.tsx`'s structure (stub `window.google`, drive `script.onload`, assert `initialize`/`renderButton` args and the `callback` → `onCredential` hand-off).

### WEB-S3 (re-confirmed, still open — not a regression, no CF claims to have closed it) [P2 · LIVE] PurchaseComplete's native-share text includes the raw gift-card code + PIN in plaintext

- File: `apps/web/app/components/features/purchase/PurchaseComplete.tsx:67-69`
- Description: `text: \`Gift card code: ${code}${pin !== undefined ? \`\nPIN: ${pin}\` : ''}\``is unchanged from the 06-15 audit's WEB-S3 finding and is explicitly pinned by`PurchaseComplete.test.tsx:107-114` ("invokes nativeShare with merchant + code + PIN..."). Not part of this delta's CF list — flagged here only as a re-confirmed, still-live gap on a money-bearing instrument flowing into arbitrary OS share targets / clipboard managers.
- Minimal fix: share the composed barcode image only (the function already builds one — `composed`), drop the raw code/PIN from the share `text`; or gate the plaintext behind an explicit "include code as text" toggle.

## Delta re-verification

- **CF-02** (`20307af7`, #1442) — **PARTIALLY CLOSED.** The shape/size validation half is implemented cleanly and introduces no new bugs (`parseGiftCardMessage` is well-tested: 8 cases per the commit message, control-char/oversize/wrong-shape all correctly rejected; the 100KB script cap is applied both server- and client-side as claimed). The origin-validation half — which the commit's own message names as a "tracked follow-up" — is genuinely not done: see WUM-01 (no origin check on the accepted message) and WUM-03 (no host-pinning on script re-injection, so the WEB-S1 root cause from 06-15 is still fully open, just with a smaller blast radius now that scripts are size-capped). WUM-02 (no idempotency guard on `onMessage`) is a separate, narrower gap the fix didn't address either. Net: closed exactly what it claimed to close; did not over-claim; the residual gap is real and worth a follow-up ticket, as the implementer already flagged.
- **CF-23** (`3df0e386`, #1445) — **PARTIALLY CLOSED.** The 5 named items (WEB-M1 through WEB-M5) are all correctly fixed and verified by reading the current source (`CashbackStatsBand`, `MonthlyCashbackChart` admin variant, `AssetCirculationCard`, `LoopOrdersList`'s WEB-M2 currency-code fix, `MobileHome`'s hardcoded-`$` removal — confirmed present). The shared `formatMinorCurrency` itself is correctly bigint-exact past 2^53 (verified the `Intl.NumberFormat` call operates on the bigint major-unit value directly, never casting through `Number`). However, the fix was scoped to its named call sites, not a blanket sweep — see WUM-04: 4 more call sites in this vertical's delta-adjacent files still do `Number(bigint)/100` or equivalent, including 2 in the actual delta file list (`LoopOrdersList.tsx`, `LoopPaymentStep.tsx`). The originally-flagged WEB-M8 list (CashbackBalanceCard/CashbackByMerchantCard/CashbackEarningsHeadline/OrdersSummaryHeader) is now fully fixed — those four converged on `formatMinorCurrency` since 06-15, likely as part of the CF-22 `~/i18n/format.ts` consolidation rather than CF-23 itself.
- **CF-24** (auth-gating on StellarTrustlineStatus/OrderPayoutCard) — **CLEANLY CLOSED.** Both components now correctly gate their query on `enabled: isAuthenticated`, both have an explicit regression test asserting the query doesn't fire when unauthenticated, and the companion WEB-ST2 polling-forever issue from 06-15 was fixed for `OrderPayoutCard` (function-form `refetchInterval` stopping on `confirmed`/`failed`) in the same pass. Not extended to `StellarTrustlineStatus`, which still polls forever after reaching its own terminal "all present" state — see WUM-08 (separate, narrower finding; the auth-gating fix itself is solid).
- **CF-35** (aria-live, countdown extend, split shared 'copied' boolean, focus traps, radiogroup roving-tabindex) — **MOSTLY CLOSED, ONE CLASS PARTIALLY MISSED.**
  - Split shared 'copied' boolean (the memo-strand bug): **cleanly closed**. `PaymentStep.tsx` now tracks `copiedField: 'address' | 'memo' | null` (a single, correctly-discriminated piece of state, not two booleans that could both flip), with a dedicated regression test (`PaymentStep.test.tsx:145-168`) proving copying one field doesn't flip the other's button text. `PurchaseComplete.tsx`'s `CodeField` similarly uses a tri-state `copied: 'code'|'pin'|null` passed down correctly. No remaining shared-boolean bug found anywhere in scope.
  - Countdown / WCAG 2.2.1 timing: **adequately closed** via the documented "Start over" (restart, not literal extend) pattern in `PaymentStep.tsx`, present both pre- and post-expiry, plus a coarse-cadence `aria-live="polite"` announcement. Restart-not-extend is the right call for a payment deadline tied to a live quote.
  - Radiogroup roving-tabindex (`use-radio-group-keys.ts`): **cleanly closed and correctly wired** in both call sites in scope — `PurchaseContainer.tsx`'s payment-rail radiogroup (`:81-85, 416-436`) and `onboarding/screen-currency.tsx`'s home-currency picker (`:67-71, 90-148`). The hook itself is well-built (roving tab-stop, Arrow/Home/End navigation, imperative focus move synced to the new tab stop) and has a thorough, non-vacuous test suite.
  - Focus trap (`use-focus-trap.ts`): well-built (verified open/close/Tab-wrap/Shift+Tab-wrap/restore-on-close, all tested) but **not used anywhere in this vertical's scope** — its only two call sites (`CountrySelector.tsx`, `MapBottomSheet.tsx`) are outside money/purchase. No modal/dialog overlay exists in the purchase/cashback/wallet/order(s) components that would need it, so this isn't a gap for this vertical specifically.
  - aria-live copy confirmation: **partially closed** — see WUM-10. 2 of 5 "copy to clipboard" sites in this vertical's scope got the fix (`PaymentStep`, `LoopPaymentStep.Row`); 3 did not (`PurchaseComplete.CodeField`, `RedeemFlow`'s challenge-code copy, `LoopOrdersList.RedemptionField`), plus the shared admin `CopyButton` that `TrustlineSetupCard` depends on for issuer-pubkey copy was never touched.

## Coverage confirmation

In-scope source files (26) — all read in full:

- `apps/web/app/components/features/auth/AppleSignInButton.tsx`
- `apps/web/app/components/features/auth/GoogleSignInButton.tsx`
- `apps/web/app/components/features/cashback/CashbackBalanceCard.tsx`
- `apps/web/app/components/features/cashback/CashbackByMerchantCard.tsx`
- `apps/web/app/components/features/cashback/CashbackCalculator.tsx`
- `apps/web/app/components/features/cashback/CashbackEarningsHeadline.tsx`
- `apps/web/app/components/features/cashback/FlywheelChip.tsx`
- `apps/web/app/components/features/cashback/LinkWalletNudge.tsx`
- `apps/web/app/components/features/cashback/MonthlyCashbackChart.tsx`
- `apps/web/app/components/features/cashback/PendingCashbackChip.tsx`
- `apps/web/app/components/features/cashback/PendingPayoutsCard.tsx`
- `apps/web/app/components/features/cashback/RailMixCard.tsx`
- `apps/web/app/components/features/order/OrderPayoutCard.tsx`
- `apps/web/app/components/features/orders/LoopOrdersList.tsx`
- `apps/web/app/components/features/orders/OrdersSummaryHeader.tsx`
- `apps/web/app/components/features/purchase/AmountSelection.tsx`
- `apps/web/app/components/features/purchase/EarnedCashbackCard.tsx`
- `apps/web/app/components/features/purchase/LoopPaymentStep.tsx`
- `apps/web/app/components/features/purchase/PaymentStep.tsx`
- `apps/web/app/components/features/purchase/PurchaseComplete.tsx`
- `apps/web/app/components/features/purchase/PurchaseContainer.tsx`
- `apps/web/app/components/features/purchase/RedeemFlow.tsx`
- `apps/web/app/components/features/wallet/StellarTrustlineStatus.tsx`
- `apps/web/app/components/features/wallet/TrustlineSetupCard.tsx`
- `apps/web/app/hooks/use-focus-trap.ts`
- `apps/web/app/hooks/use-radio-group-keys.ts`

`__tests__` siblings (14) — all read in full:

- `auth/__tests__/AppleSignInButton.test.tsx`
- `cashback/__tests__/CashbackBalanceCard.test.tsx`
- `cashback/__tests__/CashbackByMerchantCard.test.tsx`
- `cashback/__tests__/CashbackCalculator.test.tsx`
- `cashback/__tests__/CashbackEarningsHeadline.test.tsx`
- `cashback/__tests__/FlywheelChip.test.tsx`
- `cashback/__tests__/LinkWalletNudge.test.tsx`
- `cashback/__tests__/MonthlyCashbackChart.test.tsx`
- `cashback/__tests__/PendingCashbackChip.test.tsx`
- `cashback/__tests__/PendingPayoutsCard.test.tsx`
- `cashback/__tests__/RailMixCard.test.tsx`
- `order/__tests__/OrderPayoutCard.test.tsx`
- `orders/__tests__/LoopOrdersList.test.tsx`
- `orders/__tests__/OrdersSummaryHeader.test.tsx`
- `purchase/__tests__/AmountSelection.test.tsx`
- `purchase/__tests__/EarnedCashbackCard.test.tsx`
- `purchase/__tests__/LoopPaymentStep.test.tsx`
- `purchase/__tests__/PaymentStep.test.tsx`
- `purchase/__tests__/PurchaseComplete.test.tsx`
- `purchase/__tests__/RedeemFlow.test.tsx`
- `wallet/__tests__/StellarTrustlineStatus.test.tsx`
- `wallet/__tests__/TrustlineSetupCard.test.tsx`
- `hooks/__tests__/use-focus-trap.test.tsx`
- `hooks/__tests__/use-radio-group-keys.test.tsx`

(Note: 24 test files listed above vs. the 14 I originally estimated — the actual count across all 6
sub-areas is 24; all were read. `PurchaseContainer.tsx` has no dedicated test file — confirmed by directory
listing, not an oversight on my part.)

Delta-named file explicitly outside the directory globs, read per the task brief's explicit instruction:

- `apps/web/app/components/features/onboarding/screen-currency.tsx`

Adjacent files read for necessary context (not double-counted above, not formally "in scope" but load-bearing
for CF-02/CF-23/phase-gating verification):

- `apps/web/app/native/webview.ts`
- `apps/web/app/utils/redeem-message.ts`
- `apps/web/app/utils/redeem-challenge-bar.ts`
- `apps/web/app/i18n/format.ts`
- `apps/web/app/stores/purchase.store.ts`
- `apps/web/app/components/Phase2Gate.tsx`
- `apps/web/app/routes/settings.cashback.tsx`
- `apps/web/app/routes/orders.$id.tsx` (grep + targeted read)
- `apps/web/app/routes/orders.tsx` (grep only)
- `apps/web/app/routes/auth.tsx` (targeted read, lines 170-230)
- `apps/web/app/components/features/admin/CopyButton.tsx`
- `packages/shared/src/money-format.ts`
- `node_modules/@capgo/inappbrowser/dist/esm/definitions.d.ts` (plugin contract verification for WUM-01/03)
