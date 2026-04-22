import { useQuery } from '@tanstack/react-query';
import { getPublicLoopAssets, type PublicLoopAsset } from '~/services/public-stats';
import { shouldRetry } from '~/hooks/query-retry';
import { CopyButton } from '~/components/features/admin/CopyButton';
import { Spinner } from '~/components/ui/Spinner';

/**
 * `/settings/wallet` — trustline setup helper (ADR 015 / 020).
 *
 * Renders the configured LOOP stablecoin (code, issuer) pairs so a
 * user can open a trustline against the **verified** issuer account
 * from any Stellar wallet. Critical for user safety: without this,
 * users hunting trustlines against an asset code like `USDLOOP`
 * could open one to whichever unrelated account happened to issue
 * a same-named token — the exact spoofing vector ADR 015's issuer-
 * pinning is built to avoid.
 *
 * Data source: `/api/public/loop-assets` (#596). Unauthenticated +
 * cached, so the card renders before the rest of the auth-gated
 * wallet page finishes fetching.
 *
 * Self-hides on error / empty — this is a helper, not a load-bearing
 * control. A user with an already-configured trustline shouldn't
 * see a red error bar just because the config endpoint is down.
 */
export function TrustlineSetupCard(): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ['public-loop-assets'],
    queryFn: getPublicLoopAssets,
    retry: shouldRetry,
    // Public endpoint already serves Cache-Control: 300. 5-minute
    // client staleness matches so we don't double-paint when two
    // components on the page read this query.
    staleTime: 5 * 60 * 1000,
  });

  if (query.isPending) {
    return (
      <div className="flex justify-center py-4">
        <Spinner />
      </div>
    );
  }

  // Silent fail — the card is opt-in helper content, not the primary
  // flow. Showing the error would crowd an already-busy settings page.
  if (query.isError) return null;

  const assets = query.data.assets;
  if (assets.length === 0) return null;

  return (
    <section
      aria-labelledby="trustline-setup-heading"
      className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900"
    >
      <header className="border-b border-gray-200 px-5 py-4 dark:border-gray-800">
        <h2
          id="trustline-setup-heading"
          className="text-base font-semibold text-gray-900 dark:text-white"
        >
          LOOP asset trustlines
        </h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          To receive Loop cashback on-chain, add a trustline to each asset below from your Stellar
          wallet. Verify the issuer matches — LOOP assets from any other account are not affiliated
          with Loop.
        </p>
      </header>
      <ul role="list" className="divide-y divide-gray-100 dark:divide-gray-900">
        {assets.map((a) => (
          <TrustlineRow key={a.code} asset={a} />
        ))}
      </ul>
    </section>
  );
}

function TrustlineRow({ asset }: { asset: PublicLoopAsset }): React.JSX.Element {
  return (
    <li className="flex items-center gap-4 px-5 py-3">
      <div className="shrink-0 rounded-md bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/30 dark:text-green-300">
        {asset.code}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-gray-500 dark:text-gray-400">Issuer</div>
        <div
          className="truncate font-mono text-xs text-gray-900 dark:text-white"
          title={asset.issuer}
        >
          {asset.issuer}
        </div>
      </div>
      <CopyButton text={asset.issuer} label={`Copy ${asset.code} issuer`} />
    </li>
  );
}
