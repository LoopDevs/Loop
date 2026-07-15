# NS-08 — Per-account freeze / AML-hold (design)

Status: DESIGN + SCAFFOLD. No migration in this change. Migration 0071+
(applied later, serialized). Scaffold:
`apps/backend/src/fraud/account-freeze.ts` (types + service interface +
fail-closed enforcement stubs; NOT wired into any live debit path).

## 1. Problem

There is no way to freeze a single Loop account. A compromised,
fraudulent, or AML-flagged account keeps its full ability to move money
out — buy gift cards with its balance, redeem its on-chain LOOP, redeem
vault shares, and receive outbound Stellar payouts to its wallet. When
support/compliance identifies a bad account, the only levers today are:

- `POST /api/admin/users/:userId/revoke-sessions` (B4) — kills live
  refresh tokens, but the user can sign back in via OTP, and it does
  nothing about an attacker who already holds a 15-min access token or
  the user's own embedded-wallet key material.
- `users.is_admin` / staff role — irrelevant to a normal user.
- A credit-adjustment to zero the balance — destructive, reversible only
  by another adjustment, and does not stop on-chain LOOP the user holds
  in their embedded wallet.

None of these is a clean, reversible, audited "stop all money leaving
this account now" switch. NS-08 adds one.

## 2. Money-flow model (what a debit is here)

Every user-visible balance is dual-booked (ADR 036): an off-chain
`user_credits` liability mirror AND on-chain LOOP-asset in the user's
embedded wallet. A user removes value from their account by:

1. **Spending** the balance on a gift card — an off-chain `spend` debit
   (`credit_transactions.type='spend'`, negative) + `user_credits`
   decrement (credit-funded orders), OR by sending on-chain LOOP to the
   deposit address (loop_asset orders), which the watcher matches and
   then debits the mirror + burns the on-chain half.
2. **Redeeming** LOOP → gift card via the classic on-chain path or the
   Soroban vault-share path (USD/EUR when vaults are on). The vault path
   collects the user's shares to the operator and debits the mirror.
3. **Receiving outbound payouts** — cashback (`kind='order_cashback'`),
   admin emission (`kind='emission'`), nightly interest
   (`kind='interest_mint'`). These move operator funds TO the user's
   wallet. They are not debits of the user's balance, but for an AML
   freeze they are money moving to a possibly attacker-controlled wallet,
   so whether a hold pauses them is a policy question (§6).

There is **no peer-to-peer transfer** feature and no fiat-out withdrawal
rail today (`type='withdrawal'` is reserved/legacy — see
`db/schema/credits.ts`). "Transfers" in the NS-08 brief map to the vault
share transfer that is an internal step of redemption (§5).

## 3. Schema (PROPOSED — do NOT apply here; migration 0071+)

Design follows the codebase's existing dual-layer pattern (`staff_roles`

- `users.is_admin` shim; `credit_transactions` ledger + `user_credits`
  materialized mirror): an **append-only `account_holds` ledger** is the
  source of truth and audit trail, and a **denormalized `users.frozen_at`
  mirror column** serves the hot per-debit read (one column-scoped lookup,
  exactly like `users.token_version` / `getUserTokenVersion`). The mirror
  is kept in sync with the ledger inside the same transaction as every
  place/release write.

