import { Link } from 'react-router';
import type { Merchant } from '@loop/shared';
import { merchantSlug } from '@loop/shared';
import { getImageProxyUrl } from '~/utils/image';
import { triggerHaptic } from '~/native/haptics';
import { LazyImage } from '~/components/ui/LazyImage';
import { currencySymbol } from '~/utils/money';

/**
 * Render the merchant's allowed gift-card range beneath the card.
 * Handles both denomination shapes:
 *   - `min-max`: direct min/max values + currency
 *   - `fixed`: collapse the discrete denominations array to its
 *     min and max so the card displays as a range too (e.g. Zappos'
 *     [10, 25, 50, 100, 250] → "£10 – £250" for GBP). Previously
 *     fixed merchants showed no range line at all.
 *
 * Uses the merchant's currency symbol (£ / $ / € / …) and omits the
 * trailing ISO code, which was noisy ("$10–$250 USD").
 */
function renderDenominationRange(
  denominations: Merchant['denominations'],
): React.JSX.Element | null {
  if (denominations === undefined) return null;

  const className = 'text-xs text-gray-500 dark:text-gray-400';
  const sym = currencySymbol(denominations.currency);

  if (denominations.type === 'min-max') {
    if (denominations.min === undefined || denominations.max === undefined) return null;
    return (
      <p className={className}>
        {sym}
        {denominations.min} – {sym}
        {denominations.max}
      </p>
    );
  }

  if (denominations.type === 'fixed' && denominations.denominations.length > 0) {
    // Backend types `denominations` as `string[]`, coerce to numbers
    // for a reliable min/max (Math.min on strings works via coercion
    // but sorts lexically in some paths — safer to normalise here).
    const values = denominations.denominations
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n));
    if (values.length === 0) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    // Single value → "£25" rather than "£25 – £25" which reads like a bug.
    if (min === max) {
      return (
        <p className={className}>
          {sym}
          {min}
        </p>
      );
    }
    return (
      <p className={className}>
        {sym}
        {min} – {sym}
        {max}
      </p>
    );
  }

  return null;
}

export interface MerchantCardProps {
  merchant: Merchant;
  displayIndex?: number;
  className?: string;
  /** When true, images load eagerly (use for above-the-fold cards). */
  eager?: boolean;
  /**
   * Active cashback % for this merchant (ADR 011 / 015), supplied from
   * the bulk `/api/merchants/cashback-rates` map. Null hides the badge.
   * Format matches the backend wire shape: numeric(5,2) as a string
   * (e.g. `"2.50"`). Callers should read it via
   * `useMerchantsCashbackRatesMap().lookup(merchant.id)`.
   */
  userCashbackPct?: string | null;
}

/**
 * Formats the numeric-string pct for the card badge. Drops trailing
 * zeros so whole-integer rates read as "5% cashback" rather than
 * "5.00% cashback", while partial rates keep their precision ("2.5").
 * Returns `null` when the input can't be made to render sensibly,
 * which the caller should translate to "don't render the badge".
 */
function formatCashbackPct(pct: string | null | undefined): string | null {
  if (pct === null || pct === undefined) return null;
  const n = Number(pct);
  if (!Number.isFinite(n) || n <= 0) return null;
  // One decimal place max — rates like 1.25% are rare and would clutter
  // a small pill; we prefer the slightly-less-precise "1.3%" read.
  const rounded = Math.round(n * 10) / 10;
  return rounded.toFixed(1).replace(/\.0$/, '');
}

export function MerchantCard({
  merchant,
  displayIndex = 0,
  className = '',
  eager = false,
  userCashbackPct = null,
}: MerchantCardProps): React.JSX.Element {
  const slug = merchantSlug(merchant.name);
  const cardImgUrl =
    merchant.cardImageUrl !== undefined ? getImageProxyUrl(merchant.cardImageUrl, 640) : undefined;
  const logoImgUrl =
    merchant.logoUrl !== undefined ? getImageProxyUrl(merchant.logoUrl, 160) : undefined;
  const cashbackLabel = formatCashbackPct(userCashbackPct);

  return (
    <Link
      to={`/gift-card/${slug}`}
      className="group block"
      data-index={displayIndex}
      onClick={() => {
        void triggerHaptic();
      }}
    >
      <div
        className={`overflow-hidden rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 transition-all duration-300 md:group-hover:shadow-xl md:group-hover:shadow-black/10 md:group-hover:-translate-y-1 ${className}`}
      >
        {/* Card image */}
        <div className="relative aspect-video overflow-hidden bg-gradient-to-br from-gray-200 to-gray-300 dark:from-gray-700 dark:to-gray-800">
          {cardImgUrl !== undefined ? (
            <LazyImage
              src={cardImgUrl}
              alt={`${merchant.name} card`}
              width={640}
              height={360}
              eager={eager}
              className="w-full h-full"
            />
          ) : (
            <div className="w-full h-full bg-gradient-to-br from-gray-400 to-gray-500 dark:from-gray-600 dark:to-gray-700 flex items-center justify-center">
              <span className="text-white text-3xl font-bold">{merchant.name.charAt(0)}</span>
            </div>
          )}
          {/* Savings + cashback badges stack in the top-right corner.
              Savings is upstream-provided (the merchant's discount
              vs face value); cashback is Loop-configured per merchant
              (ADR 011 / 015). Both render when both exist, with
              cashback taking the lower slot because it's the Loop-
              specific value and reads like an addition on top of the
              headline discount. */}
          {merchant.savingsPercentage !== undefined && merchant.savingsPercentage > 0 && (
            <span className="absolute top-2 right-2 text-xs font-semibold text-green-700 bg-green-100/95 dark:text-green-300 dark:bg-green-900/80 px-2 py-0.5 rounded-full shadow-sm backdrop-blur-sm">
              Save {merchant.savingsPercentage.toFixed(1)}%
            </span>
          )}
          {cashbackLabel !== null && (
            <span
              className={`absolute right-2 text-xs font-semibold text-blue-700 bg-blue-100/95 dark:text-blue-300 dark:bg-blue-900/80 px-2 py-0.5 rounded-full shadow-sm backdrop-blur-sm ${
                merchant.savingsPercentage !== undefined && merchant.savingsPercentage > 0
                  ? 'top-9'
                  : 'top-2'
              }`}
            >
              {cashbackLabel}% cashback
            </span>
          )}
        </div>

        <div className="p-4">
          {/* Logo */}
          <div className="w-16 h-16 sm:w-20 sm:h-20 bg-gray-50 dark:bg-gray-800 rounded-lg border-[3px] border-white dark:border-gray-900 shadow-md flex items-center justify-center -mt-12 sm:-mt-16 mb-3 relative z-10 overflow-hidden">
            {logoImgUrl !== undefined ? (
              <LazyImage
                src={logoImgUrl}
                alt={`${merchant.name} logo`}
                width={80}
                height={80}
                eager={eager}
                className="w-full h-full"
              />
            ) : (
              <span className="text-gray-500 text-sm font-bold">
                {merchant.name.substring(0, 2).toUpperCase()}
              </span>
            )}
          </div>

          <h3 className="text-sm sm:text-lg font-semibold text-gray-900 dark:text-white mb-2 line-clamp-1 md:group-hover:text-blue-600 dark:md:group-hover:text-blue-400 transition-colors">
            {merchant.name}
          </h3>

          {renderDenominationRange(merchant.denominations)}
        </div>
      </div>
    </Link>
  );
}
