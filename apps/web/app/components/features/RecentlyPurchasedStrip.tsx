import { useRecentlyPurchased } from '~/hooks/use-recently-purchased';
import { useAuth } from '~/hooks/use-auth';
import { MerchantCard } from './MerchantCard';
import { useMerchantsCashbackRatesMap } from '~/hooks/use-merchants';

interface Props {
  /**
   * Layout variant matching `FavoritesStrip` — `desktop` for
   * `routes/home.tsx`, `mobile` for the mobile home tab. Same
   * shape on both surfaces so a returning user sees recently-
   * purchased and favourites stacked consistently.
   */
  variant: 'desktop' | 'mobile';
}

/**
 * "Recently purchased" strip surfaced on the home page.
 *
 * Distinct merchants the caller has bought from (`state IN
 * ('paid', 'procuring', 'fulfilled')`), most-recent first. Sister
 * component to `FavoritesStrip`: same layout + `MerchantCard`
 * plumbing, different data source.
 *
 * Self-gates on:
 *   1. `isAuthenticated` — hidden for signed-out visitors so we
 *      don't fire a guaranteed-401 fetch.
 *   2. `merchants.length > 0` — hidden for users with no qualifying
 *      orders yet (don't tease an empty section to brand-new
 *      accounts).
 */
export function RecentlyPurchasedStrip({ variant }: Props): React.JSX.Element | null {
  const { isAuthenticated } = useAuth();
  const { merchants } = useRecentlyPurchased(isAuthenticated);
  const { lookup: lookupCashback } = useMerchantsCashbackRatesMap();

  if (!isAuthenticated || merchants.length === 0) return null;

  if (variant === 'mobile') {
    return (
      <>
        <div className="px-5 pt-1 pb-2 flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">
            Recently purchased
          </h2>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {merchants.length} brand{merchants.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="px-5 pb-4 grid grid-cols-2 gap-2.5">
          {merchants.map(
            (m, i) =>
              m.merchant !== null && (
                <MerchantCard
                  key={m.merchantId}
                  merchant={m.merchant}
                  displayIndex={i}
                  userCashbackPct={lookupCashback(m.merchantId)}
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
        <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-4">
          Recently purchased
        </h2>
        <p className="text-lg text-gray-600 dark:text-gray-300 max-w-2xl mx-auto">
          Re-buy from a merchant you&rsquo;ve bought from before.
        </p>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
        {merchants.map(
          (m, i) =>
            m.merchant !== null && (
              <MerchantCard
                key={m.merchantId}
                merchant={m.merchant}
                displayIndex={i}
                eager={i < 4}
                userCashbackPct={lookupCashback(m.merchantId)}
              />
            ),
        )}
      </div>
    </section>
  );
}