```sql
-- Migration 0071 — NS-08 per-account freeze / AML-hold.
-- (May be split 0071 table / 0072 mirror-column if the serialized
--  apply cadence prefers one object per migration.)

CREATE TABLE account_holds (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- What the hold blocks. 'full' refuses every debit/withdraw path and
  -- (per policy §6) may also hold outbound payouts; 'debits_only'
  -- refuses user-initiated spend/withdraw but lets the system keep
  -- paying already-earned cashback out. Dual-layer with the TS union.
  scope               text NOT NULL,
  reason_code         text NOT NULL,
  -- Operator rationale, ADR-017 contract (2..500), same as
  -- credit_transactions.reason.
  reason              text NOT NULL,
  placed_by_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  placed_at           timestamptz NOT NULL DEFAULT now(),
  -- NULL => hold is LIVE. Set on release.
  released_at         timestamptz,
  released_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  release_reason      text,

  CONSTRAINT account_holds_scope_known
    CHECK (scope IN ('full', 'debits_only')),
  CONSTRAINT account_holds_reason_code_known
    CHECK (reason_code IN (
      'aml_review', 'sanctions_screening', 'suspected_fraud',
      'account_compromise', 'law_enforcement_request',
      'chargeback_investigation', 'other')),
  CONSTRAINT account_holds_reason_length
    CHECK (length(reason) >= 2 AND length(reason) <= 500),
  -- Release fields land together or not at all.
  CONSTRAINT account_holds_release_shape
    CHECK ((released_at IS NULL) = (released_by_user_id IS NULL)),
  CONSTRAINT account_holds_release_reason_length
    CHECK (release_reason IS NULL
           OR (length(release_reason) >= 2 AND length(release_reason) <= 500))
);

-- Admin holds dashboard: live holds newest-first.
CREATE INDEX account_holds_live
  ON account_holds (placed_at DESC) WHERE released_at IS NULL;
-- Per-user history (admin user-detail) + the "does this user have a
-- live hold" existence check the mirror-recompute uses.
CREATE INDEX account_holds_user
  ON account_holds (user_id, placed_at DESC);
-- At most ONE live hold per (user, scope) — a second freeze attempt is a
-- no-op, not a duplicate row. Partial unique over live rows only.
CREATE UNIQUE INDEX account_holds_one_live_per_user_scope
  ON account_holds (user_id, scope) WHERE released_at IS NULL;

-- Denormalized hot-path mirror. NULL => not frozen. Set to the
-- earliest live hold's placed_at; recomputed to NULL when the last
-- live hold is released. Read once per gated debit (column-scoped).
ALTER TABLE users
  ADD COLUMN frozen_at timestamptz;
-- Optional: mirror the effective (most restrictive) scope too, so the
-- gate resolves intent without a join. 'full' > 'debits_only'.
ALTER TABLE users
  ADD COLUMN frozen_scope text
  CONSTRAINT users_frozen_scope_known
    CHECK (frozen_scope IS NULL OR frozen_scope IN ('full', 'debits_only'));
-- Invariant tripwire: the mirror is set iff a scope is set.
ALTER TABLE users
  ADD CONSTRAINT users_frozen_mirror_shape
    CHECK ((frozen_at IS NULL) = (frozen_scope IS NULL));
```

Notes:

- The ledger is the authority; the mirror is a cache. A reconciliation
  check (mirror `frozen_at` == `MIN(placed_at)` over live holds per user)
  belongs alongside the existing ledger-invariant watchers.
- No native pg enum — string + CHECK, matching every other enum in the
  schema, so widening the scope/reason set is a CHECK migration, not an
  `ALTER TYPE` dance.

## 4. Admin / AML control surface (PROPOSED)

New routes, mounted in `routes/admin-user-writes.ts` (same middleware
envelope as the other admin user-scoped money writes):

| Route                                   | Tier      | Step-up scope            | Notes                                            |
| --------------------------------------- | --------- | ------------------------ | ------------------------------------------------ |
| `POST /api/admin/users/:userId/holds`   | `admin`   | `account-freeze` (new)   | Place a hold. Idempotency-Key + reason required. |
| `POST /api/admin/holds/:holdId/release` | `admin`   | `account-unfreeze` (new) | Release a live hold. reason required.            |
| `GET  /api/admin/users/:userId/holds`   | `support` | —                        | Per-user hold history (read).                    |
| `GET  /api/admin/holds`                 | `support` | —                        | Live-holds dashboard (read).                     |

Authz + audit, reusing existing primitives verbatim:

- **AuthN/Z**: `requireAuth` → `requireStaff('admin')` for writes,
  `requireStaff('support')` for reads (`auth/require-staff.ts`).
