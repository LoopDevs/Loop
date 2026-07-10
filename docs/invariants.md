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
>
> **T0-3 (2026-07-10):** every row below tagged **DB** whose object is a
> named trigger/function, unique index, or CHECK constraint is now also
> mechanically presence- and shape-asserted by
> `scripts/check-money-invariants.mjs` (`npm run check:money-invariants`),
> which runs in the CI Quality job — a **required** merge check — and in
> `npm run verify`. It statically replays the migration chain's
> CREATE/DROP events (no live DB needed) so a diff that drops or narrows
> one of these objects fails CI even if it updates `schema.ts` to match
> (the one case `check-migration-parity` alone would let through, since
> that check only proves the migration chain and `schema.ts` agree with
> each other, not that either still contains the object). Adding a new
> DB-tier invariant here should come with a matching entry in that
> script's tracked-object list in the same PR.

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
- **runtime (A5-4 order-bound refund, 2026-07-10)**: the admin refund
  endpoint (`POST /api/admin/orders/:orderId/refund`,
  `admin/order-refund.ts`) adds NO new uniqueness logic — it dispatches
  to the SAME primitives (`applyOrderAutoRefund` for xlm/usdc → on-chain,
  `applyAdminRefund` for credit) and therefore rides the exact guards
  above. A second refund attempt for an already-refunded order surfaces
  `RefundAlreadyIssuedError` → 409 `ORDER_ALREADY_REFUNDED`. Fulfilled-
  order refunds (behind the code-unused attestation, see
  `docs/threat-model.md`) are still just an order refund on this axis —
  single-issue holds; the accepted risk is the external code's
  usability, not a ledger double-issue. `loop_asset` refunds fail closed
  (matching the R3-2 posture) rather than open a mirror-only path.

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
- **runtime (ADR 044 / S4-1 — payout channel accounts)**: within one
  leader's tick, a claimed batch may be sharded across N configured
  channel accounts and the shards submitted concurrently for
  throughput. This does NOT weaken the invariant: shards are a pure
  in-memory partition of rows this process already claimed (no second
  DB claim, so no row can land in two shards), each shard is still a
  strictly serial queue against its OWN channel's sequence number (so
  "no two in-flight submits share a sequence number" holds per-shard
  exactly as it held fleet-wide before), and the CAS claim + CF-18
  hash-before-submit + authoritative re-check are per-row and
  channel-agnostic — unaffected by which account paid the fee. The A8
  fleet-wide leader lock is unchanged, so cross-machine safety still
  reduces to the single-process argument above. Zero channels
  configured (the default) is the exact pre-ADR-044 code path. Full
  argument: `docs/adr/044-payout-throughput.md`.

### INV-10 — Interest mints only for backed assets

Only GBPLOOP is minted on-chain nightly; USDLOOP/EURLOOP are vault shares
(ADR 031 v7) and must never be issuer-minted.

- **DB**: CHECK pinning `kind='interest_mint' → asset_code='GBPLOOP'` on
  `pending_payouts`; the interest-mint worker's `ONCHAIN_MINT_ELIGIBLE_ASSETS`
  allowlist is the app-layer twin.
- **DB**: `parseEnv` boot-fails if an issuer secret mismatches its
  configured issuer address.

---

## Vault emissions (ADR 031 §D4/D5, V3)

LOOPUSD/LOOPEUR cashback emitted via the vault path
(`credits/vaults/vault-emissions.ts`, gated on `LOOP_VAULTS_ENABLED` —
default off, byte-identical to the classic path when unset). Only
reachable through `orders/fulfillment.ts`'s gated fork; the classic
USDLOOP/GBPLOOP/EURLOOP path is untouched by everything below.

### INV-V1 — No unbacked shares: shares transferred == shares minted from the same deposit

The operator never transfers more vault shares to a user than that
SAME emission's own `vault.deposit` call actually minted.

