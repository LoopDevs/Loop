# Money Invariants — Loop

> The properties that must **always** be true about value in this system,
> and — for each — exactly **what enforces it**. This is the anchor
> document for reviewing any change that touches `credits/`, `payments/`,
> `orders/`, `wallet/`, or `db/schema.ts`. If a change could make one of
> these false, it is a money bug regardless of whether tests pass.
>
> Written 2026-07 during the hardening pass. Each invariant lists its
> enforcement tier: **DB** (constraint/trigger — cannot be bypassed by any
> writer), **runtime** (app-layer check — bypassable by a new code path),
> **test** (CI gate — catches regressions pre-merge), **watcher**
> (scheduled detector — catches drift post-hoc), or **convention** (only a
> code comment / reviewer holds it — the weakest, treat with suspicion).
>
> A reviewer's job on a money diff: for each invariant the diff could
> touch, confirm the enforcement still holds and the diff doesn't quietly
> demote a DB/test tier down to convention. The `/review-money-diff` skill
> automates walking this list.

---

## Core ledger

### INV-1 — Mirror equals the transaction sum

`user_credits.balance_minor == SUM(credit_transactions.amount_minor)` for
every `(user_id, currency)`.

- **DB**: CHECK `user_credits_non_negative` (balance ≥ 0);
  `credit_transactions_amount_sign` pins per-type signs.
- **test**: `bigint-money-property.test.ts` (pure math); the integration
  `afterEach` in `flywheel.test.ts` + `admin-writes.test.ts` asserts
  `computeLedgerDriftSql() === []` after every flow (hardening C7) — any
  new writer that desyncs the mirror fails CI.
- **watcher**: `ledger-invariant-watcher.ts` runs `computeLedgerDriftSql`
  daily against prod and pages Discord while any drift persists
  (hardening C1). Single-flighted across machines via an advisory lock.
- **How a writer keeps it**: every mirror mutation writes a
  `credit_transactions` row and updates `user_credits` in the **same
  transaction**, under `SELECT … FOR UPDATE` on the balance row.

### INV-2 — Every balance mutation is atomic and serialized

No writer reads-then-writes the balance without holding the row lock.

- **runtime**: every primitive in `credits/` (`adjustments`, `refunds`,
  `emissions`, `payout-compensation`, `interest-mint`) opens a Drizzle
  transaction and takes `.for('update')` on the `user_credits` row before
  computing the new balance.
- **convention** (watch here): a NEW `credits/` writer must follow the
  same pattern. There is no DB fence forcing the lock — a writer that
  computes a balance from an unlocked read is a lost-update bug that only
  the integration suite's concurrency tests might catch.

---

## On-chain ↔ off-chain (ADR 036: chain is authoritative)

### INV-3 — No unbacked LOOP: on-chain emitted ≤ mirror liability

