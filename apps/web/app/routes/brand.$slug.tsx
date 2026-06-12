import { useParams, useNavigate } from 'react-router';
import { LocaleLink as Link } from '~/components/ui/LocaleLink';
import type { Route } from './+types/brand.$slug';
import { brandSlug, groupMerchants, variantLabel } from '@loop/shared';
import { useAllMerchants, useMerchantsCashbackRatesMap } from '~/hooks/use-merchants';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { Navbar } from '~/components/features/Navbar';
import { Footer } from '~/components/features/Footer';
import { MerchantCard } from '~/components/features/MerchantCard';
import { Spinner } from '~/components/ui/Spinner';

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  let name = params.slug ?? '';
  try {
    name = decodeURIComponent(name);
  } catch {
    // keep the raw value
  }
  name = name.replace(/-/g, ' ');
  return [
    { title: `${name} gift cards — Loop` },
    {
      name: 'description',
      content: `Choose from every ${name} gift card option and save with XLM.`,
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
  const { slug = '' } = useParams<{ slug: string }>();
  const { isNative } = useNativePlatform();
  const navigate = useNavigate();
  const { merchants, isLoading, isError } = useAllMerchants();
  const { lookup: lookupCashback } = useMerchantsCashbackRatesMap();

  // Country-agnostic brand lookup: one brand tile covers every country, so we
  // match on brandSlug (no country dimension) — the same key MerchantGroupCard
  // / DirectoryGroupCell link with. Per-variant links inside use merchantSlug.
  const group = groupMerchants(merchants).find((g) => brandSlug(g.name) === slug);

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
      <div className={isNative ? '' : 'pt-20'}>
        <div className="container mx-auto px-4 py-8 max-w-6xl">
          <button
            onClick={handleBack}
            className="text-sm text-ink-muted hover:text-ink mb-6 inline-flex items-center gap-1"
          >
            ← Back
          </button>

          {isLoading ? (
            <div className="flex justify-center py-24">
              <Spinner />
            </div>
          ) : isError || group === undefined ? (
            <div className="text-center py-24">
              <h1 className="text-2xl font-semibold text-ink mb-3">Brand not found</h1>
              <p className="text-ink-muted mb-6">
                We couldn&apos;t find that brand. It may have moved or be unavailable.
              </p>
              <Link to="/" className="text-blue-600 underline">
                Back to directory
              </Link>
            </div>
          ) : (
            <>
              <header className="mb-8">
                <h1 className="text-3xl font-semibold tracking-[-0.02em] text-ink mb-2">
                  {group.name}
                </h1>
                <p className="text-base text-ink-muted">
                  {group.members.length} gift card options. Pick the one you want.
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
      </div>
      {!isNative && <Footer />}
    </div>
  );
}
