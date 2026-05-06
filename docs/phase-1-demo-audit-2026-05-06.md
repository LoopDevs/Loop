# Phase-1 Android demo readiness audit (2026-05-06)

Code-walk audit ahead of tomorrow morning's Android demo recording.
Scope: every screen the demo script (`docs/phase-1-demo-script.md`)
visits, plus the route components and onboarding screens that
surround them. Looking specifically for **copy / messaging
mismatches** between Phase-1 reality (cashback delivered as instant
discount at order creation, no wallet, no withdrawal) and what the
UI tells the user.

Test coverage already validates the functional flow (2076 backend
tests + 1021 web tests, all green); this audit fills the
coverage-gap at the messaging-semantics layer where unit tests
don't reach.

## Findings + fixes

### 1. Mobile home savings hero — "Cashback earned" framing (FIXED)

**Where:** `apps/web/app/components/features/home/MobileHome.tsx`,
`SavingsHero` component. Renders on the Android home screen as the
hero panel (top of the scroll, immediately after onboarding).

**Issue:** Title hardcoded "Cashback earned"; empty subtitle
hardcoded "Buy a gift card to start earning cashback"; stat label
"Avg back". Implies a cashback balance that accumulates and can be
spent or withdrawn — Phase-2 model.

**Fix:** Branch on `useAppConfig().config.phase1Only`:

| State                        | Label             | Subtitle (empty)                             | Stat label   |
| ---------------------------- | ----------------- | -------------------------------------------- | ------------ |
| Phase 1 (instant discount)   | "You've saved"    | "Buy a gift card to start saving."           | "Avg saving" |
| Phase 2 (cashback to wallet) | "Cashback earned" | "Buy a gift card to start earning cashback." | "Avg back"   |

The numeric value is unchanged — `o.amount × savingsPercentage`
already computes the realised saving regardless of delivery model.
Only the framing flips.

**Tests:** 7 new cases in
`apps/web/app/components/features/home/__tests__/SavingsHero.test.tsx`
covering both phase modes + the empty / unauthenticated states.

### 2. Account-screen cashback card — "Link a wallet to withdraw" CTA (FIXED)

**Where:** `apps/web/app/routes/auth.tsx`, `CashbackBalanceCard`
component. Renders on the post-sign-in account screen.

**Issue:** Subtitle was always "Earned on every Loop order. Link a
wallet to withdraw." (the latter conditional on
`me.stellarAddress === null`). Phase 1 has no withdrawal mechanism
— the user already received their savings as a per-order discount
— so the wallet CTA promotes a feature that doesn't exist.

**Fix:** Subtitle branches on `phase1Only`:

- Phase 1: "Realised on every Loop order as a discount." (no withdraw nudge)
- Phase 2: "Earned on every Loop order." + conditional "Link a wallet to withdraw."

The card itself stays visible in both phases — the balance figure
is honest in Phase 1 (it's literally `homeCurrencyBalanceMinor=0`,
because no payout intents are queued under
`LOOP_PHASE_1_ONLY=true`).

## Findings deferred (not demo-blocking)

### A. Desktop home hero copy (`routes/home.tsx`)

The marketing-site hero "Earn cashback on every gift card... Every
order pays back to your Loop balance — withdraw on-chain whenever
you're ready." is Tranche-2 messaging. Visible only on web at
desktop widths AND only when `!isNative`. Tomorrow's Android demo
records inside the Capacitor app, so this hero never renders.

Defer to a follow-up PR — the marketing site copy refresh is its
own conversation (Tranche-1 product framing is "discounts on
crypto-paid gift cards", not "earn cashback").

### B. `/cashback` and `/cashback/:slug` route copy

Both surface "Earn cashback in LOOP-asset stablecoin... recycle it
into more orders for compounding rewards" — heavy Tranche-2
messaging. Both are gated by `phase1Only` per
`docs/tranche-1-launch.md` §"User-hidden" and resolve to "coming
soon" placeholders in Phase 1 (`Phase2Gate` component wraps them).
No demo path lands on these routes.

### C. Onboarding screens

Spot-checked `screen-currency.tsx` and `screen-wallet-intro.tsx` —
both are conditionally skipped under `phase1Only` per the
`Onboarding` orchestrator's step list (lines 103–108). The
remaining steps (welcome, how-it-works, brands, email, OTP,
biometric, welcome-in) carry generic copy that reads correctly in
both phases.

### D. Purchase flow (`PurchaseContainer`, `LoopPaymentStep`, `PurchaseComplete`)

Read in full. Copy is functional / state-machine-driven — no
Phase-1/2 messaging mismatch. The "Save N%" badge in the order
summary correctly reflects what the user is paying. Loop-native
payment screen renders the deposit address + memo + QR + SEP-7
correctly. All within the Tranche-1 acceptance flow.

### E. `/orders` route + order detail (`/orders/:id`)

Read both. Copy is generic ("Pending payment", "Procuring",
"Fulfilled", "Buy gift card", "View merchant"). No Phase-1/2 leak.
The post-fulfillment redemption surfaces (`RedeemFlow.tsx`) read
correctly in either phase.

## What this audit didn't catch

Limits worth being honest about:

- **Visual / interaction issues** that aren't text-shaped. A
  misaligned button, a slow render, a flickering animation — none
  of these surface in a code walk. Recommend a single dry-run on a
  physical device tonight before recording tomorrow.
- **Copy that's correct in isolation but odd in narration.** "Save
  N%" reads fine in the UI but the demo voiceover may need to
  explain that the saving lands at order creation, not later.
  Voiceover script (in `docs/phase-1-demo-script.md`) already calls
  this out.
- **Backend-side Phase-1/2 mismatches.** PR #1330 added
  phase-toggle integration coverage on the order-creation path;
  Track A.6 in `docs/tranche-2-scoping.md` is the remaining gap.

## Tomorrow's demo confidence after this PR

The two fixes above land the visible-on-Android Phase-1 messaging
in line with what the user actually receives (instant discount).
The desktop-web copy and Tranche-2-gated routes don't render in
the demo path, so they don't move the demo-readiness needle.

Functional flow is robust per the existing test pyramid; the
remaining demo risk is platform-specific (physical device install,
TestFlight / APK behavior, Stellar testnet vs mainnet wallet
funding) and operator-side.
