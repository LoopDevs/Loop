/**
 * Loop order state machine (ADR 052).
 *
 * A Loop order mirrors a CTX gift card's `displayStatus` — ctx is the
 * payment processor, so ctx owns the transitions:
 *
 *   `unpaid` → `paid` → `fulfilled`
 *        └──▶ `rejected` / `refunded` / `expired` (terminal)
 *
 * `expired` is Loop-local: CTX leaves a never-paid card `unpaid`
 * forever when its payment window lapses, so the mirror sweep flips
 * the local row once the CTX payment expiry has passed.
 *
 * This is the single source of truth for both the Postgres CHECK
 * constraint (`orders_state_known` in `apps/backend/src/db/schema.ts`)
 * and the UI-side order views (service types in `apps/web`). Drift
 * between the two is an invariant violation per ADR 019 — editing
 * this tuple requires matching the Drizzle `check(...)` literal and
 * any migration that added the enum; TypeScript will not catch that
 * for you because the Drizzle helper accepts raw SQL.
 */
export const ORDER_STATES = [
  'unpaid',
  'paid',
  'fulfilled',
  'rejected',
  'refunded',
  'expired',
] as const;
export type OrderState = (typeof ORDER_STATES)[number];

export function isOrderState(s: string): s is OrderState {
  return (ORDER_STATES as readonly string[]).includes(s);
}
