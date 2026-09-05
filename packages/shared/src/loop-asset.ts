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
 * Inverse of `loopAssetForCurrency`. The 1:1 mapping is total — every
 * `LoopAssetCode` maps to exactly one `HomeCurrency` — so this is a
 * pure function with no fallback. ADR-024 §5 uses this when reading a
 * `pending_payouts` row's `asset_code` to find the user_credits
 * currency for a compensation write.
 */
const ASSET_CODE_TO_CURRENCY: Record<LoopAssetCode, HomeCurrency> = {
  USDLOOP: 'USD',
  GBPLOOP: 'GBP',
  EURLOOP: 'EUR',
};

export function currencyForLoopAsset(code: LoopAssetCode): HomeCurrency {
  return ASSET_CODE_TO_CURRENCY[code];
}

/**
 * Narrowing type-guard for `HomeCurrency`. Same shape as
 * `isLoopAssetCode` — accept an arbitrary string, narrow to the
 * enum before further use.
 */
export function isHomeCurrency(s: string): s is HomeCurrency {
  return (HOME_CURRENCIES as ReadonlyArray<string>).includes(s);
}

/**
 * Extended supplier-currency markets (ADR 035, CF-19). These are
 * **display-only** currencies — a gift card priced in one of them is
 * orderable on the XLM rail, but there is no AEDLOOP/INRLOOP/… asset
 * and no cashback band. They differ from {@link HOME_CURRENCIES} on
 * purpose:
 *
 *   - HOME_CURRENCIES (USD/GBP/EUR) are *cashback* home currencies —
 *     each is 1:1 with a LOOP asset and is what a user's `user_credits`
 *     / `credit_transactions` ledger is denominated in. The schema
 *     CHECKs on those columns stay pinned to the three.
 *   - EXTENDED_ORDER_CURRENCIES are the *gift-card catalog* currencies
 *     the order path accepts beyond the home three. Under ADR 052 the
 *     customer pays CTX directly and the charge is recorded in the
 *     card's own fiat currency, so an extended code can land in both
 *     `orders.currency` and `orders.charge_currency` — but never in
 *     the credit ledger (no AEDLOOP/CADLOOP/… asset exists).
 *
 * ADR 035 surfaced the first five as display markets (≥15 enabled
 * merchants: AE/IN/SA/AU/MX), gated on the since-retired FX feed. CAD
 * joined under ADR 052: CA is an ADR 034 display country whose
 * merchants CTX serves, and with CTX as the payment processor there
 * is no rates-service gate left to wait on. The order handler
 * validates a request's currency against the merchant's CTX catalog
 * entry; this set's remaining job is pinning the DB-side
 * `orders_currency_known` CHECK (the fail-closed fence behind the
 * handler) via the lock-step tests, so keep set + schema mirror +
 * latest migration in agreement when adding a currency.
 */
export const EXTENDED_ORDER_CURRENCIES = ['AED', 'INR', 'SAR', 'AUD', 'MXN', 'CAD'] as const;
export type ExtendedOrderCurrency = (typeof EXTENDED_ORDER_CURRENCIES)[number];

/**
 * Every gift-card catalog currency the loop-native order path accepts:
 * the three cashback home currencies plus the ADR-035 extended markets.
 * This is the set the order handler validates the request `currency`
 * against — NOT {@link HOME_CURRENCIES}, which is the cashback/ledger
 * set and must stay USD/GBP/EUR.
 */
export const ORDERABLE_CURRENCIES = [...HOME_CURRENCIES, ...EXTENDED_ORDER_CURRENCIES] as const;
export type OrderableCurrency = (typeof ORDERABLE_CURRENCIES)[number];

/** Narrowing type-guard for the ADR-035 extended order currencies. */
export function isExtendedOrderCurrency(s: string): s is ExtendedOrderCurrency {
  return (EXTENDED_ORDER_CURRENCIES as ReadonlyArray<string>).includes(s);
}

/**
 * Narrowing type-guard for {@link ORDERABLE_CURRENCIES} — the gift-card
 * catalog currencies the order path accepts (home + extended). Use this
 * to validate a request's gift-card `currency`; use {@link isHomeCurrency}
 * only for the cashback/ledger/charge currency.
 */
export function isOrderableCurrency(s: string): s is OrderableCurrency {
  return (ORDERABLE_CURRENCIES as ReadonlyArray<string>).includes(s);
}
