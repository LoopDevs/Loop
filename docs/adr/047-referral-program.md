# ADR 047: Referral program (design)

Status: Proposed (design only) — active build deferred to the cashback
flip + a reward-economics decision
Date: 2026-07-10
Related: ADR 009 (credits ledger), ADR 015 (stablecoins), ADR 017 (admin
write primitives), ADR 036 (cashback token lifecycle — never-debit),
ADR 045 (fraud/abuse controls — the abuse primitives this reuses),
`docs/invariants.md`, `docs/threat-model.md`

## Context

`docs/go-live-plan.md` §P3 and `docs/roadmap.md` list a **referral
program** as a growth lever. This ADR fixes the design so it can be
built correctly later; it deliberately does **not** ship an active
program, for two reasons:

1. **The reward is a credit — Loop's cashback mechanism — and cashback
   is Phase-2-gated.** A referral reward pays value in `user_credits`
   (the off-chain mirror of on-chain LOOP, ADR 036). Every credit /
   cashback surface is currently gated off behind `LOOP_PHASE_1_ONLY`
   (see the structural gate in `orders/loop-handler.ts` and
   `orders/redeem.ts` — `loop_asset` create/redeem return
   `LOOP_ASSET_UNAVAILABLE_PHASE_1`). Loop is launching **discount-only**;
   the cashback flip is a later, operator-timed event. A referral
   program that emits credits in Phase 1 would ship Phase-2 value early
   and contradict that posture.
2. **The reward amount is a business/economics decision (🧭), not an
   engineering one.** How much a referral is worth — and whether it is
   a fixed per-currency minor amount or a percentage of the referee's
   first order — is a growth/margin call the operator makes, not a
   default this ADR should invent.

So the durable artifact now is the **design**: the data model, the
trigger, the reward-as-a-conserved-emission rule, and — most important
— the abuse model, which reuses the fraud primitives ADR 045 just
built. The active build (tables/migration, grant worker, UI, the env
var carrying the economics value) is a follow-up, sequenced after the
cashback flip.

## Decision

### 1. Mechanism — codes + a one-row-per-referee redemption table

- Each user has a **referral code**: short, non-guessable (not the raw
  `userId` — a sequential/derivable code leaks the user table and lets
  an attacker enumerate referrers). Recommend a dedicated
  `referral_codes` table (`user_id` UNIQUE, `code` UNIQUE, `created_at`)
  rather than a `users` column, so a code can be rotated/revoked without
  touching the identity row and the uniqueness/lookup index is isolated.
- A referee associates a code **once** — at signup or in settings. The
  association is recorded in a **`referral_redemptions`** table:
  `(referrer_user_id, referee_user_id, status, reward_txn_id, created_at,
rewarded_at)` with a **UNIQUE constraint on `referee_user_id`**. That
  constraint is the load-bearing idempotency guarantee: a referee can be
  referred by at most one referrer, ever, and can trigger at most one
  reward — enforced by the database, not by application convention (the
  same tier discipline `docs/invariants.md` demands of money-adjacent
  state). `referrer_user_id != referee_user_id` is a CHECK (cheap
  self-referral block; the funding-source check below is the real one).

### 2. Trigger — the referee's first `fulfilled` order, never signup

The reward emits when the referee completes their **first `fulfilled`
order** (`markOrderFulfilled` in `orders/fulfillment.ts`), not at
signup or at account association. Signup-triggered rewards are the
classic sockpuppet-farming hole — they pay out for zero economic
activity, so an attacker mints accounts in a loop and harvests. Gating
on a fulfilled order forces the attacker to fund and complete a real
purchase per sockpuppet, which (a) has a real cost and (b) produces the
on-chain funding-source signal the abuse model keys on. The grant is
attempted exactly once, from the fulfillment path, guarded by the
`referral_redemptions` row transitioning `pending → rewarded` under the
UNIQUE constraint.

### 3. Reward — a conserved emission, never a bespoke balance write

The reward is a **credit emission through the existing emission
primitive** (`credits/emissions.ts` — the `applyAdminEmission` shape,
generalised to a `referral` emission kind), NOT a direct
`user_credits` UPDATE. This is non-negotiable: the
`assert_emission_conservation` trigger (migration 0044) enforces INV-1
(off-chain ledger conservation) on every emission, and a bespoke
balance write would bypass it and desync the mirror — exactly the
"silently demote a DB-tier invariant to convention" failure mode the
repo is built to prevent. A referral reward is just another conserved
emission: it credits the referrer (and/or referee) and writes the
matching `credit_transactions` row atomically, `reward_txn_id` linking
back to the `referral_redemptions` row. It **never debits** (ADR 036).