- **runtime**: `transferStep` (`vault-emissions.ts`) always passes
  `amount: row.sharesMinted` — the exact value `depositStep` persisted
  from THIS row's own deposit result — never a caller-supplied or
  cross-row value. Holds by construction, not by a runtime check.
- **DB (conservation, dollar-value dimension)**: the mirror step
  writes a `pending_payouts kind='emission'` AUDIT row (already
  `state='confirmed'`, real transfer `txHash` — never picked up by
  the classic submit worker) through the SAME
  `assert_emission_conservation` trigger (migration 0044) that guards
  admin emissions — migration 0061 widens `pending_payouts
.asset_code`/`.asset_issuer` CHECKs to admit LOOPUSD/LOOPEUR and
  the trigger's `mirror_currency` mapping to know both codes.
  **Load-bearing fix in the same migration**: the minted/burned
  aggregation used to scope `WHERE asset_code = NEW.asset_code`,
  correct only while exactly one asset code mapped to each mirror
  currency. Now that USDLOOP _and_ LOOPUSD both mirror into USD
  (EURLOOP/LOOPEUR into EUR), the aggregation sums over every asset
  code sharing NEW's mirror currency — otherwise a user could
  accumulate a classic USDLOOP emission AND a LOOPUSD emission that
  EACH individually pass the check against the SAME shared USD
  balance, jointly minting up to 2x the mirror liability. Regression-
  tested in `__tests__/integration/vault-emissions.test.ts` (real
  postgres).
- **test**: `credits/vaults/__tests__/vault-emissions.test.ts` (mocked
  — the transfer-amount-equals-sharesMinted assertion) +
  `__tests__/integration/vault-emissions.test.ts` (real postgres — the
  trigger genuinely rejects an over-limit insert, and the cross-asset
  regression above).

### INV-V2 — Idempotency claim + per-row deposit claim precede any on-chain action

A `vault_emissions` row is (a) claimed at fulfillment (durable, local,
no network I/O) keyed on the SAME `order_id` the classic path's own
`pending_payouts_order_unique` uses, and (b) claimed AGAIN by the
sweep — `pending → depositing` — before any deposit, so at most one
machine ever deposits.

- **DB**: `vault_emissions_order_unique` — one emission row per order,
  ever.
- **runtime (fulfillment claim)**: `orders/fulfillment.ts` calls
  `claimVaultEmission` inside the SAME transaction as the order's
  `fulfilled` transition — a crash after that commit always has a
  resumable claim row.
- **runtime (cross-machine deposit claim, money-review #1647 P1)**:
  the sweep selects candidate rows `FOR UPDATE SKIP LOCKED` and
  `driveOneVaultEmission` CASes `pending → depositing`
  (`claimEmissionForDeposit`) — an atomic guarded UPDATE committed
  BEFORE `depositToVault`'s network call — so only ONE machine
  deposits even when the fleet-wide sweep advisory lock has degraded
  on a transaction-pooler `DATABASE_URL`. Exactly the classic payout
  worker's `SELECT … FOR UPDATE SKIP LOCKED` + `pending → submitted`
  CAS shape (INV-9). Each on-chain step persists its tx hash via
  CF-18 `onSigned` BEFORE submit, so a resumed `depositing`/`deposited`/
  `transferred` row passes `priorTxHash` rather than re-submitting.
- **test**: the mocked suite covers claim-replay, the CAS claim-loss
  path, and resume-from-`depositing`/`deposited`/`transferred`; the
  real-postgres suite races two concurrent drives over one `pending`
  row and asserts exactly one deposits (the real CAS).

### Vault-emission observability (money-review #1647 P1-2)

A stranded vault emission must never be silent:

- **watcher (terminal)**: `recordStepFailure` pages Discord
  (`notifyVaultEmissionFailed`, monitoring) the moment a row reaches
  terminal `failed`, and the sweep tick marks
  `markWorkerTickFailure('vault_emission_sweep')` on any tick that
  produced a terminal failure or unexpected drive error (so /health
  reflects it, not a silent success).
- **watcher (stuck-but-not-terminal)**: `runVaultEmissionStuckWatchdog`
  pages once per incident (`notifyVaultEmissionsStuck`) when a row
  sits in `depositing`/`deposited`/`transferred` past the threshold —
  single-flighted fleet-wide (`pg_try_advisory_xact_lock`), fire-once/
  re-arm state in `watchdog_alert_state`, confirmed-delivery
  (at-least-once), mirroring `stuck-payout-watchdog.ts`.
- The admin re-drive ENDPOINT for a `failed` row is deferred (V5).

### Known residual (accepted, V3)

`depositToVault`/`transferShares` sign with the same
`LOOP_STELLAR_OPERATOR_SECRET` the classic payout-submit worker uses.
The vault sweep and the classic payout worker are NOT coordinated
against each other's operator-account sequence number (only the vault
sweep's OWN rows are serialised, via its own fleet-wide advisory lock

- the `pending → depositing` CAS above). A concurrent-tick sequence
  collision _across the two worker types_ surfaces as a retryable
  Soroban/Horizon submit error on one side, not a fund-loss event — but
  this is a real gap, not yet closed (a shared sequence lock or ADR-044
  channel accounts). See `credits/vaults/vault-emissions.ts`'s module
  header.

