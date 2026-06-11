# ADR 036 — Cashback-mode token lifecycle: on-chain-authoritative balance, emission/redemption ledger semantics

Status: Proposed (operator-stated model, 2026-06-11 — supersedes the 2026-05-03 clarification that
lived only in a code comment at `orders/transitions.ts`)
Date: 2026-06-11

## Context

The codebase carried two contradictory ledger conventions for the LOOP assets:

- **Cashback payouts** (fulfillment → `pending_payouts` → payout worker) credit the off-chain
  `user_credits` mirror AND emit on-chain LOOP, leaving both halves in place until redemption.
- **ADR 024 "withdrawals"** emit on-chain LOOP but debit `user_credits` at send time.

A user holding withdrawal-sourced LOOP therefore had tokens with a zeroed mirror; redeeming them
drove the (correct) redemption debit into the `user_credits_non_negative` CHECK. Before the
2026-06-11 watcher hardening this wedged deposit processing entirely (comprehensive-audit CRIT #2);
after it, the deposit parks in the skip table for manual reconciliation. The contradiction is the
disease; this ADR pins the single canonical model.

## Decision — the lifecycle (cashback mode)

1. **Earn.** The user buys a gift card with a supported payment method (crypto in Phase 1). The
   system pays cashback as a LOOP asset equal to the cashback amount in the purchase currency:
   a £50.00 purchase at 10% nets **5 GBPLOOP** (1 GBPLOOP ≡ £1.00).
2. **Authoritative balance.** The on-chain LOOP in the user's wallet **is** the user's balance.
   `user_credits` is Loop's internal liability **mirror** — credited when value is created,
   debited **only** when tokens return. The two move in lockstep; the asset-drift watcher
   reconciles them.
3. **Interest.** While the user holds LOOP, the system credits interest **nightly at midnight
   UTC** (APR/365 per night, e.g. 4%/365) — as an **on-chain mint** to the holder, mirrored into
   `user_credits` in the same operation. (Implementation: ADR 031's nightly-mint work. The current
   `accrue-interest.ts` credits the mirror only and MUST stay disabled —
   `INTEREST_APY_BASIS_POINTS` unset — until the on-chain half exists, or the halves diverge
   nightly.)
4. **Redeem.** The only ways value exits, both implemented as the user's LOOP returning to the
   system, extinguishing **both halves** (debit `user_credits`; tokens returned to the **issuer
   account**, which burns them natively on Stellar — no separate treasury account):
   - **Toward a gift-card purchase** (`paymentMethod='loop_asset'`), live today; or
   - **Fiat withdrawal** (e.g. GBPLOOP → GBP to the user's bank), a future redemption target —
     same inbound flow, different delivery rail.
5. **Seamless, fault-tolerant, fully abstracted.** Users never manually sign or move tokens; the
   system orchestrates wallet operations behind the scenes. This is a hard requirement and is what
   ADR 030 (Privy embedded wallet, server-orchestrated signing) exists to enable. Fault tolerance
   rides the 2026-06-11 substrate: skip-table retries for inbound deposits, redemption backfill,
   poison-payment isolation.

## Ledger convention (normative)

| Operation                                                               | On-chain                     | `user_credits` mirror                        |
| ----------------------------------------------------------------------- | ---------------------------- | -------------------------------------------- |
| Cashback payout (fulfillment)                                           | + LOOP to user               | **credit**                                   |
| Admin emission (re-scoped ADR 024 — backfill of a missed/failed payout) | + LOOP to user               | **no change** (the liability already exists) |
| Nightly interest                                                        | + LOOP mint to user          | **credit** (same op)                         |
| Redemption (gift card or future fiat-out)                               | LOOP returns → issuer (burn) | **debit**                                    |
| Anything else                                                           | never moves the mirror       | —                                            |

## Consequences

- `credits/withdrawals.ts` + ADR 024 are re-scoped from "withdrawal" to **emission**: the
  at-send `user_credits` debit is removed; `pending_payouts.kind='withdrawal'` rows are
  re-labelled. "Withdrawal" as a user-facing concept now exclusively means fiat-out redemption.
- Redemption (`orders/transitions.ts` loop_asset path) keeps its debit and gains the
  issuer-return burn routing it documents but never implemented; the asset-drift watcher's
  equation then converges instead of drifting monotonically.
- **`paymentMethod='credit'`** (inline mirror debit, no token movement) is **transitional**: under
  this model it is only coherent for balance that has not yet been emitted on-chain. Once
  automated payouts + embedded-wallet redemption are live, 'credit' is retired and "pay with your
  Loop balance" is implemented as automated token redemption. Until then it remains gated to
  exactly the not-yet-emitted portion (open question 3).

## Open questions

1. ~~Issuer-return vs separate treasury~~ — **decided 2026-06-11 (Ash): issuer-return** (native burn); revisit
   only if a treasury needs to re-emit without minting.
2. External-wallet users (pre-Privy, or who exported keys): their redemption is a manual send to
   the deposit address — supported (it's today's flow), but the seamless path assumes the
   embedded wallet.
3. Exact gating of the transitional 'credit' method to the unemitted balance (requires tracking
   emitted-vs-unemitted per user, or simply disabling 'credit' once auto-payout coverage is
   complete).
4. Interest on balance earned-but-not-yet-emitted (payout pending): accrue from earn-time or
   emission-time? Proposed: earn-time (the liability exists), implemented when ADR 031 lands.

## Relationship to other ADRs

- **Clarifies ADR 015** §redemption (the "both halves" model is now normative).
- **Re-scopes ADR 024** (withdrawal writer → emission primitive; debit removed).
- **Feeds ADR 031** (nightly on-chain interest mints; drift-watcher equation) and depends on
  **ADR 030** (embedded wallet) for the no-manual-signing requirement.
