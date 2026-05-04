import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { Route } from './+types/trustlines';
import { getPublicLoopAssets, type PublicLoopAsset } from '~/services/public-stats';
import { shouldRetry } from '~/hooks/query-retry';
import { Navbar } from '~/components/features/Navbar';
import { Footer } from '~/components/features/Footer';
import { Phase2Gate } from '~/components/Phase2Gate';
import { CopyButton } from '~/components/features/admin/CopyButton';
import { Spinner } from '~/components/ui/Spinner';

/**
 * `/trustlines` — public LOOP asset trustlines page (#659).
 *
 * Unauthenticated SEO surface listing the verified (code, issuer)
 * pairs for USDLOOP / GBPLOOP / EURLOOP (ADR 015). Crypto-native
 * users landing on loopfinance.io via search or wallet
 * integrations can open trustlines against the **verified**
 * issuer accounts from here, without signing in first.
 *
 * The same `TrustlineSetupCard` on `/settings/wallet` covers the
 * signed-in flow — this page is the unauthenticated counterpart
 * with expanded copy aimed at crawlers and first-time visitors.
 * Answers the question that search surfaces (Google: "USDLOOP
 * trustline", "how to add LOOP asset", etc.).
 *
 * Data source: `/api/public/loop-assets` — ADR-020 never-500
 * public endpoint, already cached behind the edge. Server-side-
 * indexed meta tags carry the pitch; the live (code, issuer)
 * pairs hydrate client-side.
 */

const FREIGHTER_URL = 'https://www.freighter.app/';
const STELLAR_EXPERT_BASE = 'https://stellar.expert/explorer/public/account';

export function meta(): Route.MetaDescriptors {
  return [
    { title: 'LOOP asset trustlines — Loop' },
    {
      name: 'description',
      content:
        'Verified issuer accounts for USDLOOP, GBPLOOP, and EURLOOP Stellar stablecoins. Add a trustline from any Stellar wallet to receive cashback on Loop.',
    },
    { tagName: 'link', rel: 'canonical', href: 'https://loopfinance.io/trustlines' },
  ];
}

export default function TrustlinesRoute(): React.JSX.Element {
  return (
    <Phase2Gate>
      <TrustlinesBody />
    </Phase2Gate>
  );
}

function TrustlinesBody(): React.JSX.Element {
  const query = useQuery({
    queryKey: ['public-loop-assets'],
    queryFn: getPublicLoopAssets,
    retry: shouldRetry,
    staleTime: 5 * 60 * 1000,
  });

  return (
    <>
      <Navbar />
      <main className="container mx-auto max-w-3xl px-4 py-12 space-y-10">
        <header>
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-3">
            LOOP asset trustlines
          </h1>
          <p className="text-lg text-gray-600 dark:text-gray-300">
            Loop pays cashback in <span className="font-semibold">USDLOOP</span>,{' '}
            <span className="font-semibold">GBPLOOP</span>, and{' '}
            <span className="font-semibold">EURLOOP</span> — Stellar stablecoins pinned 1:1 to your
            home currency. To receive on-chain payouts, add a trustline against the verified issuer
            account below from any Stellar wallet.
          </p>
        </header>

        {query.isPending ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : query.isError ? (
          <p className="py-8 text-red-600 dark:text-red-400">
            Couldn&rsquo;t load the trustline list. Please refresh.
          </p>
        ) : query.data.assets.length === 0 ? (
          <p className="py-8 text-gray-500 dark:text-gray-400">
            Trustlines are being configured — check back soon.
          </p>
        ) : (
          <section aria-label="Verified LOOP asset issuers" className="space-y-3">
            {query.data.assets.map((asset) => (
              <AssetRow key={asset.code} asset={asset} />
            ))}
          </section>
        )}

        <section className="rounded-xl border border-gray-200 bg-white p-8 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
            Why trustlines?
          </h2>
          <p className="text-gray-700 dark:text-gray-300 mb-4">
            On Stellar, an account needs a trustline for every non-native asset it can hold. A
            trustline says:{' '}
            <em>this account is willing to receive tokens issued by this specific issuer.</em>{' '}
            Without one, an on-chain payout to a USDLOOP address would simply bounce.
          </p>
          <p className="text-gray-700 dark:text-gray-300">
            Using the issuer account from this page — rather than searching by asset code in your
            wallet — is the single most important safety step. Anyone can issue a token called
            &ldquo;USDLOOP&rdquo;; only the account below is the real Loop-operated issuer.
          </p>
        </section>

        <section className="rounded-xl border border-gray-200 bg-white p-8 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
            Recommended wallets
          </h2>
          <ul className="list-disc list-outside pl-6 space-y-2 text-gray-700 dark:text-gray-300">
            <li>
              <a
                href={FREIGHTER_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 underline hover:text-blue-800 dark:text-blue-400"
              >
                Freighter
              </a>{' '}
              — browser extension maintained by SDF. Adds trustlines via the Manage Assets screen.
            </li>
            <li>
              <a
                href="https://lobstr.co/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 underline hover:text-blue-800 dark:text-blue-400"
              >
                Lobstr
              </a>{' '}
              — mobile wallet with a built-in asset search. Paste the issuer account from above.
            </li>
          </ul>
        </section>

        <section className="text-center">
          <Link
            to="/"
            className="text-sm text-gray-600 underline hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
          >
            ← Back to home
          </Link>
        </section>
      </main>
      <Footer />
    </>
  );
}

function AssetRow({ asset }: { asset: PublicLoopAsset }): React.JSX.Element {
  return (
    <article
      className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900"
      aria-label={`${asset.code} issuer details`}
    >
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-xl font-semibold text-gray-900 dark:text-white">{asset.code}</h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            {pinnedCurrencyLine(asset.code)}
          </p>
        </div>
        <a
          href={`${STELLAR_EXPERT_BASE}/${asset.issuer}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 underline hover:text-blue-800 dark:text-blue-400"
        >
          View on Stellar Expert
        </a>
      </div>
      <div className="mt-4">
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Issuer account</p>
        <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-xs text-gray-900 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-100">
          <span className="break-all">{asset.issuer}</span>
          <CopyButton text={asset.issuer} label={`Copy ${asset.code} issuer account`} />
        </div>
      </div>
    </article>
  );
}

function pinnedCurrencyLine(code: PublicLoopAsset['code']): string {
  switch (code) {
    case 'USDLOOP':
      return '1 USDLOOP = 1 US dollar cashback, backed 1:1 by Loop fiat reserves.';
    case 'GBPLOOP':
      return '1 GBPLOOP = 1 British pound cashback, backed 1:1 by Loop fiat reserves.';
    case 'EURLOOP':
      return '1 EURLOOP = 1 Euro cashback, backed 1:1 by Loop fiat reserves.';
  }
}
