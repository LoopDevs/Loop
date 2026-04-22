/**
 * Stellar cashback payout state machine (ADR 015 / 016).
 *
 * `pending` → `submitted` → `confirmed`
 *                       ↘ `failed` (retryable via admin reset-to-pending)
 *
 * Mirrors the Postgres CHECK constraint (`pending_payouts_state_known`
 * in `apps/backend/src/db/schema.ts`) and the per-state filter UI on
 * `/admin/payouts` + `/settings/cashback`. Drift between the two is
 * an invariant violation per ADR 019 — editing this tuple requires
 * matching the Drizzle `check(...)` literal and any migration that
 * added the enum.
 *
 * `failed` is NOT a terminal state for ops — the admin retry primitive
 * (ADR 016) resets the row to `pending` so the submit worker picks it
 * up on the next tick. `confirmed` is the only truly terminal state.
 */
export const PAYOUT_STATES = ['pending', 'submitted', 'confirmed', 'failed'] as const;
export type PayoutState = (typeof PAYOUT_STATES)[number];

export function isPayoutState(s: string): s is PayoutState {
  return (PAYOUT_STATES as readonly string[]).includes(s);
}