- **Step-up**: `requireAdminStepUp('account-freeze' | 'account-unfreeze')`
  (`auth/admin-step-up-middleware.ts`). Add both to `STEP_UP_SCOPES` in
  `auth/admin-step-up.ts`. A captured bearer alone must not be able to
  freeze/unfreeze (unfreeze is the money-relevant direction — it re-opens
  the debit paths). The `staff-route-gating.test.ts` inventory walk will
  require the scope to be declared.
- **Actor from context**: `placed_by_user_id` / `released_by_user_id`
  from `c.get('user')`, never the body (ADR 017 #1).
- **Idempotency + reason + Discord audit**: `withIdempotencyGuard` +
  `buildAuditEnvelope` + `notifyAdminAudit`, identical to
  `admin/credit-adjustments.ts`. Freeze/unfreeze are exactly the
  "stolen admin session" threat step-up + the #admin-audit fanout exist
  for.
- **User-facing state**: a frozen user's blocked request returns
  `403 ACCOUNT_FROZEN` (see `AccountFrozenError` in the scaffold). Whether
  to also surface a banner via `GET /api/me` is a product/legal question
  (§6 — tipping-off).

## 5. Enforcement points — THE COMPLETE LIST (completeness is the point)

Every path below moves value OUT of a user's account and MUST consult
the freeze before proceeding. Missing one is a money hole. Grouped as
(A) user-initiated HTTP entry points, (B) the durable DB debit
primitives they funnel through, and (C) outbound payouts (policy-gated).

The recommended enforcement is **defence-in-depth**: a cheap
fail-closed gate at each HTTP entry point (A) for a clean 403 and no
wasted work, PLUS the authoritative check inside each DB debit primitive
(B) — in the SAME transaction as the debit, re-reading the freeze under
the row lock the primitive already takes, so a freeze placed mid-flight
can't be raced (mirrors how `insertCreditOrderTxn` re-reads the balance
`FOR UPDATE`). The primitive-level checks (B) are the correctness
guarantee; the entry gates (A) are UX + cost control.

### A. User-initiated debit entry points (HTTP handlers)

1. **Loop-native order create** —
   `apps/backend/src/orders/loop-handler.ts:196`
   (`loopCreateOrderHandler`). Natural gate location: beside the existing
   velocity check at line ~279 (`checkOrderVelocity`), which is the
   established "read-only, fails-closed, before any money write" gate
   pattern. Covers `credit`, `loop_asset`, `xlm`, `usdc` methods.

2. **Loop-native LOOP redemption** —
   `apps/backend/src/orders/redeem.ts:186`
   (`redeemLoopOrderHandler`). Submits an on-chain payment FROM the
   user's embedded wallet to the deposit address (classic path). Gate
   before the fence/build/sign/submit block.

3. **Vault-share redemption** —
   `apps/backend/src/orders/redeem-vault.ts:74`
   (`redeemLoopOrderViaVault`). The USD/EUR Soroban fork of #2 (reached
   from `redeem.ts:260`). Collects the user's vault shares to the
   operator. Gate before `claimVaultRedemption`.

4. **Legacy CTX-proxy order create** —
   `apps/backend/src/orders/handler.ts:34`
   (`createOrderHandler`). Proxies a gift-card purchase to CTX using the
   user's bearer (pays in XLM). Does not touch `user_credits`, but it
   still initiates a purchase on the user's behalf and MUST be blocked
   for a frozen account. (Being retired with ADR 013 Phase C; gate it
   until then.)

### B. Durable DB debit primitives (the authoritative checks)

5. **Credit-funded order spend** —
   `apps/backend/src/orders/repo-credit-order.ts:56`
   (`insertCreditOrderTxn`). Writes the `type='spend'` row (line 84) and
   decrements `user_credits` (line 98) under a `FOR UPDATE` balance lock.
   This is "the only balance guard on the credit path" — add the freeze
   check here, in-txn, right beside the balance re-read.