### 4. Abuse model (reuses ADR 045) — walk the attacker

The threat is an attacker mass-minting sockpuppet accounts to farm
referral rewards. Four controls, layered:

- **Self-referral / shared-actor block — reuse ADR 045's
  shared-funding-source signal.** Before granting, check whether the
  referrer and referee share an on-chain funding source (the same
  detector B-3 built: `fraud/duplicate-account-signals.ts`, keyed on
  `orders.payment_received_payment ->> 'from'`, backed by the
  `fraud_signals` table / migration 0059). If they share a funding
  wallet, **refuse the reward and flag** — a shared wallet is the
  cheapest sockpuppet tell. (Flag, not hard-block the account: a shared
  household wallet is a real legitimate case, so the _account_ stays;
  only the _reward_ is withheld and a `fraud_signals` row is written.)
- **One reward per referee** — the `referee_user_id` UNIQUE constraint
  (§1). An attacker cannot re-refer the same sockpuppet twice.
- **Real-purchase gate** — the first-`fulfilled`-order trigger (§2)
  makes each farmed reward cost a funded, completed order.
- **Per-referrer velocity cap** — bound how many referral rewards one
  referrer can earn per rolling window, reusing B-3's velocity concept
  (`fraud/velocity.ts`), so even distinct-funding-wallet sockpuppets
  can't be harvested at scale before a human notices.

Walked: an attacker mints N sockpuppets. If they fund all from one
wallet → the shared-funding-source check refuses every reward. If they
fund each from a distinct wallet (expensive, and each must complete a
real order) → the per-referrer velocity cap throttles the harvest and
each reward leaves a `fraud_signals`/order trail. No single control is
sufficient alone; together they make farming uneconomic, which is the
Phase-1 bar (bound the blast radius; don't claim to make it impossible).

### 5. Phase gating — ships dark behind `LOOP_PHASE_1_ONLY`

The reward-granting path is gated behind `LOOP_PHASE_1_ONLY` exactly
like the other credit surfaces: while the flag is true, no reward is
emitted (the trigger no-ops, the `referral_redemptions` row can stay
`pending`). The code-sharing UI _may_ surface earlier (a user can see
and share their code), but **no value pays until the cashback flip** —
consistent with the discount-only launch. Flipping the flag activates
referral rewards alongside the rest of cashback.

## Invariants preserved

- **INV-1 (off-chain ledger conservation):** the reward is a conserved
  emission through the primitive guarded by `assert_emission_conservation`
  (migration 0044). No bespoke balance write.
- **Never-debit (ADR 036):** a referral reward only ever credits.
- **Idempotency:** the `referee_user_id` UNIQUE constraint makes the
  reward exactly-once at the DB tier, robust to a retried fulfillment.
- **Phase-1 posture:** structurally gated by `LOOP_PHASE_1_ONLY` — no
  Phase-2 value leaks into the discount-only launch.

## Consequences / deferred build

Deferred to the cashback flip + the 🧭 economics decision:

- The `referral_codes` + `referral_redemptions` tables and their
  migration. **Recommend deferring the migration until the flip** — a
  speculative schema written now may need to change once the economics
  (fixed amount vs percentage; referrer-only vs both-sided) are decided.
  This ADR is the durable artifact; the migration is cheap to write once
  the shape is final.
- The `referral` emission kind in `credits/emissions.ts` + the grant
  hook in `orders/fulfillment.ts`.
- The env var carrying the reward economics (value TBD — 🧭).
- The web UI (show/share my code; enter a code at signup or in
  settings).
- Wiring the four abuse controls (§4) into the grant path.

When built, it is a 💰 change (touches the emission path) and takes the
review-first + independent-money-review bar per `docs/standards.md`.

## Alternatives considered

- **Reward at signup.** Rejected — pays for zero economic activity and
  is the primary sockpuppet-farming vector (§2).
- **Bespoke `user_credits` UPDATE for the reward.** Rejected — bypasses
  `assert_emission_conservation` and desyncs the mirror (§3); violates
  INV-1's DB tier.
- **Referral code as a `users` column.** Rejected in favour of a
  dedicated table (§1) so codes rotate/revoke independently of identity
  and the uniqueness index is isolated.
- **Ship an active program in Phase 1 with a default reward.** Rejected
  — emits Phase-2 cashback value during a discount-only launch and
  pre-empts a business decision that is the operator's to make.
