import { Link } from 'react-router';
import type { Merchant } from '@loop/shared';
import { merchantSlug } from '@loop/shared';
import { LazyImage } from '~/components/ui/LazyImage';
import { getImageProxyUrl } from '~/utils/image';
import { Button } from '~/components/ui/Button';
import { triggerHaptic } from '~/native/haptics';

interface MapBottomSheetProps {
  merchant: Merchant;
  onClose: () => void;
}

/**
 * Mobile bottom sheet showing merchant info when a map pin is tapped.
 * Slides up from the bottom with a backdrop.
 */
export function MapBottomSheet({ merchant, onClose }: MapBottomSheetProps): React.JSX.Element {
  const cardUrl = merchant.cardImageUrl ? getImageProxyUrl(merchant.cardImageUrl, 640) : undefined;
  const logoUrl = merchant.logoUrl ? getImageProxyUrl(merchant.logoUrl, 80) : undefined;
  const slug = merchantSlug(merchant.name);

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-[1000] bg-black/40 animate-fade-in" onClick={onClose} />

      {/* Sheet */}
      <div className="fixed bottom-0 left-0 right-0 z-[1001] animate-slide-up native-safe-bottom">
        <div className="bg-white dark:bg-gray-900 rounded-t-2xl shadow-2xl overflow-hidden max-w-lg mx-auto">
          {/* Drag handle */}
          <div className="flex justify-center py-2">
            <div className="w-10 h-1 rounded-full bg-gray-300 dark:bg-gray-600" />
          </div>

          {/* Card image */}
          {cardUrl !== undefined && (
            <div className="h-32 relative">
              <LazyImage
                src={cardUrl}
                alt={`${merchant.name} card`}
                className="w-full h-full"
                eager
              />
            </div>
          )}

          {/* Content */}
          <div className="p-4">
            <div className="flex items-center gap-3 mb-3">
              {logoUrl !== undefined && (
                <div className="w-12 h-12 rounded-lg overflow-hidden border-2 border-white dark:border-gray-800 shadow-sm flex-shrink-0">
                  <LazyImage
                    src={logoUrl}
                    alt={`${merchant.name} logo`}
                    className="w-full h-full"
                    eager
                  />
                </div>
              )}
              <div className="min-w-0">
                <h3 className="font-semibold text-gray-900 dark:text-white truncate">
                  {merchant.name}
                </h3>
                <div className="flex items-center gap-2 mt-0.5">
                  {merchant.savingsPercentage !== undefined && merchant.savingsPercentage > 0 && (
                    <span className="text-xs font-semibold text-green-700 dark:text-green-400">
                      Save {merchant.savingsPercentage.toFixed(1)}%
                    </span>
                  )}
                  {merchant.denominations?.type === 'min-max' &&
                    merchant.denominations.min !== undefined &&
                    merchant.denominations.max !== undefined && (
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        ${merchant.denominations.min}&ndash;${merchant.denominations.max}
                      </span>
                    )}
                </div>
              </div>
            </div>

            <Link
              to={`/gift-card/${encodeURIComponent(slug)}`}
              onClick={() => {
                void triggerHaptic();
              }}
            >
              <Button className="w-full">Buy Gift Card</Button>
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
