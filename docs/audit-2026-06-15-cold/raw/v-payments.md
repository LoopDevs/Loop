# V3 — Stellar / Payments vertical — cold audit (2026-06-15)

Branch: `fix/stranded-order-hardening` (≈ main). Scope: `apps/backend/src/payments/**`
plus `packages/shared/src/{stellar,loop-asset,payout-state}.ts` and the immediately
adjacent ledger/transition seams (`orders/transitions.ts`, `credits/payout-*`,
`credits/pending-payouts*`, `credits/payout-asset.ts`).

Dimensions applied: Stellar (§18), financial integrity (§25), concurrency (§11),
error handling (§4), observability (§6), correctness (§1), tests (§12), ADR 010/015/016.

---

### [P0-1] Redeemed on-chain LOOP is never burned / returned to issuer — circulation re-inflates and is re-spendable

- **severity:** P0 / Critical (financial integrity, ledger divergence, money re-creation)
- **file:** `apps/backend/src/orders/transitions.ts:29-138` (markOrderPaid loop_asset path); `apps/backend/src/payments/asset-drift-watcher.ts:163-254`; `apps/backend/src/credits/withdrawals.ts` (withdrawal burn intent)
- **impact:** When a user redeems by paying a gift card with their LOOP asset (`paymentMethod='loop_asset'`), `markOrderPaid` debits `user_credits` (off-chain liability −X) but performs **no on-chain action**. The doc-comment (transitions.ts:38-40) explicitly promises "routes the inbound LOOP-asset to a treasury / **burn** account" — that step does not exist anywhere in the tree (`grep burn|issuer-return` finds only comments; **ADR 036 referenced by the checklist does not exist as a file**). The inbound LOOP lands in `LOOP_STELLAR_DEPOSIT_ADDRESS`, which by ADR 010's documented Phase-1 topology **equals the operator account** that signs outbound payouts. Consequences: (a) Horizon `/assets.amount` counts LOOP held by any non-issuer account, so circulation stays flat while off-chain liability dropped by X → on-chain now over-represents liability by X; (b) because deposit==operator, the redeemed LOOP is immediately re-spendable as the source pile for the next cashback/withdrawal payout — the same X can fund a second on-chain payout with no new mint, i.e. economic value is duplicated on-chain even though the off-chain ledger is correct.
- **evidence:** transitions.ts:80-135 only does the `user_credits` debit + `credit_transactions` spend row; no `submitPayout`/issuer-return/account-merge follows. No sweep job moves deposit-account LOOP to the issuer (grep). ADR 010:151-153 confirms operator pubkey == deposit address.
- **fix:** Implement the issuer-return / burn leg as part of the redemption transaction's settled side-effect: queue an on-chain payment of the inbound LOOP from the deposit account back to the **issuer** account (payment to issuer = burn for a classic asset), tracked idempotently like payouts. Until built, the asset-drift watcher must account for it (see P1-2) and ADR 036 must be authored. Split deposit≠issuer at minimum so the burn is unambiguous.
- **ref:** ADR 015 (1:1 backing), ADR 036 (missing), checklist §18 burn, §25 "no money created across redemption/burn".

### [P1-1] Drift watcher equation omits deposit-account LOOP → pages permanently after any LOOP redemption

- **severity:** P1 / High (silent-failure-by-noise; reconciliation alert structurally non-recoverable)
- **file:** `apps/backend/src/payments/asset-drift-watcher.ts:210` (`driftStroops = onChainStroops − poolStroops − ledgerMinor × 1e5`)
- **impact:** The equation subtracts only the interest forward-mint pool, not LOOP that users have returned to the deposit account during redemption (P0-1). Each `loop_asset` redemption (and each withdrawal that debits but whose burn never lands) drives drift positive by X and it **never recovers** — circulation stays flat while liability fell. Once accrued past `LOOP_ASSET_DRIFT_THRESHOLD_STROOPS` the watcher latches `over` and `notifyAssetDrift` fires; it can only `recover` if drift falls back under threshold, which it cannot without a burn. This is precisely the "drift/reconciliation alert must be structurally recoverable, don't page permanently" failure (checklist §6, §18). After enough redemptions the drift alert becomes permanent noise and real over-mint incidents are masked.
- **evidence:** equation at line 210 has no deposit-account term; comment at 134-159 models only equilibrium + forward-mint, never the redemption inflow.
- **fix:** Either implement the burn (P0-1) so circulation actually falls, or extend the equation to subtract `getAssetBalance(depositAccount, code, issuer)` (the redeemed-but-unburned pile) the same way `poolStroops` is subtracted, so reconciliation stays honest until the burn ships.
- **ref:** ADR 015 drift detection; checklist §6 (recoverable), §18 (circulation vs liability).

