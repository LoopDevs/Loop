# Cold Audit 2026-06-15 — Remediation Plan

Sequenced PR batches for the canonical findings in `findings.md`. Ordered by **dependency** (the CI gate unblocks everything) then **exposure** (LIVE before GATED before BRANCH before LAUNCH-GATE). Review tags: ✅ = self-contained / CI-mergeable · 🔒 = money/auth/Stellar → **Ash review before merge** (per repo rule). Each batch is a disjoint PR; audit-batch-mode (stacking disjoint PRs) applies.

> **Keystone:** CF-04 (audit gate) is RED and blocks every push/merge — including the already-built `fix/stranded-order-hardening` PR. It lands first; subsequent branches stack on it until it merges to `main`, then rebase.

## Wave 0 — Unblock CI ✅

- **PR A · CF-04** — add a justified high-accept allowlist to `check-audit-policy.mjs` for the dev-only esbuild advisory chain (esbuild/vite/vite-node/tsx/tsup/drizzle-kit/@react-router/dev), move esbuild+drizzle-kit moderate→high, fix the phantom `@hono/zod-openapi` justification (real lib `@asteasolutions/zod-to-openapi`), bump `tsx` (non-major fix) where it drops a high. Update `docs/standards.md §15`. Files: `scripts/check-audit-policy.mjs`, `docs/standards.md`. **Unblocks all pushes.**

## Wave 1 — LIVE security (low coordination) mixed

- **PR B · CF-03** ✅ — operator tooling: bind review-servers to `127.0.0.1` + shared-token gate, allowlist `/img` proxy (block private/metadata), hard prod-guard `demo-seed.mjs`, fix `esc()` stored-XSS in both review UIs, redact proxy creds in logs. Files: `tools/ctx-catalog/{review-server,domain-review-server,demo-seed,scrape-media-proxied}.mjs`.
- **PR C · CF-02** 🔒 — RedeemFlow WebView: sandbox + script allowlist/signature + validate `postMessage` origin/shape. Files: web `RedeemFlow`/native redeem bridge. (redemption path → review)
- **PR D · CF-25** 🔒 — encrypt gift-card redeem codes/PINs at rest (app-layer envelope encryption + migration to ciphertext column; revoke `loop-readonly` plaintext). Files: `db/schema.ts`, migration, `orders/` redemption persistence, crypto util.
- **PR E · CF-24/CF-30/CF-31** 🔒 — auth-gate `StellarTrustlineStatus`+`OrderPayoutCard`; add loop-native admin-grant path; brand-page country scoping. Files: web components + `auth/`.

## Wave 2 — Admin money-write safety (LIVE, rogue-bearer) 🔒

- **PR F · CF-06/07/08** — refund: add step-up + route through the adjustment cap + validate orderId ownership/amount; step-up-gate payout-compensation; bind step-up tokens to a purpose/action claim. Files: `admin/credit-writes`, `admin/refunds`, `admin/payouts`, `auth/admin-step-up*`.
- **PR G · CF-09/CF-10/CF-11** — web: mount StepUp modal on payouts route + stable Idempotency-Key per intent; widen read-audit tripwire to JSON list pulls; add step-up-handler tests. Files: web admin routes, `admin/step-up-handler`, audit middleware, tests.

## Wave 3 — Order/CTX/payout resilience 🔒

- **PR H · CF-12/CF-13** — CTX 429 → defer+Retry-After (not fail), don't count 429 as breaker-success; 401 operator-bearer → mark unhealthy + fail over + alert + rotation path. Files: `ctx/operator-pool`, `circuit-breaker`, `orders/procure-one`.
- **PR I · CF-20/CF-21/CF-16** — auto-refund/operator-debt alert on post-pay-ctx order failure; auto-compensation on failed withdrawal; peg-break writes a durable `pending_payouts` row + runbook. Files: `orders/procure-one`, `credits/withdrawals`+`payout-compensation`, `orders/fulfillment`, runbook.

## Wave 4 — i18n / currency correctness (LIVE UX + money figures) mixed

- **PR J · CF-23** ✅ — route every currency render through `@loop/shared` money-format; fix `formatMinorCurrency` 2^53 precision; kill the duplicate `formatMinor`×15 + `Number(bigint)/100` sites. Files: shared `money-format`, ~15 web components.
- **PR K · CF-22** ✅ — wire the `t()` / locale-format seam into components (or formally retire one) so the `/:country/:lang` route actually localizes UI strings + amounts, not just meta. Files: web `i18n/**`, components. (large — may split)