6. **loop_asset redemption mirror debit** —
   `apps/backend/src/orders/transitions.ts:73` (`markOrderPaid`). The
   payment watcher calls this when the user's on-chain LOOP lands; it
   writes the `type='spend'` debit (line 138) + decrements `user_credits`
   (line 156) + enqueues the burn. NOTE: this runs in the async watcher,
   AFTER the on-chain payment already landed — so the real prevention is
   the entry gate (#2). A freeze arriving between submit and watcher-match
   is a policy edge (the money already left the wallet; the mirror debit
   just reconciles it). Document, don't silently skip.

7. **Vault redemption mirror debit** —
   `apps/backend/src/credits/vaults/vault-redemptions.ts:766`
   (`mirrorStep`). Writes the `type='spend'` debit (line 844) +
   decrements `user_credits` (line 850) in-txn, coupled to order
   payability. Same async-settlement caveat as #6 (the share collect at
   `collectSharesStep` already happened); entry gate #3 is the real
   prevention. The collect step (`collectSharesStep`, line ~403) is where
   the shares actually leave the user's wallet — if a freeze must stop an
   in-flight redemption, that is the last point to check.

8. **Admin credit adjustment (debit direction)** —
   `apps/backend/src/credits/adjustments.ts:95`
   (`applyAdminCreditAdjustment`). A negative `amountMinor` debits the
   user (line 195). This is admin-initiated, so a freeze should NOT block
   it (an operator zeroing a fraudulent balance is a remediation action)
   — but it is listed for completeness and to make the "admin actions
   bypass the freeze" decision explicit (§6).

### C. Outbound Stellar payouts (money to the user's wallet — policy-gated)