### [P1-2] `findOutboundPaymentByMemo` page cap (~600 records) can miss a prior payout on the shared deposit+operator account → double-pay window

- **severity:** P1 / High (idempotency gap on a money-moving path)
- **file:** `apps/backend/src/payments/horizon-find-outbound.ts:41-91`; called from `payout-worker-pay-one.ts:123-149` and `orders/pay-ctx.ts`
- **impact:** The idempotency pre-check scans `order=desc` for at most `maxPages=3` × 200 = 600 payment records on the operator account. Because operator==deposit (ADR 010), that account's `/payments` feed interleaves **every inbound user deposit** with outbound payouts/pay-CTX. Under even modest deposit volume, a payout submitted >600 records ago (e.g. a row stuck in `submitted`, re-picked by the A2-602 watchdog after a Horizon blackhole) can have its prior landed tx pushed off the 600-record window. The pre-check then returns `null` → the worker re-submits a second tx for the same payout. `payOne` does not compare `prior.amount` either (P2-1), so even within the window a memo collision converges blindly.
- **evidence:** maxPages default 3 (line 41); shared-account interleaving documented ADR 010:161-168; reclaim path payout-worker-pay-one.ts:176-189 re-submits on `prior===null`.
- **fix:** Bound the scan by time/ledger (stop once records predate the payout's `submittedAt`/`createdAt`) rather than a fixed page count, or scan a payout-specific cursor; add a regression test seeding >600 interleaved records. Splitting deposit≠operator (ADR 010 Phase-2) shrinks the feed and is the durable fix.
- **ref:** ADR 016 idempotency; checklist §18 find-outbound, §11 idempotency-under-concurrent-retry.

### [P2-1] Payout idempotency converges on memo match without verifying amount/asset (asymmetric with pay-ctx hardening)

- **severity:** P2 / Medium (defense-in-depth; low collision risk because payout memos are random)
- **file:** `apps/backend/src/payments/payout-worker-pay-one.ts:122-149`
- **impact:** `pay-ctx.ts:126-156` was hardened (stranded-order class) to refuse an idempotency match unless `prior.amount` and asset also match — because CTX uses a shared destination + per-order memo. The payout path uses the _same_ `findOutboundPaymentByMemo` (which returns `amount`/`assetCode`) but ignores both, converging to `confirmed` on memo+from+to alone. Payout memos are `randomBytes(20)` base32 (payout-builder.ts:83-85) so cross-row collision is negligible — hence P2 not P0 — but the asymmetry is exactly the class the audit says to "codify, not patch one-off," and a future non-random memo or a manual ops re-queue with a reused memo would silently confirm the wrong amount.
- **fix:** Mirror pay-ctx: assert `prior.amount` (parsed) equals `row.amountStroops` and asset matches before treating as landed; fail-closed (`retriedLater` + ops note) on mismatch.
- **ref:** ADR 016; checklist §18 "memo + amount + asset post-hardening".

### [P2-2] Operator == deposit topology risk is documented but unmitigated in code (no boot-time assert / no separation)

- **severity:** P2 / Medium (latent; amplifies P0-1, P1-1, P1-2)
- **file:** `apps/backend/src/index.ts:74-114`, `env.ts:329-390`, ADR 010:149-172
- **impact:** Three findings above all worsen because the single account mixes custody and operations. Nothing in code asserts the intended topology (whether deposit _should_ equal operator), warns when they're equal, or prevents the redeemed-LOOP-is-respendable path. ADR 010 calls it "not a launch blocker," but it is the structural root of the burn/drift/idempotency gaps.
- **fix:** Emit a boot warning when `Keypair.fromSecret(OPERATOR_SECRET).publicKey() === DEPOSIT_ADDRESS`; track the Phase-2 split as a launch-readiness item given it gates correct burn accounting.
- **ref:** ADR 010 topology limitation; checklist §18 operator-vs-deposit.

### [P3-1] Payment accepted when Horizon omits `transaction_successful` (only `=== false` rejected)

- **severity:** P3 / Low (Horizon defaults make exploitation unlikely)
- **file:** `apps/backend/src/payments/horizon.ts:194-199`
- **impact:** `isMatchingIncomingPayment` rejects only when the flag is explicitly `false`; an undefined flag passes. Horizon's `/payments` returns successful ops by default and `join=transactions` populates `successful`, so this is defensive-only, but a schema/endpoint change could let a failed op through to `markOrderPaid`. Fail-open on a money gate should be fail-closed.
- **fix:** Require `transaction_successful === true || transaction?.successful === true` (positive assertion) rather than `!== false`.
- **ref:** checklist §4 fail-closed, §18 Horizon resilience.

### [P3-2] `parseStroops` duplicated in 3 Horizon readers despite a shared `stroops.ts`

- **severity:** P3 / Low (DRY / drift risk on money math)
- **file:** `horizon-trustlines.ts:79-90`, `horizon-asset-balance.ts:65-74` (private copies); canonical `stroops.ts:27-38`
- **impact:** The audit's own `stroops.ts` doc-comment says it exists to stop exactly this drift (it consolidated watcher + horizon-balances), yet two more readers still carry byte-copies. A future precision tweak in one place silently diverges the balance/trustline math from the deposit/circulation math.
- **fix:** Import `parseStroops` from `./stroops.js` in both readers; delete the local copies. `horizon-circulation.ts` uses its own regex-validating `amountToStroops` (stricter) — keep that one but document why it differs.
- **ref:** ADR 019 shared-code; checklist §14 DRY, §5 money-as-float adjacent.

### [P3-3] Drift / pool / cursor watchdog in-memory state lost on restart can mask an ongoing incident's transition

- **severity:** P3 / Low (acknowledged design tradeoff; noted for completeness)
- **file:** `asset-drift-watcher.ts:71-72,226-242`, `cursor-watchdog.ts:68-90`, `stuck-payout-watchdog.ts:4-19`, `interest-pool-watcher.ts` dedup
- **impact:** All transition dedup is process-memory. The drift watcher comment (22-27) accepts this (first tick after boot re-pages if still over). Correct for over→ok→over, but a crash-loop right at a transition could drop the paired open/close event, and the one-shot gates reset per process, so a flapping pod could either spam or silently swallow. Low because the staleness/re-page logic backstops it.
- **fix:** None required for Phase 1; if alert fidelity matters, persist last-notified state alongside the cursor row.
- **ref:** checklist §6 dedup/cooldown.

### [P3-4] `interest-pool-watcher` daysOfCover uses float `Number()` on bigint stroops

- **severity:** P3 / Low (display/threshold only, not ledger)
- **file:** `apps/backend/src/payments/interest-pool-watcher.ts:102-105`
- **impact:** `Number(poolStroops) / Number(dailyInterestStroops)` loses precision past 2^53 stroops (≈ 9e9 LOOP) — far above plausible pool sizes, and the value only feeds a coverage-days threshold/alert, never a ledger write. Flagged for the money-as-float sweep completeness; acceptable as-is.
- **fix:** Optional — compare in bigint (`poolStroops >= dailyInterestStroops * minDays`) to avoid float entirely.
- **ref:** checklist §25 minor-unit/bigint, §1 numeric correctness.

---

## Coverage

Files read in full (23 payments modules + 3 shared + 6 adjacent seams = 32):

**payments/**: watcher.ts, watcher-bootstrap.ts, payout-submit.ts, payout-worker.ts,
payout-worker-pay-one.ts, horizon.ts, horizon-find-outbound.ts, horizon-balances.ts,
horizon-trustlines.ts, horizon-circulation.ts, horizon-asset-balance.ts,
skipped-payments.ts, asset-drift-watcher.ts, interest-pool-watcher.ts,
cursor-watchdog.ts, stuck-payout-watchdog.ts, fee-strategy.ts, stroops.ts,
amount-sufficient.ts, price-feed.ts, price-feed-fx.ts, sep7.ts. (No `issuer-signers.ts`
present — checklist's "if present" — confirmed absent.)

**shared/**: stellar.ts, loop-asset.ts, payout-state.ts.

**adjacent seams (read for invariants):** orders/transitions.ts (markOrderPaid burn leg),
credits/pending-payouts.ts, credits/pending-payouts-transitions.ts, credits/payout-asset.ts,
credits/payout-compensation.ts, orders/pay-ctx.ts (idempotency comparison baseline),
index.ts worker wiring, env.ts Stellar block, ADR 010 §topology.

**Tests reviewed:** payments/**tests**/{watcher, payout-worker, payout-submit,
skipped-payments, asset-drift-watcher, fee-strategy, horizon\*, price-feed,
cursor-watchdog, stuck-payout-watchdog, watcher-scheduling, interest-pool-watcher}.test.ts.
Test quality is high and non-vacuous: poison-pill isolation, skip-before-cursor-advance,
A4-104 operator-account pre-check, A4-107 asset-mismatch, cross-currency size checks,
A2-602 watchdog reclaim are all covered. **Coverage gaps:** no test for find-outbound
page-cap exhaustion (P1-2), no test asserting on-chain burn on loop_asset redemption
(P0-1, because the behavior is absent), no test for drift accumulation across redemption
(P1-2/P1-1).

### Verified-correct (no finding)

- Stroops/decimal: `parseStroops`, `amountToStroops`, `stroopsToAmount`, `requiredStroopsForCharge`
  all bigint, ceiling-correct (A4-106 boundary fix verified at price-feed.ts:270-280).
- Key custody: operator secret never logged (pino redaction + no log of `secret`/`args.secret`);
  signing is `@stellar/stellar-sdk` only; `Keypair.fromSecret` failure → `terminal_bad_auth`.
- Network passphrase plumbed from env, no hardcoded PUBLIC/TEST.
- Sequence numbers: fresh `loadAccount` per submit; worker serialises rows (no parallelism)
  — comment + test "processes rows in order" confirm.
- Retry classification (payout-submit.ts:287-331) maps tx/op codes to transient/terminal correctly;
  fee-bump exponential-with-cap correct.
- Watcher cursor safety: skip recorded BEFORE cursor advance; poison-pill caught per-payment;
  empty-page heartbeat (A4-105) prevents false cursor-stale pages. Sound.
- Issuer pinning: `configuredLoopPayableAssets` requires issuer or drops the asset (prevents
  fake-USDLOOP spoof). Trustline pre-check fail-closed.
- Compensation writer (payout-compensation.ts) re-checks under FOR UPDATE, amount==outstanding,
  userId match, fleet daily cap with advisory lock, compensatedAt guard. Strong.
- Horizon resilience: 10s AbortSignal timeout on every fetch; Zod on every response; non-2xx throws;
  pagination cursor extraction robust to missing `_links.next`.

## Summary

| Severity  | Count |
| --------- | ----- |
| P0        | 1     |
| P1        | 2     |
| P2        | 2     |
| P3        | 4     |
| **Total** | **9** |

**Launch-readiness verdict (payments vertical):** NOT ready for real LOOP-asset
redemption/withdrawal volume. The on-chain burn leg (P0-1) is documented as built but
is absent, which (a) lets redeemed LOOP re-fund payouts on the shared deposit/operator
account and (b) drives the drift reconciliation alert permanently positive (P1-1),
masking genuine over-mint incidents. Discount-purchase (XLM/USDC inbound → CTX) and
cashback-emission paths are sound. P0-1 + P1-1 + P1-2 are one structural root: the
missing burn + the operator==deposit topology. Author ADR 036 and ship the burn before
enabling LOOP-funded redemption.