## Wave 5 — Docs / observability / tests ✅

- **PR L · CF-33/CF-34** — fix runbook env-var bugs (`$LOOP_STELLAR_OPERATOR_ID`, floor var), document `LOOP_PHASE_1_ONLY`, fix `lint-docs.sh` digit-blind regex, reconcile `error-codes.md` (12 codes + 409/503), add missing runbooks (peg-break, interest-pool-low). Add `check:notifier-coverage` gate (every `notify*` ⇒ catalogued + runbook).
- **PR M · CF-28** ✅ — `procure-one.ts` worker-level regression test (pay-ctx failure ⇒ `failed`, never `fulfilled`; SEP-7-fail / missing-paymentUrls branches).

## Wave 6 — Performance ✅

- **PR N · CF-29** — migration adding `created_at` + filter indexes on orders/credit_transactions/payouts; window+cache public cashback-stats; clustering spatial bucketing; lazy-import Sentry off the web root chunk; gate the full-catalog prefetch + `refetchOnWindowFocus`.

## Wave 7 — Accessibility (LAUNCH-GATE) ✅

- **PR O · CF-35** — `aria-live` on payment/redemption; countdown extend (WCAG 2.2.1); split the shared `copied` boolean (memo-strand, all-user bug); focus traps on CountrySelector/MapBottomSheet/onboarding; accessible map markers + keyboard; fix radiogroup roving tabindex; skip-link + `<main>` + per-locale `lang`.

## Wave 8 — Extended-market order path (task #8) 🔒

- **PR P · CF-19** — rates-API FX conversion (~/code/rates), widen `HOME_CURRENCIES` + order-path validation + 5 DB CHECK constraints to AE/IN/SA/AU/MX (AED/INR/SAR/AUD/MXN), update ADR 035 status. Depends on the rates service change.

## Wave 9 — Privacy / legal (LAUNCH-GATE, partly non-code) mixed

- **PR Q · CF-26** — DSR in-app UI + runbook; terms-acceptance + 18+ capture at signup; OTP/refresh-token purge sweeps; CSV formula-injection guard. Sanctions/OFAC screening + e-money/custody counsel = operator/legal track (not code).

## Wave 10 — Mobile (LAUNCH-GATE) ✅

- **PR R · CF-27/CF-36** — add Sign-in-with-Apple button (App Store 4.8) + native Google plugin or hide GSI in webview; record the dated ADR-027/007 sideload-trigger decision.

## Cashback-mode track (GATED — before Tranche 2, not before Tranche 1) 🔒

- **CF-01** merge `fix/adr036-emission-burn` (issuer-return burn) + verify it closes **CF-17** drift terms; split deposit/operator accounts or confirm burn makes co-location safe.
- **CF-14** worker leader-election / `FOR UPDATE SKIP LOCKED` before scaling machines; **CF-15** payout worker reads `LOOP_KILL_WITHDRAWALS`; **CF-18** find-outbound window/scope fix.
- **Wallet branches (CF-05/CF-32):** fix on-branch before merge — Privy `privy-authorization-signature` key, asset-code rename USDLOOP/EURLOOP→LOOPUSD/LOOPEUR, mint only GBPLOOP, build Privy webhook + DeFindex vault, web APY-not-APR + disclaimer + `LOOP_PHASE_1_ONLY` gate. Blocked on Privy Soroban DD (task #21).

## Quality tail (rolling) ✅

- Dead-code/orphan removal (~12 modules), DRY money-formatter migration finish, `csvRow`/stroops dedup, DB down-migration story + snapshot refresh, missing admin indexes, header-pinning. From `raw/x-quality.md`, `raw/v-db.md`, background scans.

## Execution protocol

1. Land CF-04 (Wave 0) → unblocks pushes; rebase `fix/stranded-order-hardening` onto it.
2. Stack Wave 1+ branches off the latest mergeable base; one PR per batch; `verify.sh` green before push; never `--no-verify`.
3. 🔒 PRs (money/auth/Stellar) open for Ash review; ✅ PRs can merge on green checks.
4. Flip findings → resolved in `findings.md` as each PR merges.
