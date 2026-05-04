import { useFavorites } from '~/hooks/use-favorites';
import { useAuth } from '~/hooks/use-auth';
import { MerchantCard } from './MerchantCard';
import { useMerchantsCashbackRatesMap } from '~/hooks/use-merchants';

interface Props {
  /**
   * Optional layout variant. `desktop` matches the centred-section
   * styling on `routes/home.tsx`; `mobile` matches the section-
   * header + 2-col grid pattern on the mobile home tab.
   */
  variant: 'desktop' | 'mobile';
}

/**
 * Per-user "Your favourites" strip surfaced on the home page.
 *
 * Self-gates on:
 *   1. `isAuthenticated` — hidden for signed-out visitors so we don't
 *      fire a guaranteed-401 fetch.
 *   2. `favorites.length > 0` — hidden for users who haven't pinned
 *      any merchants yet (the heart icon on each card is the
 *      onboarding affordance).
 *
 * Rendering is identical to the surrounding merchant grids — same
 * `MerchantCard`, same cashback-rate lookup. Only the section
 * header changes.
 */
export function FavoritesStrip({ variant }: Props): React.JSX.Element | null {
  const { isAuthenticated } = useAuth();
  const { favorites } = useFavorites(isAuthenticated);
  const { lookup: lookupCashback } = useMerchantsCashbackRatesMap();

  if (!isAuthenticated || favorites.length === 0) return null;

  if (variant === 'mobile') {
    return (
      <>
        <div className="px-5 pt-1 pb-2 flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">Your favourites</h2>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {favorites.length} pinned
          </span>
        </div>
        <div className="px-5 pb-4 grid grid-cols-2 gap-2.5">
          {favorites.map(
            (f, i) =>
              f.merchant !== null && (
                <MerchantCard
                  key={f.merchantId}
                  merchant={f.merchant}
                  displayIndex={i}
                  userCashbackPct={lookupCashback(f.merchantId)}
                />
              ),
          )}
        </div>
      </>
    );
  }

  return (
    <section className="mb-16">
      <div className="text-center mb-12">
        <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-4">Your favourites</h2>
        <p className="text-lg text-gray-600 dark:text-gray-300 max-w-2xl mx-auto">
          The merchants you&rsquo;ve pinned for quick access.
        </p>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
        {favorites.map(
          (f, i) =>
            f.merchant !== null && (
              <MerchantCard
                key={f.merchantId}
                merchant={f.merchant}
                displayIndex={i}
                eager={i < 4}
                userCashbackPct={lookupCashback(f.merchantId)}
              />
            ),
        )}
      </div>
    </section>
  );
}
