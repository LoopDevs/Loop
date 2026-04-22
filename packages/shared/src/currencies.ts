/**
 * Home-currency enum (ADR 015).
 *
 * The three currencies Loop's ledger is denominated in. Matches
 * the CHECK constraint on `users.home_currency` and the LoopAsset
 * codes (USDLOOP / GBPLOOP / EURLOOP) exposed on the Stellar side.
 *
 * Shared between backend (order creation, zod validators, DB
 * schema CHECK) and web (onboarding currency picker, type
 * declarations in service clients). One source of truth — adding
 * a region means changing this list and both the schema CHECK
 * and the web picker update in lockstep.
 */

export const HOME_CURRENCIES = ['USD', 'GBP', 'EUR'] as const;
export type HomeCurrency = (typeof HOME_CURRENCIES)[number];

/**
 * Narrowing helper. Returns `true` when `value` is one of the
 * supported home currencies. Lets the web side (which receives
 * currency strings from the user) branch without a second type
 * cast.
 */
export function isHomeCurrency(value: string): value is HomeCurrency {
  return (HOME_CURRENCIES as ReadonlyArray<string>).includes(value);
}