9. **Payout worker** —
   `apps/backend/src/payments/payout-worker-pay-one.ts:200` (`payOne`).
   Submits `pending_payouts` rows to `row.toAddress` (the user's wallet)
   for `kind='order_cashback'`, `'emission'`, `'interest_mint'`
   (`'burn'` targets the issuer, not the user — never gate it). If policy
   says a `full` hold pauses outbound payouts (recommended for AML), this
   is the one place to check: skip/hold a payout whose `userId` is frozen
   and leave the row `pending` for a post-release sweep. Because it is
   worker-driven (not per-request), it naturally re-evaluates each tick.

10. **Admin emission** —
    `apps/backend/src/admin/emissions.ts:99` (`adminEmissionHandler`,
    inserts a `pending_payouts` row at line ~245). Admin-initiated payout
    to a user's wallet — decide alongside #8/#9 whether an admin can emit
    to a frozen account.

### Related, NOT debits — flagged for the policy call (§6)

- **Payout-target change** —
  `apps/backend/src/users/stellar-address-handler.ts:44`
  (`setStellarAddressHandler`, `PUT /api/users/me/stellar-address`).
  Not a debit, but changing where cashback is paid while frozen could
  redirect future funds to an attacker address. A `full`/compromise hold
  should arguably block this.
- **DSR delete** — `apps/backend/src/users/dsr-delete.ts`
  (`POST /api/users/me/dsr/delete`). An account under a legal/AML hold
  must not be self-service deletable (evidence/retention). A live hold
  should block DSR delete.
- **Home-currency change** — `admin/home-currency-set.ts` /
  `users/home-currency-change.ts`. Already blocked on non-zero balance;
  a frozen account should not have its currency flipped either.

## 6. POLICY QUESTIONS for the human (must be answered before wiring)

1. **What does a hold block?** Debits/withdrawals only, or the full
   account (also block deposits/order-create funding, reduce to
   read-only)? Recommendation: block all user-initiated money-OUT
   (spend + redeem). Deposits/incoming are lower-risk — do we block them?
2. **Outbound payouts on a full hold** — do we PAUSE cashback / interest
   / emission payouts to a frozen wallet (AML: don't send funds to a
   possibly attacker-controlled address), or keep paying earned cashback?
   This decides whether enforcement point #9 (and #10) is in scope.
3. **Partial vs full freeze** — is `debits_only` vs `full` the right
   split, or do we need finer scopes (e.g. block redemptions but allow
   spend, or freeze a single currency)? The scaffold ships a 2-value
   enum; widening is a CHECK migration.
4. **AML reason codes** — the canonical compliance list. The scaffold's
   7 codes are a DRAFT; compliance must confirm the set and whether each
   maps to a required downstream action (SAR filing, retention window).
5. **Who can set / clear?** Proposed: `admin` tier + step-up for both.
   Should unfreeze require a SECOND authoriser (four-eyes) given it
   re-opens money movement? Should support be able to freeze (fast
   incident response) but not unfreeze?
6. **Admin actions bypass?** Do admin credit-adjustments (#8) and admin
   emissions (#10) ignore the freeze (remediation) or respect it?
   Recommendation: admin remediation writes bypass; admin emissions to a
   frozen user are blocked.
7. **In-flight redemptions** — if a freeze lands after the user has
   submitted an on-chain payment / vault-share collect but before the
   mirror debit settles (#6/#7), the money has already left the wallet.
   Do we let settlement complete (recommended — the debit just
   reconciles what already moved) or attempt a stop + manual refund?
8. **User notification / tipping-off** — does the frozen user see
   "account frozen, contact support", a generic error, or nothing?
   AML/sanctions holds often have anti-tipping-off constraints; legal
   must decide the user-facing copy and whether `GET /api/me` exposes the
   state.
9. **Legal / compliance review + auto-expiry** — do holds auto-expire or
   only clear manually? Retention of `account_holds` rows (they are a
   compliance record — likely exempt from DSR delete). Sign-off owner?
10. **Interaction with existing levers** — should placing a hold also
    auto-`revoke-sessions` (B4) and bump `token_version` to kill live
    access tokens, so a compromised account is locked out AND its money
    frozen in one action?

## 7. Scaffold delivered in this change (safe, non-migration)

`apps/backend/src/fraud/account-freeze.ts` — types only, no DB writes,
no reference to the not-yet-existing table/column:

- `ACCOUNT_HOLD_SCOPES`, `ACCOUNT_HOLD_REASON_CODES` (const arrays that
  the migration CHECKs will mirror — dual-layer convention).
- `AccountHold`, `AccountFreezeState`, `PlaceAccountHoldArgs`,
  `ReleaseAccountHoldArgs` interfaces.
- `AccountFreezeService` interface (place / release / list / listActive /
  getFreezeState) — the admin surface contract.
- `AccountFrozenError` (→ `403 ACCOUNT_FROZEN`) — real, reusable.
- `isAccountFrozen` / `assertAccountNotFrozen` — enforcement helper
  STUBS that **throw `AccountFreezeNotImplementedError`**, i.e. fail
  CLOSED. A premature wire-in makes gated debits throw (money stays put),
  never fail-open. Replace the throw with the real column-scoped
  `users.frozen_at` read when migration 0071+ lands.

Not shipped (needs migration + policy): the drizzle table, the mirror
column, the service implementation, the admin routes/handlers, the
step-up scope additions, and any wiring into paths #1–#10.

## 8. Rollout sketch (post-approval)

1. Migration 0071+ (table + mirror column + indexes), serialized.
2. Implement `AccountFreezeService` + replace the scaffold stubs with the
   real `users.frozen_at` read.
3. Admin routes + handlers + step-up scopes + Discord audit + tests.
4. Wire enforcement at #1–#8 (fail-closed), gated behind a
   `LOOP_ACCOUNT_FREEZE_ENABLED` flag; decide #9/#10 per §6.2/§6.6.
5. Mirror-vs-ledger reconciliation watcher + backfill (no rows → mirror
   all NULL, trivially consistent).
6. Load/rollback test: freeze → every path in §5 returns 403 / holds;
   unfreeze → all paths resume.
