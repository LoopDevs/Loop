# Cold Audit — Cross-Vertical Flows (Part 3) + Completeness Sweep (Part 5)

Branch `fix/stranded-order-hardening` (main +1 = `43c7b4ce` pay-ctx hardening). Date 2026-06-15.
Method: traced each of the 10 flows hop-by-hop reading the actual seam files; verified agent
findings against source; resolved the ADR-035 order-path conflict at `orders/loop-handler.ts`.

Finding format: `[ID] Pn — vertical — seam (fileA→fileB) — description | impact | evidence | fix`.

---

## PART A — Per-flow gap list

### Flow 1 — Purchase (discount): web → /orders/loop → watcher → paid → procureOne → pay-ctx → redemption → fulfilled → barcode

- **[F1-1] P1 — orders — procure-one.ts → transitions.ts (no refund on fail-after-pay).**
  Once `payCtxOrder` succeeds (CTX paid, operator XLM spent) a later `waitForRedemption`
  CTX-rejection throw (`procurement-redemption.ts:198`) OR the 15-min `sweepStuckProcurement`
  flip lands in the outer catch → `markOrderFailed` (`procure-one.ts:308-329`,
  `transitions.ts:232`). The user has ALREADY paid Loop and CTX has ALREADY been paid, but the
  order is `failed` with **no automatic refund** — `applyRefund` is admin-only
  (sole caller `apps/backend/src/admin/refunds.ts`; sweep comment "operator must reconcile
  manually before any user-facing refund", `transitions-sweeps.ts:79`).
  Impact: silent user money-loss + operator XLM loss on every redemption-stall/timeout that
  crosses pay-ctx. Evidence: `apps/backend/src/orders/procure-one.ts:233-330`.
  Fix: emit a `refund`-typed credit (or pending compensation row) on `markOrderFailed` when
  `ctx_order_id` set and payment already received; or queue auto-compensation.

- **[F1-2] P2 — orders — procurement-worker.ts → procurement-redemption.ts (15-min sweep vs 5-min wait OK, but transient submit not retried).**
  `PayoutSubmitError` transient kinds during pay-ctx are NOT retried — `procureOne` fails the
  order immediately (`procure-one.ts:252-265`) rather than reverting to `paid` for the next
  tick (only `OperatorPoolUnavailableError` reverts, line 309-322). A transient Horizon blip on
  the pay-ctx submit terminally fails an order the user paid for.
  Fix: revert `procuring→paid` on `transient_*` submit kinds like the pool-unavailable path.

- **[F1-3] P3 — orders — redemption tail OK.** Backfill sweeper has backoff + hard cap (10) +
  one-shot Discord page on exhaustion (`redemption-backfill.ts:24,55`). PII guard correct
  (only logs body when all redemption fields null, `procurement-redemption.ts:95`). No gap.

### Flow 2 — Cashback emission: fulfillment → credit_transactions + user_credits + pending_payouts → payout worker → Stellar → drift

- **[F2-1] P1 — credits — fulfillment.ts (peg-break path drops on-chain side with no durable intent).**
  When `order.chargeCurrency !== userRow.homeCurrency` (support changed home currency
  post-order) cashback lands off-chain but NO `pending_payouts` row is created — only a Discord
  warn (`fulfillment.ts:144-160,201`). Nothing durably drives the on-chain emission later.
  Impact: permanent off-chain/on-chain divergence + drift accrual with no recovery row if the
  Discord blip is missed. Fix: write a deferred/blocked payout row, not a log line.

- **[F2-2] P2 — credits — fulfillment.ts → payout-builder.ts (no_address/no_issuer skip = silent off-chain-only).**
  `buildPayoutIntent` skip reasons (`payout-builder.ts:116-125`) make cashback off-chain-only
  with no pending row and no backfill over `user_credits` vs `pending_payouts`. A user who later
  links a wallet never gets the on-chain emission for already-fulfilled orders.
  Fix: backfill sweep, or a blocked-payout row keyed to "awaiting wallet/issuer".

- **[F2-3] P2 — payments — payout-worker-pay-one.ts → horizon-find-outbound.ts (idempotency-read wedge invisible).**
  Sustained `findOutboundPaymentByMemo` throw returns `retriedLater` every tick and never
  submits (`payout-worker-pay-one.ts:150-161`) — correct fail-closed, but the stuck-payout
  watchdog counts age only, not cause; a row wedged on a Horizon schema-drift read is
  indistinguishable from a normal pending row. Fix: surface "blocked on idempotency read".

### Flow 3 — Redemption/spend: web → markOrderPaid(loop_asset) → debit user_credits + inbound LOOP → burn → drift

- **[F3-1] P1 — credits/payments — transitions.ts markOrderPaid (inbound LOOP never burned; ADR 036 gap).**
  Doc-comment says loop_asset spend routes "the inbound LOOP-asset to a treasury / **burn
  account**" (`transitions.ts:39-40`) but the code only debits `user_credits`
  (`transitions.ts:130-133`). The user's inbound LOOP sits in the deposit account, circulation
  does NOT fall, off-chain ledger DOES. Inverse of the withdrawal drift. ADR-036 issuer-return
  burn is **unimplemented on this branch** (lives only on `fix/adr036-emission-burn`).
  Impact: every loop_asset spend pushes drift positive by the spent amount; over time trips the
  drift alarm and breaks circulation↔liability reconciliation. Evidence:
  `apps/backend/src/orders/transitions.ts:39-133`. Fix: land ADR-036 burn or net the deposit-held
  LOOP out of the drift equation.

### Flow 4 — Interest: scheduler → snapshot → mint → mirror → APY → drift

- **[F4-1] P1 — credits — accrue-interest.ts (off-chain mint with no on-chain settlement).**
  `accrueOnePeriod` writes `credit_transactions(interest)` + bumps `user_credits`
  (`accrue-interest.ts:156-171`) but creates NO payout and triggers NO on-chain forward-mint —
  on-chain interest mint is **not on this branch** (only `feat/wallet-phase-d-interest`, with a
  `workers/` dir + migration `0038_interest_mint_onchain.sql`). Pure off-chain liability increase
  raising drift until an operator manually mints; only backstop is the pool-cover Discord alert.
  Impact: interest accrual is off-chain-only on main; drift goes negative as interest accrues.

- **[F4-2] P2 — credits — interest-scheduler.ts (no gap-fill / catch-up).**
  Cursor is wall-clock UTC date (`interest-scheduler.ts:80`); a process down across UTC midnight
  (or for days) never accrues the missed days — next tick only uses today's cursor. Idempotency
  index prevents double but nothing fills gaps. Users silently lose interest for downtime days.

- **[F4-3] P2 — credits — accrue-interest.ts (silent partial accrual).**
  Non-unique-violation per-row txn errors are logged and the loop CONTINUES
  (`accrue-interest.ts:197-201`); no failed-user count in `AccrualResult`, cursor advances for
  others. A user hitting a transient lock silently misses the period with no telemetry beyond a log.

- **[F4-4] P3 — credits/payments — interest-pool-watcher.ts (`Number()` on bigint stroops).**
  `Number(poolStroops)/Number(dailyInterestStroops)` (`interest-pool-watcher.ts:104-105`) loses
  precision past 2^53 at treasury scale; days-of-cover threshold can mis-fire. Low near-term risk.

### Flow 5 — Withdrawal: writer → debit + pending_payout(withdrawal) → worker → Stellar → compensation

- **[F5-1] P1 — credits/payments — withdrawals.ts → asset-drift-watcher.ts (withdrawal not drift-neutral).**
  A withdrawal debits `user_credits` (ledger ↓ by amount) AND queues a payout that RAISES
  circulation (on-chain ↑ by amount×1e5). Drift = `onChain − pool − ledger×1e5`
  (`asset-drift-watcher.ts:210`), so each withdrawal moves drift by **+2×amount**. Withdrawals
  trip the drift alarm by design and mask real over-minting; the watcher has no `kind='withdrawal'`
  concept. Evidence: `withdrawals.ts:138-193`, `liabilities.ts:18`, `asset-drift-watcher.ts:210`.
  Fix: subtract outstanding-withdrawal-payout stroops (and deposit-held inbound LOOP) from the
  on-chain side of the drift equation. NOTE: this is NOT a treasury double-pay (the off-chain
  credit and on-chain LOOP are two representations of the same liability — withdrawal swaps
  representation); the gap is purely the drift model, not user/treasury loss.

- **[F5-2] P1 — payments — payout-worker-pay-one.ts (no auto-compensation on failed withdrawal).**
  `payOne` marks failed withdrawals `failed` (`payout-worker-pay-one.ts:250`) but never calls
  `applyAdminPayoutCompensation` — compensation is manual-only (`credits/payout-compensation.ts`,
  `admin/payout-compensation.ts:11` "deferred to a later ADR"). A terminally-failed withdrawal
  leaves the user net-negative (debited, no payout) until a human notices via Discord. No SLA.
  Fix: auto-compensate (re-credit) on terminal withdrawal failure, or alert with a recovery runbook.

- **[F5-3] P1 — config — kill-switches.ts → payout-worker.ts (LOOP_KILL_WITHDRAWALS doesn't gate the worker).**
  See [F9-1]. The withdrawals kill blocks the enqueue routes only; already-queued withdrawal
  payouts keep draining to Stellar. Fail-open against the operator's incident intent.

### Flow 6 — Auth: request-otp → email → verify → JWT → requireAuth-everywhere → refresh → social-link

- **[F6-1] OK — every protected resource is guarded.** `requireAuth` on `/api/orders` + `/*`
  (`routes/orders.ts:57`), `/api/users/me` + `/*` (`users.ts:88`), `/api/admin/*` (`admin.ts:125`),
  `/api/merchants/:id` authed (`merchants.ts:93`). Public reads intentionally open. Refresh
  rotation has reuse-detection + family revoke. Kill-switch `auth` correctly leaves refresh+logout
  open (`kill-switches.ts:11-14`). Boot refuses native-auth-on without a real EMAIL_PROVIDER
  (`index.ts:40-49`). No bypass found.
- **[F6-2] P3 — auth — refresh-tokens.ts → routes/auth.ts (documented-but-unwired "sign out everywhere").**
  `revokeAllRefreshTokensForUser` docstring cites `DELETE /api/auth/session/all` but only
  `DELETE /api/auth/session` is mounted. No self-serve global logout; function reachable only via
  internal reuse-revoke. Fix: wire the route or correct the docstring.

### Flow 7 / Flow 8 — Catalog + Geo/locale (the central ADR-035 seam)

- **[F78-1] P1 — catalog/web/orders — countries.ts/merchant filter → loop-handler.ts (served-but-unorderable extended markets).**
  RESOLVED CONFLICT between sub-agents by reading source: `loop-handler.ts:259-267` hard-rejects
  any gift-card `currency` not in {USD,GBP,EUR}. FX conversion at `:275` only converts AMONG those
  three home currencies — it does NOT enable AED/INR/SAR/AUD/MXN gift-card currencies. So every
  extended-market merchant (ADR 035 display countries AE/IN/SA/AU/MX) is shown by the web filter
  but **cannot be ordered** via loop-native. Meanwhile geo-redirect 302s visitors into `/ae/en`…
  `/mx/en` (`home-geo-redirect.tsx`, `resolveCountryPath`) and the sitemap publishes indexable
  landing pages for all 5 (`sitemap.tsx`). SEO-promoted countries with a structurally broken
  purchase funnel. Evidence: `apps/backend/src/orders/loop-handler.ts:259-267`,
  `packages/shared/countries.ts`, `apps/web/app/routes/home-geo-redirect.tsx`,
  `apps/web/app/routes/sitemap.tsx`. This is the ADR-035 "order-path gap" made concrete — the
  single biggest cross-layer seam. Fix: either gate extended markets out of geo-redirect+sitemap
  until the order path lands, or implement the rates-API extended-currency order path.

- **[F78-2] P2 — orders — handler.ts (legacy) ↔ loop-handler.ts (loop) (currency gating diverges).**
  Legacy `/api/orders` proxies any merchant currency to CTX (no home-currency check); loop-native
  rejects non-USD/GBP/EUR. Same merchant orderable on one path, not the other.

- **[F78-3] P2 — web — brand.$slug.tsx → merchant-groups.ts (filter/group disagree).**
  Brand page groups `useAllMerchants()` with NO `merchantInCountry` filter while home/search/mobile
  filter-then-group; grouping key is country-agnostic, so out-of-country variants surface and route
  to the unorderable path. Evidence: `apps/web/app/routes/brand.$slug.tsx:40`.

- **[F78-4] OK — geo/SEO source-of-truth unified.** geo-redirect, sitemap, locale-layout all read
  `packages/shared/countries.ts`. Self-canonicals + reciprocal hreflang present; no country-list
  drift, no hreflang non-reciprocity.

### Flow 9 / Flow 10 — Config/flags + Mobile

- **[F9-1] P1 — config — kill-switches.ts (docstring) → payout-worker.ts (withdrawals kill is fail-open at the worker).**
  `LOOP_KILL_WITHDRAWALS` is documented as the incident lever to stop outbound on-chain payouts,
  but `runPayoutTick` never reads it — it only gates the enqueue routes (`routes/admin-payouts.ts`
  withdrawals POST + compensate POST). An engaged switch keeps draining queued payouts to Stellar.
  Critical during a leaked-operator-key incident. Fix: check `isKilled('withdrawals')` in the
  worker tick (skip `kind='withdrawal'` rows) and in `POST /payouts/:id/retry`.
- **[F9-2] P2 — config — admin-payouts.ts retry not gated by withdrawals kill.**
  `POST /api/admin/payouts/:id/retry` re-submits an outbound on-chain payout (its own comment
  flags duplicate-transfer risk) with step-up but NOT `killSwitch('withdrawals')`. Inconsistent
  gating of equally-dangerous outbound-transfer routes.
- **[F9-3] OK — flag hygiene.** Strict fail-closed kill-switch parsing (`kill-switches.ts:81-104`);
  per-path order precedence works; no undocumented flags; AGENTS.md ↔ env.ts match. Workers gated on
  `LOOP_WORKERS_ENABLED` (startup-only read — root cause of F9-1).
- **[F10] Mobile — not deeply traced this pass** (covered by `raw/v-mobile.md`); static-export
  constraint + native boundary intact per index.ts/AGENTS rules. Version-skew note: mobile static
  bundle can't force-update vs backend API — the unorderable-extended-market gap (F78-1) would
  hit shipped mobile clients identically.

---

## PART B — Completeness inventory

### B1. Stubs / unimplemented / empty handlers

- `apps/web/app/services/stellar-wallet.ts:33,64,79` — every export THROWS (web on-device Stellar
  signing, deferred Phase 2). Real stub, intentional.
- `apps/web/app/components/features/purchase/LoopPaymentStep.tsx:240` — `TODO(adr-pending)`:
  "integrate Stellar Wallets Kit v2" (matches the stub above). Only live TODO of substance.
- `apps/backend/src/auth/email.ts` — `console` email provider is a dev-only stub; **boot refuses it
  in production** (`index.ts:40-49`). Gated, intentional.
- No 501/`NOT_IMPLEMENTED`/throwing route handlers in backend. TODO/FIXME count across non-test
  source = 5, all benign (`scripts/.../note` strings, doc-comment "X.XXX" placeholders).

### B2. Gated-off code / dead flags

- No orphaned env vars — every `LOOP_*` flag is read outside env.ts/tests.
- Permanently-off-by-default: `LOOP_WORKERS_ENABLED` (umbrella), `INTEREST_APY_BASIS_POINTS=0`
  (double-gates interest off with `LOOP_WORKERS_ENABLED`), `LOOP_PHASE_1_ONLY` (Phase2Gate),
  all `LOOP_KILL_*`. All wired.

### B3. Half-built feature branches (vs main, read-only git)

- **Wallet Privy A-D** (`feat/wallet-phase-{a-rs256-jwks,b-provider,c-flows,c-web,d-interest}`):
  linear stack, each ~1 behind main (stale base), unmerged. C-flows (129 files) + D-interest
  (139 files, on-chain mints) touch money paths. Needs rebase. Not merge-ready.
- **ADR-036 burn** (`fix/adr036-emission-burn`): +2/**−4 behind main**, renames
  `withdrawals.ts→emissions.ts`, adds `credits/emissions.ts` + migration
  `0035_adr036_emission_and_burn_kinds.sql`. Money path, most behind of the set. This is the branch
  that fixes F3-1.
- **Staff/RBAC ADR-037** (`feat/staff-roles-backend` +11 / `feat/staff-dashboard-web` +14):
  migration `0039_staff_roles.sql`.
- **Roll-up** (`feat/token-authoritative-balance` +17, 228 files / 17k+ lines): integration tip
  carrying ADR-036 + wallet-C + staff. Largest gap, least merge-ready.
- All carry migrations 0035–0039, consistently chained, **no collisions**; all touch ledger/payout.

### B4. Orphaned files

- `apps/backend/src/webhooks/hmac-verify.ts` — only test importers, **no route mounts it**; built
  ahead of the Privy webhook handler that doesn't exist on main. Real orphan.
- `apps/backend/src/credits/apy-snapshot.ts` — only its own test imports it; no caller wires the
  on-chain share-price source it needs (ADR 031 / "Track G"). Effectively orphaned/un-sourced.
- CLI entrypoints (`migrate-cli.ts`, `scripts/check-migration-parity.ts`, `scripts/quarterly-tax.ts`)
  are run via package.json scripts, not imported — not orphans.
- Migrations 0000–0034 all on disk AND in `meta/_journal.json` — no orphaned migration.

### B5. Documented-but-unimplemented (on main / this branch)

- **ADR-036 issuer-return BURN on redemption** — NOT on main. Zero `clawback/burnAsset/sendToIssuer`
  in credits/payments; the loop_asset-spend "burn account" comment is a comment only
  (`transitions.ts:39-40`). Lives on `fix/adr036-emission-burn`. (= F3-1.)
- **DeFindex vault (ADR 031)** — NOT implemented; 2 comment mentions only
  (`discord/monitoring.ts`, `procurement-asset-picker.ts`). APY share-price source unwired.
- **Privy webhook handler (ADR 030)** — NOT present; `webhooks/` has only the unmounted
  `hmac-verify.ts` utility + tests. No `/webhooks/privy` route.
- **On-chain interest mint** — NOT on main (off-chain mirror only, `accrue-interest.ts`); on-chain
  mint + `workers/` dir + `0038_interest_mint_onchain.sql` live on `feat/wallet-phase-d-interest`.
  (= F4-1.)
- **Extended-market AE/IN/SA/AU/MX ORDER path with FX (ADR 035)** — display-only;
  `loop-handler.ts:259` caps gift-card currency at USD/GBP/EUR; rates-API extended-currency
  conversion is absent. (= F78-1, the central seam.)
- **On-chain MINT / BURN generally** — no issuer-side issuance or burn op anywhere on main; all
  "mint"/"forward-mint" is operator `Operation.payment` of pre-held LOOP (`payout-submit.ts`).
  Peg depends on operator pre-funding + accounting discipline.
- Admin step-up auth (ADR 028) is **implemented**, not stubbed — `POST /api/admin/step-up` mounted;
  503 only when signing key unset (config-gate, fail-closed).

### B6. Unwired routes

- All 7 top-level route modules mounted in `app.ts:15-21`; all 12 admin sub-routers mounted via
  `mountAdminRoutes`. No unmounted route file, no unrouted exported handler.
- Unwired endpoints: `DELETE /api/auth/session/all` (F6-2, documented-but-unmounted);
  `/.well-known/jwks.json` is NOT mounted on main (lives on wallet Phase-A branch).

---

## Summary

10 flows traced. **P0: 0.** **P1: 8** — F1-1 (no refund on fail-after-pay, user+treasury loss),
F2-1 (peg-break cashback drops on-chain intent), F3-1 (loop_asset inbound LOOP never burned →
positive drift; ADR-036 gap), F4-1 (interest off-chain-only, no on-chain mint on main),
F5-1 (withdrawal not drift-neutral, +2× drift), F5-2 (no auto-compensation on failed withdrawal,
silent user net-negative), F9-1 (LOOP_KILL_WITHDRAWALS fail-open at the worker), F78-1 (extended
markets served+SEO-indexed but unorderable — central cross-layer ADR-035 seam).
**P2: 7**, **P3: 4**.

Three recurring root causes: (1) the drift model only knows cashback emission, not the inverse
flows (spend-burn, withdrawal, interest) — multiple P1s collapse once the drift equation nets out
deposit-held inbound LOOP + outstanding withdrawal payouts (F3-1/F5-1) and on-chain mint/burn lands
(ADR-036 branch); (2) fail-after-payment paths lack automatic compensation/refund (F1-1/F5-2) —
all recovery is manual-via-Discord; (3) ADR-035 extended markets are wired into geo+SEO ahead of
the order path (F78-1). The pay-ctx hardening on this branch correctly closes the
memo-collision double-pay class; the open seams are downstream of a _successful_ pay-ctx.

NOTE on a sub-agent over-flag: the "withdrawal double-pay treasury loss" claim is incorrect — the
off-chain credit and on-chain LOOP are two representations of one liability; withdrawal swaps
representation. The real defect is the drift-model blind spot (F5-1) and missing compensation (F5-2).

Completeness: clean stub surface (5 TODOs, all benign). On-chain mint/burn, ADR-036 burn, DeFindex
vault, Privy webhook, on-chain interest, and the ADR-035 order path are all documented-but-absent
on main; burn + on-chain interest + staff RBAC live on unmerged, behind-main, money-touching
branches needing rebase before they're merge-ready.
