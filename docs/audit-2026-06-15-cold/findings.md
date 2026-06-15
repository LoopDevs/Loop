# Cold Comprehensive Audit — 2026-06-15 — Findings

**Method.** 28 adversarial agents (16 vertical deep-dives + 12 whole-tree cross-cutting/ADR/flow sweeps) against the checklist in `./checklist.md`. Working tree = `fix/stranded-order-hardening` (≈ `main`); feature-branch code (wallet A–D, staff roles, ADR-036 burn, on-chain interest) inspected read-only via `git show`. Per-agent raw findings (with file:line evidence) are in `./raw/*.md` — this file is the **deduplicated, severity-ranked synthesis**.

**Coverage.** ~1,030 source files + 35 migrations + 5 workflows + 35 ADRs + 258 docs across 20 verticals + 17 cross-cutting sweeps + 10 end-to-end flows + ADR-by-ADR matrix. Per-vertical file-coverage proof in `./tracker.md`; ADR matrix in `./coverage-matrix.md` (+ `./raw/x-adr.md`).

**Raw counts (pre-dedup, inflated by overlap):** ~P0 16, P1 ~85, P2 ~110, P3 ~120. **After dedup → 5 canonical P0, 31 canonical P1**, plus a P2/P3 tail grouped below.

## Reading the severities — exposure matters more than the number

Loop runs in **Phase-1 discount mode by default** (0% user cashback; `LOOP_WORKERS_ENABLED` off; on-chain emission/burn/interest on unmerged branches). So several "P0/P1" defects are **gated or latent**, not live. Every finding below is tagged:

