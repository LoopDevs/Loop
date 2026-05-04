import { useFavorites, useToggleFavorite } from '~/hooks/use-favorites';
import { useAuth } from '~/hooks/use-auth';
import { triggerHaptic } from '~/native/haptics';

interface Props {
  merchantId: string;
  /** Optional className for positional overrides (e.g. absolute placement on a card). */
  className?: string;
}

/**
 * Heart-icon toggle for the per-user merchant favourites list.
 *
 * Self-gates on `isAuthenticated` — renders nothing for signed-out
 * visitors (no point teasing a feature they can't use until they log
 * in). Reads the favourite-set + the toggle mutation from the
 * dedicated hooks; an outer `MerchantCard` doesn't need to know
 * favourites exist.
 *
 * Stops propagation + prevents default so a button click on a
 * `<Link>`-wrapped card doesn't navigate to the merchant page.
 */
export function FavoriteToggleButton({
  merchantId,
  className = '',
}: Props): React.JSX.Element | null {
  const { isAuthenticated } = useAuth();
  const { favoritedIds, isLoading } = useFavorites(isAuthenticated);
  const { mutate, isPending } = useToggleFavorite();

  if (!isAuthenticated) return null;

  const isFavorited = favoritedIds.has(merchantId);
  const disabled = isLoading || isPending;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (disabled) return;
        void triggerHaptic();
        mutate({ merchantId, currentlyFavorited: isFavorited });
      }}
      aria-pressed={isFavorited}
      aria-label={isFavorited ? 'Remove from favourites' : 'Add to favourites'}
      title={isFavorited ? 'Remove from favourites' : 'Add to favourites'}
      disabled={disabled}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/95 text-gray-700 shadow-sm backdrop-blur-sm transition hover:bg-white dark:bg-gray-900/80 dark:text-gray-200 dark:hover:bg-gray-900 disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
    >
      <svg
        viewBox="0 0 20 20"
        width="18"
        height="18"
        fill={isFavorited ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={isFavorited ? 0 : 1.6}
        aria-hidden="true"
        className={isFavorited ? 'text-rose-500' : 'text-gray-700 dark:text-gray-200'}
      >
        <path d="M10 17.5s-6.5-4.2-6.5-9a3.5 3.5 0 0 1 6.5-1.83A3.5 3.5 0 0 1 16.5 8.5c0 4.8-6.5 9-6.5 9z" />
      </svg>
    </button>
  );
}