The net LOOP materialized on-chain for a `(user, asset)` never exceeds the
user's mirror balance. `mintedNet = Σ(order_cashback + emission +
interest_mint payouts, non-failed, non-compensated, excluding legacy
at-send-debited emissions) − Σ(burns) ≤ balance_minor`.

- **DB**: trigger `assert_emission_conservation()` on `pending_payouts`
  (migration 0044) — BEFORE INSERT of an emission row AND BEFORE UPDATE of
  any mint-kind row leaving `failed` (the retry re-entry path). Rejects
  any writer, app or raw SQL, that would breach the bound (hardening
  A1/C10).
- **runtime**: `emittedNetMinorFor` in `credits/emissions.ts` computes the
  same check under the row lock, returning a clean 409
  `EMISSION_EXCEEDS_UNEMITTED_BALANCE` before the DB trigger fires.
- **Why both**: the GBPLOOP unbacked-mint finding (two cold audits) is the
  proof that an app-layer allowlist gets bypassed by a future writer. The
  trigger is the backstop.

### INV-4 — Drift equation balances

`onChain − pool − unconfirmedBurns + unconfirmedInterestMints −
ledgerLiability×1e5 ≈ 0` per asset, within the operator threshold.

- **watcher**: `asset-drift-watcher.ts` computes this every ~300s against
  Horizon + the ledger and pages on the `ok→over` transition. State is
  persisted in `asset_drift_state` (fleet-consistent, restart-durable —
  hardening A3), page delivery is at-least-once (hardening A2). The
  read pass itself is fleet-wide single-flighted via a Postgres
  advisory lock (S4-8) — with N Fly machines only one runs the
  Horizon/ledger reads per tick; this is a pure read-efficiency layer
  on top of the A3 paging dedup, not a change to the paging contract.
  Like the payout worker's INV-9 lease, the S4-8 single-flighted ticks
  (payment-watcher, asset-drift, redemption-backfill, order-expiry
  sweep) each race a hard lease deadline: a hung-but-alive lock holder
  releases the lock at the deadline and the orphaned tick body
  degrades to the pre-S4-8 per-machine concurrency (which every tick
  body already tolerates — CAS-guarded transitions, the A3 row-locked
  state repo, guarded UPDATEs) rather than stalling the whole fleet.
- **watcher (paging dedup for the fire-once watchdogs)**: the
  cursor-age and stuck-payout watchdogs persist their fired/re-arm
  state in `watchdog_alert_state` (S4-8 follow-up; the ADR-038 D2
  at-least-once shape) — `alert_active` flips `true` only after the
  Discord send confirms delivery, a failed send is retried on the next
  tick (any machine), and a healthy tick re-arms. Contract:
  at-least-once per incident, fleet-wide, confirmed-delivery.
- **watcher (second dimension)**: terminally-`failed` burn / interest-mint
  rows are counted INTO the equation (the tokens/credits genuinely exist),
  which makes the equation itself blind to them — so a separate
  `failedRowsState` dimension pages until an operator retries them
  (hardening A2). Without it a failed nightly mint leaves the mirror
  silently ahead of chain forever.
- **convention**: the equation's correctness lives in one head — any
  change to what counts as circulating (a new payout kind, a burn state
  change) must be re-derived against this identity, not patched locally.

### INV-5 — Emission has a daily value ceiling

Per-currency, per-UTC-day emission total ≤ `ADMIN_DAILY_WITHDRAWAL_CAP_MINOR`.

- **runtime**: advisory-lock-serialized cap in `credits/emissions.ts`
  (hardening A1) — parity with the adjustment/refund/compensation caps.
  Bounds treasury drain through a compromised admin session within a day.

---

## Orders & settlement (ADR 010 principal switch)

### INV-6 — Every paid order reaches a user-whole terminal state

A `paid` order eventually becomes `fulfilled` (user has a card) OR the user
is refunded. It never sits stranded.

- **runtime**: `procureOne`'s own failure paths all `autoRefundFailedOrder`.
- **runtime**: the crash-recovery `sweepStuckProcurement` (hardening A5)
  disambiguates via the durable CTX-settlement record + authoritative
  Horizon hash lookup: Loop-didn't-pay → auto-refund; Loop-paid → hold +
  page (a usable card may exist); uncertainty → fail closed to hold.
- **DB**: order state machine CHECK `orders_state_known`.

### INV-7 — CTX is paid at most once per order

The operator→CTX settlement payment is idempotent across worker re-runs.

- **DB**: `ctx_settlements` table, one row per order (unique index),
  tx hash persisted BEFORE the network submit (hardening A4).
- **runtime**: `payCtxOrder` converges via the authoritative
  `getOutboundPaymentByTxHash` point lookup (window-immune), memo scan as a
  backfilling fallback, intent pinned against URI rotation.

### INV-8 — Refunds and cashback are single-issue per order

No order is refunded twice; no order's cashback is credited twice.

- **DB**: partial unique index on `(type, reference_type, reference_id)`
  for `type IN ('refund','cashback','spend','withdrawal')` (migration
  0013). A duplicate insert gets `23505` → typed `…AlreadyIssuedError`.
- **runtime (R3-2 cross-check, 2026-07-08)**: an XLM/USDC failed-order
  refund goes ON-CHAIN via `refundDeposit()` and writes no
  `credit_transactions` row, so the index alone cannot exclude a
  credit-refund/on-chain-refund pair. The two exits serialise on the
  order row lock: `applyOnChainOrderAutoRefund` and `refundDeposit`'s
  claim both refuse when a credit refund row exists for the order, and
  `applyAdminRefund` refuses when the order's own paying deposit has a
  skip row in `refunding`/`refunded`. Duplicate-deposit skip rows
  (T0-1b, paymentId ≠ the persisted paying id) stay independently
  refundable — returning an extraneous deposit is not an order refund.
  Skip rows recorded with `orderId=null` (processing_error class) are
  matched by the paying-payment id instead (both directions). Two
  fail-closed residuals, both deliberate: a skip row stuck fresh
  `refunding` (crashed claim) blocks the credit refund until the A6
  re-POST converges it past `REFUND_RECLAIM_STALE_MS`; and an expired
  never-paid order whose unlinked deposit was A6-refunded relies on the
  admin not also crediting an order that never debited anything (both
  actions are step-up-gated and audited).

---

## Payouts (ADR 015/016)

### INV-9 — One outbound payment per payout intent

A `pending_payouts` row is submitted to Stellar at most once.

- **runtime**: state-CAS claim (`markPayoutSubmitted` guarded on
  `pending`), tx hash persisted before submit (CF-18), authoritative
  hash re-check on re-pick.
- **DB**: partial unique idempotency indexes per kind
  (`pending_payouts_active_emission_unique`, order-cashback unique, …).
- **runtime (A8)**: the payout tick is single-flighted fleet-wide via a
  reserved-connection advisory lock (`withAdvisoryLock` +
  `payoutLeaderLockKey`) — one machine drains at a time, closing the
  normal-case operator-sequence race. A 90s lease deadline releases the
  lock if the leader hangs on Stellar I/O, degrading to the pre-A8
  per-machine race (accepted) rather than stalling the fleet. Not a full
  heartbeat leader-election; the residual is a >90s hung tick.

### INV-10 — Interest mints only for backed assets

Only GBPLOOP is minted on-chain nightly; USDLOOP/EURLOOP are vault shares
(ADR 031 v7) and must never be issuer-minted.

- **DB**: CHECK pinning `kind='interest_mint' → asset_code='GBPLOOP'` on
  `pending_payouts`; the interest-mint worker's `ONCHAIN_MINT_ELIGIBLE_ASSETS`
  allowlist is the app-layer twin.
- **DB**: `parseEnv` boot-fails if an issuer secret mismatches its
  configured issuer address.

---

## Auth & access (the money-adjacent invariants)

### INV-11 — Every destructive admin write requires fresh step-up

- **test**: `staff-route-gating.test.ts` — named-middleware route
  inventory pins every destructive route to its scoped `requireAdminStepUp`
  gate AND a default-deny rule (any new admin-tier non-GET mount must
  declare step-up or join a reasoned exempt list — hardening B1).
- **runtime**: `requireAdminStepUp` fails closed with no auth context
  (hardening B2); subject-pinning is unconditional.

### INV-12 — Config that looks wired is actually wired

- **test**: `check-dead-flags.mjs` — every env var in `env.ts` is read
  somewhere in backend source (hardening C5). Caught ADM-01's orphaned
  emission cap.
- **DB/boot**: `env.ts` cross-field guards fail boot on native-auth-without-key
  and production-without-step-up-key (hardening B3).

---

## Deposit matching (the identity-adjacent invariant)

### INV-13 — A deposit's asset identity is issuer-pinned before it can pay an order

`markOrderPaid` only fires for a credit-asset (USDC / LOOP-asset) deposit
whose Stellar issuer is explicitly configured and matches. Stellar asset
codes are not unique — anyone can self-issue an asset called "USDC" (or
any LOOP-asset code) from their own account, so a match on code alone
would let an attacker's worthless self-issued asset pay a real order,
triggering real CTX procurement against real operator funds (upstream of
INV-7's "CTX paid at most once" — this invariant is what makes that
payment legitimate in the first place).

- **runtime**: `isMatchingIncomingPayment` (`payments/horizon.ts`) requires
  a pinned `assetIssuer` for any non-native asset match — an omitted
  issuer means NO match, never "any issuer" (AUDIT-2 finding A, fixed
  2026-07). The LOOP-asset allowlist (`credits/payout-asset.ts`:
  `configuredLoopPayableAssets`) has held this shape since ADR 015; the
  USDC rail (`payments/watcher.ts`'s `matchesUsdc`) now mirrors it.
- **DB/boot**: `env.ts` boot-fails in production when
  `LOOP_STELLAR_USDC_ISSUER` is unset (mirrors the admin step-up guard,
  hardening B3 precedent), unless `DISABLE_USDC_ISSUER_ENFORCEMENT=1`
  deliberately ships the USDC rail disabled — this is INV-12's "config
  that looks wired is actually wired" applied to the deposit identity
  gate, not a substitute for the runtime check above.
- **test**: `horizon.test.ts` (`isMatchingIncomingPayment` unit cases) +
  `watcher.test.ts` (tick-level: fake USDC from an unconfigured issuer,
  and from an attacker issuer when the real one IS configured, both
  reject) + `env.test.ts` (production USDC-issuer boot guard).

---

## How to use this doc

**Reviewing a money diff**: run `/review-money-diff` (or manually) — for
each invariant the diff's files touch, confirm the listed enforcement
still holds. The failure mode to hunt: a diff that silently demotes a tier
(a DB CHECK deleted, a test's assertion weakened, a lock dropped) so the
invariant survives on convention alone.

**Adding a new money flow**: state which invariants it must preserve and
how, in the PR description. If it introduces a new invariant, add it here
with its enforcement tier in the same PR.

**Weakest links** (as of 2026-07, ranked): INV-2 (lock is convention for
new writers), INV-4's equation correctness (one-head knowledge). These are
where a mid-tier contributor is most likely to introduce a silent
regression.