- **LIVE** — exploitable/observable on `main` with default Phase-1 config now.
- **GATED** — becomes live only in cashback mode / `LOOP_WORKERS_ENABLED` / on-chain payouts.
- **BRANCH** — exists only on an unmerged feature branch (don't merge as-is).
- **LAUNCH-GATE** — legal/compliance/store blocker, not a code defect.

**Headline:** no P0 is a _live, ungated, on-main money-loss or data-breach_ — the discount-mode core (orders, payments custody, ledger double-entry, auth, DB) is genuinely sound and well-tested. The P0s are (1) a WebView script-execution RCE class, (2) operator-tooling exposure, (3) the merge-blocking CI gate, (4) the gated cashback-burn conservation gap, and (5) a branch-only unbacked-mint bug. The dense P1 layer is where launch-readiness actually lives.

---

## P0 — Critical

### CF-01 [P0 · GATED] Redemption never burns returned LOOP → conservation break + monotonic drift

_Refs: raw/v-payments P0-1, v-credits P1-01, x-concurrency-financial X-1, x-flows F3-1, x-adr F-ADR-3_
`loop_asset` spend (`orders/transitions.ts:62-139`) debits the off-chain `user_credits` mirror but never routes the inbound LOOP to the issuer to burn — the documented "treasury/burn" step is a comment only on `main`. Because the deposit account **==** the operator account (ADR 010 topology note), redeemed LOOP re-funds the next payout → on-chain value duplication; the drift watcher latches positive and never recovers. The burn + drift-term fix lives only on `origin/fix/adr036-emission-burn`. **Gating:** discount-mode default + `LOOP_WORKERS_ENABLED` off. **Must close before cashback-mode launch:** merge ADR-036 burn (verify it closes CF-17), and split the deposit/operator accounts (or confirm burn makes co-location safe).

### CF-02 [P0 · LIVE] RedeemFlow executes upstream CTX-supplied scripts in the WebView

_Refs: raw/v-web-ui WEB-S1/WEB-S2_
The redemption WebView runs CTX-supplied `redeemScripts` verbatim — no allowlist, sandbox, or signature — and the `postMessage` gift-card result has no origin/shape validation. A compromised CTX response or MITM yields script execution in the redemption context (forged-code / data-exfil class). Sandbox the WebView, allowlist/validate scripts, and validate the postMessage origin+shape. (Co-owned orders/native.)

### CF-03 [P0 · LIVE (operator tooling)] Review servers world-bound + open SSRF; demo-seed can wipe prod ledger

_Refs: raw/v-tooling T-01/T-02/T-03 (+ T-05/T-06 stored XSS)_
`tools/ctx-catalog/review-server.mjs` + `domain-review-server.mjs` bind `0.0.0.0` with no auth/CSRF — anyone on the network can overwrite the production-apply decision file; `/img?u=` is an unauthenticated SSRF proxy (reaches cloud metadata). `demo-seed.mjs` issues destructive ledger `DELETE`s with no prod guard (runs against prod if `DATABASE_URL` is exported). Plus two stored-XSS holes from broken `esc()` in the review UIs. Bind localhost + add a token; allowlist the proxy; hard prod-guard demo-seed.

### CF-04 [P0 · LIVE (operational)] The required "Security audit" merge gate is RED

_Refs: raw/x-infra P0_
`npm run audit` exits 1 on `high=7` — a newly re-rated esbuild dev-server advisory (GHSA-gv7w-rqvm-qjhr) widened the range and pulled vite/tsx/tsup/drizzle-kit/@react-router/dev to HIGH. `scripts/check-audit-policy.mjs:67` has **no high-accept path** (only a moderate map). This blocks **every** merge to `main` and reds CI. Chain is dev/build-only, not runtime-exploitable. Fix: add a justified high-accept allowlist mirroring the moderate one (and/or bump `tsx` — non-major fix available). Also: the hono-deferral justification cites a non-existent peer-dep (`@hono/zod-openapi`); the real lib is `@asteasolutions/zod-to-openapi` (CF-P2).

### CF-05 [P0 · BRANCH] On-chain interest mints unbacked LOOPUSD/LOOPEUR + uses retired asset codes

_Refs: raw/v-wallet P0×2_
`feat/wallet-phase-d-interest`'s `interest-mint.ts` mints **all three** LOOP assets as issuer payments, but ADR 031 v7 says only GBPLOOP (classic, 1:1-backed) gets on-chain mints — LOOPUSD/LOOPEUR are DeFindex vault _shares_ whose yield is price growth; minting them creates unbacked tokens. It also uses retired codes `USDLOOP`/`EURLOOP` (renamed LOOPUSD/LOOPEUR in v7) in code + migration 0038 CHECKs + env. **Do not merge Phase-D as-is.**

---

## P1 — High (grouped; full evidence in raw/)

### Admin money-write safety (LIVE; requires a rogue/stolen admin bearer)

- **CF-06** Refund endpoint (`admin-credit-writes.ts`): no step-up gate, bypasses the daily-adjustment cap (cap filters `type='adjustment'`, refund is `type='refund'`), and never validates the orderId exists / belongs to the user / ≤ order amount → IDOR + fabrication + over-refund. _v-admin P1-1/2/3, x-security P1, x-adr F-ADR-5_
- **CF-07** Payout-compensation route: no step-up though it re-credits user balance. _v-admin P1-4_
- **CF-08** Step-up's "second factor" is the same login email OTP with no purpose binding — ADR 028's password-in-Keychain threat model doesn't hold on passwordless Loop. _v-admin P1-5_
- **CF-09** Web admin: step-up modal not mounted on the payouts route (retry dead-ends on 401), and the Idempotency-Key is regenerated per call → post-completion re-click double-applies. _v-admin P1-7, v-web-routes W-01_
- **CF-10** Read-audit Discord exfil tripwire fires only on `.csv`, not large JSON list pulls → admin PII cursor-walks unmonitored. _v-admin P1-6_
- **CF-11** Step-up mint handler (gates every destructive admin write) has **zero tests** + a false "covered" comment. _v-admin P1-8, x-tests X-T-02_

### Upstream (CTX) resilience on the live order path

- **CF-12** No 429 handling toward CTX — breaker counts 429 as success (never opens), no Retry-After, procurement `markOrderFailed`s instead of deferring → a CTX rate-limit becomes a self-sustaining hot loop. _v-ctx P1-01_
- **CF-13** Expired operator bearer (CTX 401) defeats pool failover — bearers are static, never rotated; 401 isn't retried/breaker-tripped/alerted, so an expired primary fails real paid orders while a healthy backup sits idle. _v-ctx P1-02_

### Cashback / payout / withdrawal correctness (GATED on cashback mode)

- **CF-14** All workers run in-process on every Fly machine — no leader election / `FOR UPDATE SKIP LOCKED`; the payout worker's "operator sequence numbers serialise" assumption is false across instances → `tx_bad_seq` churn → legit payouts go terminal `failed` under scale (`min_machines_running=1` masks it today). _x-concurrency-financial X-2_
- **CF-15** `LOOP_KILL_WITHDRAWALS` gates only the enqueue routes; the payout worker never reads it → queued withdrawal payouts keep draining during an incident. _x-flows F9-1_
- **CF-16** Cashback peg-break (home-currency changed post-order) writes off-chain credit but no `pending_payout`, only a Discord warn → permanent on/off-chain divergence; the notifier has no runbook. _x-flows F2-1, v-observability O-P1-01, x-docs D-03_
- **CF-17** Drift-watcher equation omits the redeemed-but-unburned pile and the withdrawal term → the only automated reconciliation latches `over`/`under` permanently and masks real over-mint (checklist §6/§25 violation). _v-payments P1-1, x-concurrency-financial X-3_
- **CF-18** `findOutboundPaymentByMemo` caps at ~600 records on the shared deposit+operator account (feed interleaved with inbound deposits) → a re-picked stuck payout's prior tx can scroll off the window → re-submit/double-pay. _v-payments P1-2_
- **CF-21** Failed withdrawal is marked `failed` with no auto-compensation → user left debited with no payout until a human notices. _x-flows F5-2_
- **CF-20** Order failed _after_ pay-ctx already paid CTX (and the user already paid) → no auto-refund (refunds are admin-only) → user + treasury loss on every post-pay-ctx redemption stall; failure is `log.error`-only, no operator-debt alert. _x-flows F1-1, v-orders P2-02_

### Extended markets (LIVE product gap)

- **CF-19** AE/IN/SA/AU/MX are geo-redirected + sitemap-indexed but the order path 400s non-USD/GBP/EUR (`loop-handler.ts:259`), FX feeds cover only USD/GBP/EUR, and 5 DB CHECKs lock to those three → ~286 SEO-promoted merchants are unbuyable. ADR 035 status is inaccurate. _v-catalog, x-adr F-ADR-1, x-flows F78-1, v-db, task #8_

### i18n / currency display (LIVE UX, money-figure correctness)

- **CF-22** Both i18n seams (`t()`/`messages.ts` and `i18n/format.ts`/`USER_LOCALE`) are imported by **zero** components → every UI string is hardcoded English and every customer amount formats `en-US`/`$` regardless of the `/gb/en` route. ADR 034 market-correctness holds only for `<title>`/meta. _x-a11y-i18n, x-quality P2-QUAL-02_
- **CF-23** Currency/bigint display defects: MobileHome hero hardcodes `$` (3 sites), LoopOrdersList headline shows no currency symbol, and fleet/treasury/solvency figures format via `Number(bigint)/100` (precision loss at scale); shared `formatMinorCurrency` loses precision past 2^53 on the exact aggregates it was built to protect. _v-web-ui WEB-M1..M5, v-shared P2-SHARED-01_

### Auth / web gating (LIVE)

- **CF-24** `StellarTrustlineStatus` + `OrderPayoutCard` aren't auth-gated → re-introduces the A2-1156 cold-start 401/refresh storm. _v-web-ui WEB-ST1_
- **CF-30** Loop-native auth has no admin-grant path → the admin surface is unreachable when `LOOP_AUTH_NATIVE_ENABLED=true` (every native session is `isAdmin=false`; the allowlist only applies to CTX-anchored users). _v-auth P1_
- **CF-31** Brand page (`brand.$slug.tsx`) groups the full unfiltered catalog country-agnostically → a `/us/en` visitor sees CA/GB/EUR variants mixed (ADR 034 scoping not applied). _v-catalog C-01_

### Data / privacy / legal (LAUNCH-GATE)

- **CF-25** Gift-card redeem codes/PINs stored **plaintext at rest** (`loop-readonly` can SELECT) → cash-equivalent bearer leak on any logical DB compromise. _x-privacy X-PRIV-03_ (closest to a live data risk; encrypt at rest)
- **CF-26** DSR delete/export exist server-side but have no in-app UI (+ no runbook) → GDPR friction + Apple 5.1.1(v); no terms-acceptance / 18+ capture at signup (Terms assert both); zero sanctions/OFAC/geo eligibility screening of users or payout destinations; e-money/custody/yield licensing + mandatory "no-guarantee" disclaimers entirely deferred (held off users only by `LOOP_PHASE_1_ONLY`). _x-privacy X-PRIV-01/02/04/05/06_

### Mobile (LAUNCH-GATE / store rejection)

- **CF-27** Sign-in-with-Apple is wired server-side but **no UI button exists** while Google ships → App Store Guideline 4.8 rejection; native Google renders the GSI web SDK inside the Capacitor WebView which Google blocks (`disallowed_useragent`). Email-OTP still works (degraded, not broken). _v-mobile M-01/M-02_
- **CF-36** ADR 027 binary-tamper deferral trigger ("distribution outside official stores") is **met** by the planned APK sideload, but the ADR records it unmet and there's no dated acceptance/impl decision. _x-adr F-ADR-2, v-mobile M-03_

### Tests / regression guards

- **CF-28** The stranded-order/pay-ctx class (this branch's namesake) has no worker-level regression guard — `procure-one.ts` has no co-located test and every test mocks `payCtxOrder` to succeed, so a refactor reordering `markOrderFulfilled` ahead of `payCtxOrder` would re-strand orders and still pass CI. _x-tests X-T-01, v-orders P2-01_

### Performance (LIVE at scale)

- **CF-29** Growth cliffs: unwindowed full-table aggregates in public cashback-stats (crawler surface, no compute cache, no `type` index); clustering re-filters the full ~116k-location array O(N) per request; web prefetches the full ~1,134-merchant catalog on every route + `refetchOnWindowFocus`; ~540KB Sentry SDK static-imported into the root chunk; missing plain `created_at` indexes on `orders`/`credit_transactions` → seq scans on the most-opened admin views. _x-perf PERF-001..005_

### Observability / docs (LIVE operational risk)

- **CF-33** Incident runbooks paste commands using a non-existent `$LOOP_STELLAR_OPERATOR_ID` and the wrong floor var (`LOOP_USDC_FLOOR_STROOPS` vs real `LOOP_STELLAR_USDC_FLOOR_STROOPS`) → fail silently mid-incident; `LOOP_PHASE_1_ONLY` (the launch gate) is undocumented and `lint-docs.sh`'s digit-blind regex never catches it. _x-docs D-01/02/04/05_
- **CF-34** `error-codes.md` drift: 12 returned codes undocumented; `WEBHOOK_NOT_CONFIGURED` documented 503 but handler/OpenAPI return 409. _v-observability O-P1-02_

### Accessibility (LAUNCH-GATE; money paths are the _least_ accessible)

- **CF-35** Payment state/redemption-code updates have no `aria-live` (SR users get zero feedback that payment landed); hard countdown with no extend (WCAG 2.2.1); a single shared `copied` boolean flips both copy buttons → **memo-strand risk for all users**; missing focus traps on CountrySelector / MapBottomSheet / onboarding; cluster map markers have no accessible name / keyboard activation; broken roving-tabindex on `role=radiogroup` rail/currency pickers; no skip-link, missing `<main>` landmarks, hardcoded `<html lang="en">`. _x-a11y-i18n (7 agent-rated P0 + 12 P1, normalized here as P1 launch-gate)_

### Wallet branch blockers (BRANCH; not mergeable as-is)

- **CF-32** Privy `raw_sign` is missing the `privy-authorization-signature` header (no P-256 auth key / env) → the entire hash→rawSign→verify→submit pipeline is non-functional vs real Privy (no wallet can activate); Privy webhook handler absent (only the generic HMAC primitive, orphaned); ADR 030/031 are `Status: Proposed` with an explicit "no implementation until DD" gate that all 5 phases violate; DeFindex vault path unbuilt; web mislabels APY as "APR" + missing the ADR-031 no-guarantee disclaimer + WalletCard bypasses `LOOP_PHASE_1_ONLY`. _v-wallet P1×7_

---

## P2 / P3 — themes (full detail in raw/; ~110 P2 + ~120 P3 pre-dedup)

- **DRY / dead code:** ADR-034 money-formatter migration stalled — two live currency helpers (`utils/money.ts` live, `i18n/format.ts` dead), `formatMinor` duplicated across 15 components, `csvRow` re-implemented 17×, decimal↔stroops ×5; ~12 orphaned modules (`services/geo.ts`, `services/stellar-wallet.ts` stub, `FixedSearchButton`, `components/ui/index.ts` barrel, `apy-snapshot.ts`, `webhooks/hmac-verify.ts`, `utils/admin-cache.ts`, two home StatsBands) + a long tail of orphaned type-only re-exports. _x-quality, background scans_
- **Idempotency asymmetry:** LOOP payout worker matches memo only (ignores the amount/asset that pay-ctx now checks); loop-order idempotency is opt-in/header-gated. _x-adr F-ADR-4, x-concurrency-financial_
- **DB:** no down-migration/reversibility story; stale `0000_snapshot.json`; boot migrator shares the 30s statement*timeout (large data-migration self-aborts); withdrawal at-most-once rests on a single index with a misleading docstring fence. \_v-db*
- **Privacy P2:** OTP/refresh-token rows never purged (unbounded PII growth, missing sweep despite a schema comment); CSV escapers lack formula-injection guard; two monitoring notifiers emit full user*id+order_id. \_x-privacy*
- **Perf P2:** ~9 missing admin filter indexes; drift watcher seq-scans `user_credits`; unvirtualized ~982-card home grid; payout/cashback cards `refetchInterval` with no terminal stop. _x-perf_
- **Platform/observability P2:** Privy webhook unbuilt (PLAT-01); no `check:notifier-coverage` gate (every `notify*` should require a runbook); HSTS/headers ride Hono defaults rather than pinned. _v-platform, v-observability_
- **Catalog P2:** `cashback-preview` echoes slug-as-id; same-brand+country dupes resolve non-deterministically (bookmarked gift-card URL can flip merchants); preview bps uses float `Math.round`. _v-catalog_
- P3 tail: ~120 nits (naming, missing canonical/sitemap entries, doc-index gaps, AGENTS middleware-stack doc drift, license version drift, bundle-budget stated 3 ways, etc.) — enumerated per file in `raw/*.md`.

## False positives the audit corrected (credibility notes)

- Money is **not** carried as float on any settled value — ~60 `Number()`-on-money sites are all display/rate/bounds, 0 do float math on stored money (legacy CTX-proxy wire shape is the only money-float, P3). _x-correctness_
- Withdrawal drift is **not** a treasury double-pay (sub-agent over-flagged) — it's a drift-accounting term, not lost money. _x-flows F5-1_
- `Spinner` already has `role=status`; Navbar search combobox is a valid pattern; `tabular`/`LinkWalletNudge` flags refuted. _x-a11y-i18n, v-web-ui_
- Both Fly apps (api + web) **are** deployed; Dockerfile/fly.toml parity is clean (historical drift class absent). _x-infra_

## Launch-readiness verdict by tranche

- **Tranche 1 (discount, XLM) — code GREEN with a fixable P1 layer.** No live ungated P0 money/data defect. Blockers to clear before public order traffic: CF-04 (CI gate), CF-02 (RedeemFlow scripts), CF-12/13 (CTX resilience), CF-20 (post-pay-ctx refund), CF-19 (extended-markets buy CTA), CF-22/23 (i18n/currency), CF-24/30/31 (auth/admin/brand), CF-25 (codes at rest), CF-26/27/35/36 (legal/store/a11y), CF-28 (regression test), CF-33/34 (runbooks). CF-03 tooling is operator-hygiene.
- **Tranche 2 (cashback/wallet/yield) — NOT ready.** Must merge ADR-036 burn + close CF-01/CF-14/CF-15/CF-16/CF-17/CF-18/CF-21 before enabling cashback mode + workers; wallet branches (CF-05, CF-32) need the Privy auth-key contract, asset-code rename, and the Proposed→Accepted DD gate.
- **Tranche 3 — not started** (expected).
