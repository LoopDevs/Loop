/**
 * LOOP asset + home-currency mapping (ADR 015).
 *
 * Single source of truth for:
 *   - the three home currencies Loop supports (USD, GBP, EUR)
 *   - the three LOOP-branded Stellar asset codes that back them
 *     (USDLOOP, GBPLOOP, EURLOOP)
 *   - the 1:1 map between them
 *
 * Backend consumers:
 *   - `db/schema.ts` re-exports `HOME_CURRENCIES` for the
 *     `users.home_currency` CHECK constraint + drizzle enum.
 *   - `credits/payout-asset.ts` re-exports `LoopAssetCode` + the
 *     map; `payoutAssetFor()` stays backend-local because it reads
 *     from `env.ts` for the per-asset Stellar issuer.
 *   - `openapi.ts` / admin handlers use the enum for query-param
 *     validation.
 *
 * Web consumers:
 *   - admin-panel pages (`/admin/payouts`, `/admin/treasury`) use
 *     `LOOP_ASSET_CODES` for filter dropdowns + lookup tables.
 *   - `/settings/wallet` uses `loopAssetForCurrency()` to show the
 *     user which LOOP asset their payouts will arrive as.
 *
 * Why shared: the three-currency ↔ three-asset mapping was
 * duplicated in ~6 places before this slice. If one branch added
 * JPYLOOP and another didn't, every TypeScript callsite that
 * switched on the union would silently accept a "LoopAssetCode"
 * value the schema couldn't store.
 */

/**
 * Home currencies Loop supports. Ordered USD → GBP → EUR to match
 * the schema enum so a `as const` tuple lookup at index 0 gives
 * the default (US). Adding a new one is a schema migration + an
 * entry here + (usually) a Stellar asset issuer configured on
 * the backend's env.
 */
export const HOME_CURRENCIES = ['USD', 'GBP', 'EUR'] as const;
export type HomeCurrency = (typeof HOME_CURRENCIES)[number];

/**
 * LOOP-branded Stellar asset codes — one per home currency.
 * Stellar asset-code format allows 4-12 alphanumeric chars; the
 * `{HOME}LOOP` scheme gives us a distinctive wallet display + a
 * stable 1:1 relationship with home currency that's easy to read
 * in an explorer.
 */
export const LOOP_ASSET_CODES = ['USDLOOP', 'GBPLOOP', 'EURLOOP'] as const;
export type LoopAssetCode = (typeof LOOP_ASSET_CODES)[number];

/**
 * 1:1 home-currency → asset-code map. Typed `Record<HomeCurrency,
 * LoopAssetCode>` so adding a fourth home currency without a
 * matching asset (or vice versa) fails compilation.
 */
export const CURRENCY_TO_ASSET_CODE: Record<HomeCurrency, LoopAssetCode> = {
  USD: 'USDLOOP',
  GBP: 'GBPLOOP',
  EUR: 'EURLOOP',
};

/**
 * Resolves the LOOP asset code for a home currency. Pure — no env
 * reads. Backend's `payoutAssetFor()` wraps this with the issuer
 * lookup; this helper is what the frontend and any env-less call
 * sites reach for.
 */
export function loopAssetForCurrency(currency: HomeCurrency): LoopAssetCode {
  return CURRENCY_TO_ASSET_CODE[currency];
}

/**
 * Narrowing type-guard for the `LoopAssetCode` union. Callers
 * receiving an arbitrary string (URL params, CSV columns) can
 * narrow safely before switching on the code.
 */
export function isLoopAssetCode(s: string): s is LoopAssetCode {
  return (LOOP_ASSET_CODES as ReadonlyArray<string>).includes(s);
}

/**
 * Narrowing type-guard for `HomeCurrency`. Same shape as
 * `isLoopAssetCode` — accept an arbitrary string, narrow to the
 * enum before further use.
 */
export function isHomeCurrency(s: string): s is HomeCurrency {
  return (HOME_CURRENCIES as ReadonlyArray<string>).includes(s);
}
