import { Link } from 'react-router';
import type { MerchantGroup } from '@loop/shared';
import { merchantSlug } from '@loop/shared';
import { getImageProxyUrl } from '~/utils/image';
import { triggerHaptic } from '~/native/haptics';
import { LazyImage } from '~/components/ui/LazyImage';

export interface MerchantGroupCardProps {
  group: MerchantGroup;
  displayIndex?: number;
  className?: string;
  eager?: boolean;
  /**
   * Bulk cashback-rate lookup (ADR 011 / 015). The brand tile shows the
   * best rate across its variants — `lookupCashback(merchant.id)` returns
   * the numeric(5,2) string for one merchant; null for none.
   */
  lookupCashback?: (id: string) => string | null;
}

/**
 * A brand tile for a multi-variant merchant group (ADR 032). CTX models
 * one merchant per supplier SKU, so e.g. `dots.eco` is 14 listings; this
 * collapses them into one tile that links to the brand view
 * (`/brand/:slug`) where the variants are picked. Mirrors `MerchantCard`'s
 * styling, with an "N options" pill and best-of savings/cashback across
 * the group's members.
 */
export function MerchantGroupCard({
  group,
  displayIndex = 0,
  className = '',
  eager = false,
  lookupCashback,
}: MerchantGroupCardProps): React.JSX.Element {
  const slug = merchantSlug(group.name);

  // Representative imagery: prefer a member that has both a card image and
  // a logo, else fall back to the first member that has each individually.
  const withCard = group.members.find((m) => m.cardImageUrl !== undefined);
  const withLogo = group.members.find((m) => m.logoUrl !== undefined);
  const cardImgUrl =
    withCard?.cardImageUrl !== undefined ? getImageProxyUrl(withCard.cardImageUrl, 640) : undefined;
  const logoImgUrl =
    withLogo?.logoUrl !== undefined ? getImageProxyUrl(withLogo.logoUrl, 160) : undefined;

  // Best-of across the group: the brand tile advertises the strongest
  // offer any variant carries, so the headline doesn't undersell.
  const maxSavings = group.members.reduce((acc, m) => Math.max(acc, m.savingsPercentage ?? 0), 0);
  const maxCashback = group.members.reduce((acc, m) => {
    const pct = lookupCashback?.(m.id);
    const n = pct !== null && pct !== undefined ? Number(pct) : 0;
    return Number.isFinite(n) ? Math.max(acc, n) : acc;
  }, 0);
  const cashbackLabel = maxCashback > 0 ? (Math.round(maxCashback * 10) / 10).toString() : null;

  return (
    <Link
      to={`/brand/${slug}`}
      className="group block"
      data-index={displayIndex}
      aria-label={`${group.name} — ${group.members.length} options`}
      onClick={() => {
        void triggerHaptic();
      }}
    >
      <div
        className={`overflow-hidden rounded-lg border border-line bg-surface transition-[border-color,box-shadow,transform] duration-200 md:group-hover:border-line-strong md:group-hover:shadow-md md:group-hover:-translate-y-0.5 ${className}`}
      >
        <div className="relative aspect-video overflow-hidden bg-gradient-to-br from-gray-100 to-gray-200">
          {cardImgUrl !== undefined ? (
            <LazyImage
              src={cardImgUrl}
              alt={`${group.name} card`}
              width={640}
              height={360}
              eager={eager}
              className="w-full h-full"
            />
          ) : (
            <div className="w-full h-full bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center">
              <span className="text-white text-3xl font-bold">{group.name.charAt(0)}</span>
            </div>
          )}
          {/* "N options" pill — the brand-group marker. Top-left so it never
              collides with the savings/cashback badges in the top-right. */}
          <span className="absolute top-2 left-2 text-xs font-semibold text-ink bg-white/95 px-2 py-0.5 rounded-md shadow-xs backdrop-blur-sm tabular">
            {group.members.length} options
          </span>
          {maxSavings > 0 && (
            <span className="absolute top-2 right-2 text-xs font-semibold text-green-700 bg-white/95 px-2 py-0.5 rounded-md shadow-xs backdrop-blur-sm tabular">
              Save up to {maxSavings.toFixed(1)}%
            </span>
          )}
          {cashbackLabel !== null && (
            <span
              className={`absolute right-2 text-xs font-semibold text-blue-700 bg-white/95 px-2 py-0.5 rounded-md shadow-xs backdrop-blur-sm tabular ${
                maxSavings > 0 ? 'top-9' : 'top-2'
              }`}
            >
              {cashbackLabel}% cashback
            </span>
          )}
        </div>

        <div className="p-4">
          <div className="w-16 h-16 sm:w-20 sm:h-20 bg-white rounded-lg border border-line ring-4 ring-white shadow-sm flex items-center justify-center -mt-12 sm:-mt-16 mb-3 relative z-10 overflow-hidden">
            {logoImgUrl !== undefined ? (
              <LazyImage
                src={logoImgUrl}
                alt={`${group.name} logo`}
                width={80}
                height={80}
                eager={eager}
                className="w-full h-full"
              />
            ) : (
              <span className="text-ink-subtle text-sm font-bold">
                {group.name.substring(0, 2).toUpperCase()}
              </span>
            )}
          </div>

          <h3 className="text-sm sm:text-lg font-semibold text-ink mb-1 line-clamp-1 md:group-hover:text-blue-600 transition-colors">
            {group.name}
          </h3>
          <p className="text-xs text-ink-muted">{group.members.length} gift cards to choose from</p>
        </div>
      </div>
    </Link>
  );
}
