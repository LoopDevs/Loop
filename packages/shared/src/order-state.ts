/**
 * Loop order state machine (ADR 010).
 *
 * `pending_payment` → `paid` → `procuring` → `fulfilled`
 *                          ↘ `failed` / `expired` (terminal)
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
  'pending_payment',
  'paid',
  'procuring',
  'fulfilled',
  'failed',
  'expired',
] as const;
export type OrderState = (typeof ORDER_STATES)[number];

export function isOrderState(s: string): s is OrderState {
  return (ORDER_STATES as readonly string[]).includes(s);
}

// A2-817: `TERMINAL_ORDER_STATES` + `TerminalOrderState` +
// `isTerminalOrderState` had zero callers. The web polling loops
// the JSDoc claimed would consume them ended up using their own
// `state === 'fulfilled' || ...` literals, and the backend stops
// polling at the source. Removed; one less near-duplicate to keep
// in sync with the `ORDER_STATES` tuple above.

/**
 * Supported order payment rails (ADR 010 / 015).
 *
 * - `xlm`: native XLM payment, watched by the payment watcher.
 * - `usdc`: USDC via a trustline to the pinned issuer.
 * - `credit`: off-chain credit-ledger debit (ADR 009).
 * - `loop_asset`: a LOOP-branded stablecoin (USDLOOP / GBPLOOP /
 *   EURLOOP). The watcher accepts these as payment for other orders
 *   so cashback can circulate without a fiat off-ramp round-trip.
 */
export const ORDER_PAYMENT_METHODS = ['xlm', 'usdc', 'credit', 'loop_asset'] as const;
export type OrderPaymentMethod = (typeof ORDER_PAYMENT_METHODS)[number];

export function isOrderPaymentMethod(s: string): s is OrderPaymentMethod {
  return (ORDER_PAYMENT_METHODS as readonly string[]).includes(s);
}