---

## Vault redemptions (ADR 031 §D6, V4)

LOOPUSD/LOOPEUR spend/withdraw via the vault path
(`credits/vaults/vault-redemptions.ts` + `treasury/hot-float.ts`, gated
on `LOOP_VAULTS_ENABLED` — dark by default). One `vault_redemptions`
row per spend event: `pending → collecting → redeemed → settled`
(+`failed`). The gift-card spend fork lives in `orders/redeem.ts`
(→`orders/redeem-vault.ts`) for a vault-eligible (USD/EUR) `loop_asset`
order; with the flag off, the classic on-chain redemption is
byte-identical.

### INV-V2 (redemption) — Never pay out more value than the collected shares are worth

The value paid for a redemption (`value_minor`) is bounded below by
what the collected shares actually redeem to.

- **runtime**: the SLOW path's `withdrawFromVault({ minAmountsOut =
value_minor × stroops })` throws `VaultPostSubmitSlippageError` rather
  than let a row reach `redeemed` for less than `value_minor` is worth;
  `shares_to_redeem` is computed from a FRESH `readVaultState` price
  (plus a bounded buffer, `REDEMPTION_SHARE_BUFFER_BPS`), pinned once,
  never recomputed across retries.
- **test**: `credits/vaults/__tests__/vault-redemptions.test.ts`
  (below-floor withdraw → `recordStepFailure`, row never `redeemed`).

### INV-V1 (redemption) — Mirror debit == burn == value_minor; both halves extinguished exactly once

Redemption debits the off-chain `user_credits` mirror by `value_minor`
AND writes a conserved `pending_payouts kind='burn'` audit row for the
SAME `value_minor` — through the EXISTING primitives, so the
`assert_emission_conservation` trigger (migration 0044, currency-scoped
by 0061) still balances. No new payout kind, no trigger change.

- **DB (idempotency + conservation)**:
  - `vault_redemptions_source_unique` (migration 0062) — one redemption
    row per `(source_type, source_id)`, ever (the durable claim fence).
  - `credit_transactions_reference_unique` — one `type='spend'` ledger
    row per `(order, source_id)`; a re-driven mirror step hits this
    (caught → treated as already-mirrored, advance to `settled`).
  - `pending_payouts_burn_order_unique` — one burn per order (the mirror
    step's burn insert `ON CONFLICT DO NOTHING`s on it).
  - `assert_emission_conservation` — counts the burn in `burned_stroops`
    for the mirror currency (`loop_asset_mirror_currency`).
- **runtime (strict order-payability coupling, money-review P2-3)**: the
  mirror step re-reads the source order `FOR UPDATE` and requires
  `pending_payment` BEFORE any debit (like classic `markOrderPaid`'s
  `if (paid === undefined) return null`). An order that became
  non-payable (expired) before the debit routes to a terminal
  refund-needed `failed` state (`markRedemptionNeedsRefund`, pages ops)
  WITHOUT debiting — never debits the user for an order that delivers no
  card. A missing `user_credits` mirror row throws + rolls back
  (money-review P2-4) rather than inserting an unbalanced debit.
- **test**: `credits/vaults/__tests__/vault-redemptions.test.ts` (mocked
  — happy-path conserves, expired-order refund path, missing-row fail-
  closed, replay = no second debit) + `__tests__/integration/vault-
