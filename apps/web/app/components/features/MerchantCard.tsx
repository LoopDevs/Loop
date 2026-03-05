import { Link } from 'react-router';
import type { Merchant } from '@loop/shared';
import { toSlug } from '~/hooks/slug';
import { getImageProxyUrl } from '~/utils/image';

export interface MerchantCardProps {
  merchant: Merchant;
  displayIndex?: number;
  className?: string;
}

export function MerchantCard({ merchant, displayIndex = 0, className = '' }: MerchantCardProps): React.JSX.Element {
  const slug = toSlug(merchant.name);
  const cardImgUrl = merchant.cardImageUrl !== undefined ? getImageProxyUrl(merchant.cardImageUrl, 640) : undefined;
  const logoImgUrl = merchant.logoUrl !== undefined ? getImageProxyUrl(merchant.logoUrl, 160) : undefined;

  return (
    <Link to={`/gift-card/${slug}`} className="group block" data-index={displayIndex}>
      <div className={`overflow-hidden rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 transition-all duration-300 md:group-hover:shadow-xl md:group-hover:-translate-y-1 ${className}`}>
        {/* Card image */}
        <div className="relative aspect-video overflow-hidden bg-gradient-to-br from-gray-200 to-gray-300 dark:from-gray-700 dark:to-gray-800">
          {cardImgUrl !== undefined ? (
            <img
              src={cardImgUrl}
              alt={`${merchant.name} card`}
              loading="lazy"
              className="w-full h-full object-cover transition-transform duration-300 md:group-hover:scale-105"
            />
          ) : (
            <div className="w-full h-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
              <span className="text-white text-3xl font-bold">{merchant.name.charAt(0)}</span>
            </div>
          )}
        </div>

        <div className="p-4">
          {/* Logo */}
          <div className="w-16 h-16 sm:w-20 sm:h-20 bg-gray-50 dark:bg-gray-800 rounded-lg border-[3px] border-white dark:border-gray-900 shadow-md flex items-center justify-center -mt-12 sm:-mt-16 mb-3 relative z-10 overflow-hidden">
            {logoImgUrl !== undefined ? (
              <img src={logoImgUrl} alt={`${merchant.name} logo`} loading="lazy" className="w-full h-full object-cover" />
            ) : (
              <span className="text-gray-500 text-sm font-bold">{merchant.name.substring(0, 2).toUpperCase()}</span>
            )}
          </div>

          <h3 className="text-sm sm:text-lg font-semibold text-gray-900 dark:text-white mb-2 line-clamp-1 md:group-hover:text-blue-600 dark:md:group-hover:text-blue-400 transition-colors">
            {merchant.name}
          </h3>

          <div className="space-y-1">
            {merchant.savingsPercentage !== undefined && merchant.savingsPercentage > 0 && (
              <span className="inline-block text-xs font-semibold text-green-700 bg-green-100 dark:text-green-400 dark:bg-green-900/30 px-2 py-0.5 rounded-full">
                Save {merchant.savingsPercentage.toFixed(1)}%
              </span>
            )}
            {merchant.denominations?.type === 'min-max' && merchant.denominations.min !== undefined && merchant.denominations.max !== undefined && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                ${merchant.denominations.min}–${merchant.denominations.max} {merchant.denominations.currency}
              </p>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}
