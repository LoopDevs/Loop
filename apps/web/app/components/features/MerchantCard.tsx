import { LocaleLink as Link } from '~/components/ui/LocaleLink';
import type { Merchant } from '@loop/shared';
import { merchantSlug } from '@loop/shared';
import { getImageProxyUrl } from '~/utils/image';
import { brandTileStyle } from '~/utils/brand-color';
import { formatCashbackPct } from '~/utils/format-cashback';
import { triggerHaptic } from '~/native/haptics';
import { LazyImage } from '~/components/ui/LazyImage';
import { currencySymbol, formatNumber, useLocaleTag } from '~/i18n/format';
import { FavoriteToggleButton } from './FavoriteToggleButton';

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
 *
 * The numeric values flow through `formatNumber` (the route-locale
 * `Intl.NumberFormat` seam, ADR 034) so large denominations render with
 * grouping separators — "$1,000" not "$1000" — and follow the market's
 * grouping convention (a `/de/en` page shows "1.000"). Only the number
 * formatting is localised here; the symbol + dash presentation is unchanged.
 */
function renderDenominationRange(
  denominations: Merchant['denominations'],
  locale: string,
): React.JSX.Element | null {
  if (denominations === undefined) return null;

  const className = 'text-xs text-gray-500 dark:text-gray-400';
  const sym = currencySymbol(denominations.currency, locale);

  if (denominations.type === 'min-max') {
    if (denominations.min === undefined || denominations.max === undefined) return null;
    return (
      <p className={className}>
        {sym}
        {formatNumber(denominations.min, locale)} – {sym}
        {formatNumber(denominations.max, locale)}
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
          {formatNumber(min, locale)}
        </p>
      );
    }
    return (
      <p className={className}>
        {sym}
        {formatNumber(min, locale)} – {sym}
        {formatNumber(max, locale)}
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
  /**
   * Override the displayed title. The brand view (ADR 032) passes the
   * variant label (e.g. "Plant a Tree") so cards under a "dots.eco"
   * header don't repeat the brand ("dots.eco - Plant a Tree"). Defaults
   * to `merchant.name`. Image alt text keeps the full name.
   */
  displayName?: string;
}

export function MerchantCard({
  merchant,
  displayIndex = 0,
  className = '',
  eager = false,
  userCashbackPct = null,
  displayName,
}: MerchantCardProps): React.JSX.Element {
  const slug = merchantSlug(merchant);
  const cardImgUrl =
    merchant.cardImageUrl !== undefined ? getImageProxyUrl(merchant.cardImageUrl, 640) : undefined;
  const logoImgUrl =
    merchant.logoUrl !== undefined ? getImageProxyUrl(merchant.logoUrl, 160) : undefined;
  const cashbackLabel = formatCashbackPct(userCashbackPct);
  // Route locale drives the denomination-range grouping separators (ADR 034).
  const locale = useLocaleTag();

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
        className={`overflow-hidden rounded-lg border border-line bg-surface transition-[border-color,box-shadow,transform] duration-200 md:group-hover:border-line-strong md:group-hover:shadow-md md:group-hover:-translate-y-0.5 ${className}`}
      >
        {/* Card image */}
        <div className="relative aspect-video overflow-hidden bg-gradient-to-br from-gray-100 to-gray-200">
          {cardImgUrl !== undefined ? (
            <LazyImage
              src={cardImgUrl}
              alt={`${merchant.name} card`}
              width={640}
              height={360}
              eager={eager}
              className="w-full h-full"
              fallback={
                <div
                  className="w-full h-full flex items-center justify-center"
                  style={brandTileStyle(merchant.name)}
                >
                  <span className="text-white text-3xl font-bold">{merchant.name.charAt(0)}</span>
                </div>
              }
            />
          ) : (
            <div
              className="w-full h-full flex items-center justify-center"
              style={brandTileStyle(merchant.name)}
            >
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
            <span className="absolute top-2 right-2 text-xs font-semibold text-green-700 bg-white/95 px-2 py-0.5 rounded-md shadow-xs backdrop-blur-sm tabular">
              Save {merchant.savingsPercentage.toFixed(1)}%
            </span>
          )}
          {cashbackLabel !== null && (
            <span
              className={`absolute right-2 text-xs font-semibold text-blue-700 bg-white/95 px-2 py-0.5 rounded-md shadow-xs backdrop-blur-sm tabular ${
                merchant.savingsPercentage !== undefined && merchant.savingsPercentage > 0
                  ? 'top-9'
                  : 'top-2'
              }`}
            >
              {cashbackLabel}% cashback
            </span>
          )}
          {/* Favourite toggle pinned to the top-left so it never
              collides with the savings/cashback badges in the
              top-right. Self-gated on isAuthenticated — renders
              nothing for signed-out visitors. */}
          <FavoriteToggleButton merchantId={merchant.id} className="absolute top-2 left-2" />
        </div>

        <div className="p-4">
          {/* Logo */}
          <div className="w-16 h-16 sm:w-20 sm:h-20 bg-white rounded-lg border border-line ring-4 ring-white shadow-sm flex items-center justify-center -mt-12 sm:-mt-16 mb-3 relative z-10 overflow-hidden">
            {logoImgUrl !== undefined ? (
              <LazyImage
                src={logoImgUrl}
                alt={`${merchant.name} logo`}
                width={80}
                height={80}
                eager={eager}
                className="w-full h-full"
                fallback={
                  <span className="text-ink-subtle text-sm font-bold">
                    {merchant.name.substring(0, 2).toUpperCase()}
                  </span>
                }
              />
            ) : (
              <span className="text-ink-subtle text-sm font-bold">
                {merchant.name.substring(0, 2).toUpperCase()}
              </span>
            )}
          </div>

          <h3 className="text-sm sm:text-lg font-semibold text-ink mb-2 line-clamp-1 md:group-hover:text-blue-600 transition-colors">
            {displayName ?? merchant.name}
          </h3>

          {renderDenominationRange(merchant.denominations, locale)}
        </div>
      </div>
    </Link>
  );
}
