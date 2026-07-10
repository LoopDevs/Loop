import { useMemo } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { LocaleLink as Link } from '~/components/ui/LocaleLink';
import type { Route } from './+types/brand.$slug';
import { brandSlug, groupMerchants, merchantInCountry, variantLabel } from '@loop/shared';
import { useLocale } from '~/i18n/locale';
import { useAllMerchants, useMerchantsCashbackRatesMap } from '~/hooks/use-merchants';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { Navbar } from '~/components/features/Navbar';
import { Footer } from '~/components/features/Footer';
import { MerchantCard } from '~/components/features/MerchantCard';
import { Spinner } from '~/components/ui/Spinner';
import i18n from '~/i18n/i18next';

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  let name = params.slug ?? '';
  try {
    name = decodeURIComponent(name);
  } catch {
    // keep the raw value
  }
  name = name.replace(/-/g, ' ');
  return [
    { title: i18n.t('brand:meta.title', { name }) },
    {
      name: 'description',
      content: i18n.t('brand:meta.description', { name }),
    },
  ];
}

/**
 * Brand view (ADR 032). CTX models one merchant per supplier SKU, so a
 * brand like `dots.eco` is many listings; the directory collapses them
 * into one tile that links here, where the variants are listed for the
 * user to pick. Grouping is derived client-side from `useAllMerchants`
 * — the same source the directory groups — so this needs no new endpoint.
 */
export default function BrandRoute(): React.JSX.Element {
  const { t } = useTranslation('brand');
  const { slug = '' } = useParams<{ slug: string }>();
  const { isNative } = useNativePlatform();
  const navigate = useNavigate();
  const { merchants, isLoading, isError } = useAllMerchants();
  const { lookup: lookupCashback } = useMerchantsCashbackRatesMap();
  const { country } = useLocale();

  // Audit CF-31 / ADR 034: scope to the active country BEFORE grouping, exactly
  // as home.tsx does — otherwise a `/us/en` visitor's brand page mixes in
  // CA/GB/EUR variants. The brand key itself stays country-agnostic
  // (brandSlug), but the variants listed are only those available here.
  const countryMerchants = useMemo(
    () => merchants.filter((m) => merchantInCountry(m, country)),
    [merchants, country],
  );
  // CAT-03 (2026-06-30 cold audit): brandSlug() always lowercases its
  // output, but the raw URL slug was compared verbatim — a hand-typed
  // or old-backlink `/brand/Adidas` 404'd even though `/brand/adidas`
  // resolves. Every other slug-resolution path in the codebase is
  // explicitly case-insensitive; run the raw param through the same
  // brandSlug() normalisation before comparing, matching that
  // convention. decodeURIComponent throws on malformed percent escapes
  // (e.g. "%ZZ") — same guarded pattern as this file's meta() above.
  const group = useMemo(() => {
    let decoded = slug;
    try {
      decoded = decodeURIComponent(slug);
    } catch {
      // keep the raw value
    }
    const normalizedSlug = brandSlug(decoded);
    return groupMerchants(countryMerchants).find((g) => brandSlug(g.name) === normalizedSlug);
  }, [countryMerchants, slug]);

  const handleBack = (): void => {
    if (window.history.length > 1) {
      void navigate(-1);
    } else {
      void navigate('/');
    }
  };

  return (
    <div>
      {!isNative && <Navbar />}
      {/* A11Y-010 / CF-35: <main> landmark + skip-link target. */}
      <main id="main" className={isNative ? '' : 'pt-20'}>
        <div className="container mx-auto px-4 py-8 max-w-6xl">
          <button
            onClick={handleBack}
            className="text-sm text-ink-muted hover:text-ink mb-6 inline-flex items-center gap-1"
          >
            {t('back')}
          </button>

          {isLoading ? (
            <div className="flex justify-center py-24">
              <Spinner />
            </div>
          ) : isError || group === undefined ? (
            <div className="text-center py-24">
              <h1 className="text-2xl font-semibold text-ink mb-3">{t('notFound.heading')}</h1>
              <p className="text-ink-muted mb-6">{t('notFound.body')}</p>
              <Link to="/" className="text-blue-600 underline">
                {t('notFound.link')}
              </Link>
            </div>
          ) : (
            <>
              <header className="mb-8">
                <h1 className="text-3xl font-semibold tracking-[-0.02em] text-ink mb-2">
                  {group.name}
                </h1>
                <p className="text-base text-ink-muted">
                  {t('header.sub', { count: group.members.length })}
                </p>
              </header>
              <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-6">
                {group.members.map((merchant, i) => (
                  <MerchantCard
                    key={merchant.id}
                    merchant={merchant}
                    displayName={variantLabel(merchant)}
                    displayIndex={i}
                    eager={i < 4}
                    userCashbackPct={lookupCashback(merchant.id)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </main>
      {!isNative && <Footer />}
    </div>
  );
}
