/**
 * LOOP-branded fiat stablecoin codes (ADR 015).
 *
 * USDLOOP / GBPLOOP / EURLOOP — one LoopAsset per home currency,
 * issued by the Loop operator account on Stellar. Users hold these
 * as their cashback balance; the backend credits them 1:1 against
 * fiat liability when an order is fulfilled.
 *
 * The mapping `USD → USDLOOP` etc. is a 1:1 naming convention baked
 * into the strategy (not infra config). Keeping it in one place
 * prevents the four existing string-union declarations across web
 * services and admin routes from drifting (discovered in the shared
 * refactor of #453).
 */
export const LOOP_ASSET_CODES = ['USDLOOP', 'GBPLOOP', 'EURLOOP'] as const;
export type LoopAssetCode = (typeof LOOP_ASSET_CODES)[number];

/** The three home currencies this mapping covers — matches ADR 015. */
type SupportedCurrency = 'USD' | 'GBP' | 'EUR';

const BY_HOME_CURRENCY: Record<SupportedCurrency, LoopAssetCode> = {
  USD: 'USDLOOP',
  GBP: 'GBPLOOP',
  EUR: 'EURLOOP',
};

/**
 * Resolve the LoopAsset code for a user's home currency. Total —
 * every supported home currency has a matching LoopAsset by
 * construction. Accepts the broader `string` at the call site so
 * the web side (which reads currency from the server) doesn't need
 * a pre-cast; invalid currencies fall through to `undefined` and
 * callers narrow as needed.
 */
export function loopAssetForHomeCurrency(currency: string): LoopAssetCode | undefined {
  return BY_HOME_CURRENCY[currency as SupportedCurrency];
}

/** Narrowing helper — `true` when `value` is one of the LoopAsset codes. */
export function isLoopAssetCode(value: string): value is LoopAssetCode {
  return (LOOP_ASSET_CODES as ReadonlyArray<string>).includes(value);
}
