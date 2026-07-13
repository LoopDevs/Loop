import { useQuery } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { LocaleLink as Link } from '~/components/ui/LocaleLink';
import type { Route } from './+types/trustlines';
import { canonicalHref } from '~/i18n/seo';
import i18n from '~/i18n/i18next';
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

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [
    { title: i18n.t('trustlines:meta.title') },
    {
      name: 'description',
      content: i18n.t('trustlines:meta.description'),
    },
    { tagName: 'link', rel: 'canonical', href: canonicalHref(params, '/trustlines') },
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
  const { t } = useTranslation('trustlines');
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
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-3">{t('heading')}</h1>
          <p className="text-lg text-gray-600 dark:text-gray-300">
            <Trans
              t={t}
              i18nKey="intro"
              components={{ bold: <span className="font-semibold" /> }}
            />
          </p>
        </header>

        {query.isPending ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : query.isError ? (
          <p className="py-8 text-red-600 dark:text-red-400">{t('loadError')}</p>
        ) : query.data.assets.length === 0 ? (
          <p className="py-8 text-gray-500 dark:text-gray-400">{t('empty')}</p>
        ) : (
          <section aria-label={t('issuersSectionLabel')} className="space-y-3">
            {query.data.assets.map((asset) => (
              <AssetRow key={asset.code} asset={asset} />
            ))}
          </section>
        )}

        <section className="rounded-xl border border-gray-200 bg-white p-8 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
            {t('why.heading')}
          </h2>
          <p className="text-gray-700 dark:text-gray-300 mb-4">
            <Trans t={t} i18nKey="why.body" components={{ em: <em /> }} />
          </p>
          <p className="text-gray-700 dark:text-gray-300">{t('why.safety')}</p>
        </section>

        <section className="rounded-xl border border-gray-200 bg-white p-8 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
            {t('wallets.heading')}
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
              — {t('wallets.freighterDesc')}
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
              — {t('wallets.lobstrDesc')}
            </li>
          </ul>
        </section>

        <section className="text-center">
          <Link
            to="/"
            className="text-sm text-gray-600 underline hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
          >
            {t('back')}
          </Link>
        </section>
      </main>
      <Footer />
    </>
  );
}

function AssetRow({ asset }: { asset: PublicLoopAsset }): React.JSX.Element {
  const { t } = useTranslation('trustlines');
  return (
    <article
      className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900"
      aria-label={t('asset.rowLabel', { code: asset.code })}
    >
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-xl font-semibold text-gray-900 dark:text-white">{asset.code}</h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            {pinnedCurrencyLine(t, asset.code)}
          </p>
        </div>
        <a
          href={`${STELLAR_EXPERT_BASE}/${asset.issuer}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 underline hover:text-blue-800 dark:text-blue-400"
        >
          {t('asset.stellarExpert')}
        </a>
      </div>
      <div className="mt-4">
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          {t('asset.issuerAccount')}
        </p>
        <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-xs text-gray-900 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-100">
          <span className="break-all">{asset.issuer}</span>
          <CopyButton text={asset.issuer} label={t('asset.copyIssuer', { code: asset.code })} />
        </div>
      </div>
    </article>
  );
}

// Plain non-component helper — takes the caller's bound `t` (docs/i18n.md §3,
// the `ledgerLabel(t, type)` pattern) rather than calling the hook itself.
// The pinned-line key is the asset code (USDLOOP / GBPLOOP / EURLOOP), a brand
// token kept verbatim; the exhaustive `code` union keeps it type-safe.
function pinnedCurrencyLine(t: TFunction<'trustlines'>, code: PublicLoopAsset['code']): string {
  return t(`pinned.${code}`);
}