redemptions.test.ts` (real postgres — the real conservation trigger
  accepts the burn, `source_unique` fires as a real 23505).

### INV-V3 (redemption) — Collect is at-most-once; a persisted collect_tx_hash is NOT proof of landing

The user-signed `transfer(user → operator)` — the ONLY user-wallet
signature (ADR 031 §D1) — is submitted at most once per redemption, and
`collected_at` is set ONLY after the transfer CONFIRMS landed.

- **DB (per-step claim, money-review P1-B)**: `collect_claimed_at`
  (migration 0062) — an atomic CAS-claim committed BEFORE the transfer's
  network call, so exactly one driver submits even though the HTTP
  inline drive and the sweep can both reach a `collecting` row (the
  `pending → collecting` transition-CAS alone does not serialize
  processing). Re-acquirable once past `COLLECT_CLAIM_LEASE_MS` (a
  crashed collector). Mirrors V3's `pending → depositing` CAS, adapted
  to V4's extra driver.
- **runtime (verify-on-resume, money-review P1-A)**: the transfer is
  (re-)invoked with `priorTxHash: collect_tx_hash`, whose CF-18
  `checkPriorSorobanTx` VERIFIES the prior tx landed (dedupes) or
  re-submits — because `onSigned` persists `collect_tx_hash` BEFORE the
  sign+submit round trip, a persisted hash is NOT proof of landing. The
  same discipline V3's `transferStep` uses.
- **request-level fence**: `orders/redeem-vault.ts` also wraps
  claim+drive in the classic two-belt fence (in-process Set + fleet-wide
  advisory lock keyed on order id) — defence-in-depth over the per-step
  CAS.
- **test**: `credits/vaults/__tests__/vault-redemptions.test.ts` (resume
  with `collect_tx_hash` set / `collected_at` null re-invokes the
  transfer with `priorTxHash`; two concurrent drivers → exactly one
  transfer submitted).

### Vault-redemption observability

Same shape as the emission side: `recordStepFailure` /
`markRedemptionNeedsRefund` page `notifyVaultRedemptionFailed` on a
terminal row; `runVaultRedemptionStuckWatchdog` pages
`notifyVaultRedemptionsStuck` (fire-once/re-arm, at-least-once) when a
row sits in `collecting`/`redeemed` past the threshold; the sweep tick
marks `markWorkerTickFailure('vault_redemption_sweep')` on any terminal
failure. The admin re-drive endpoint for a `failed` row is deferred
(V5).

### Known residual (NOT self-correcting — needs drift reconcile, V5)

The SLOW-path payout and the hot-float replenish (`treasury/hot-float.ts`)
each have a documented residual: two drivers that both fail the
fast-path draw (redemption) or two replenish ticks (float) can each
build a REAL on-chain `withdrawFromVault` for the same shares before
either commits. The loser's on-chain call typically fails (the vault
can't burn shares the operator doesn't hold), but a rare interleaving
where BOTH land is an OVER-withdraw that leaves UNTRACKED float/pool
drift (it fails CLOSED to drift, never a double-credit of the float).
This is NOT self-correcting: the **vault-aware R3-1 operator-float
reconciliation must catch and reconcile it, and being vault-aware is a
prerequisite before `LOOP_VAULTS_ENABLED` is flipped on** (a V5 item,
alongside a per-row payout advisory lock and a durable
`hot_float_replenish_attempts` CF-18 row). See the module headers.

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
