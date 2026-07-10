import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { LocaleLink as Link } from '~/components/ui/LocaleLink';
import type { Route } from './+types/calculator';
import { canonicalHref } from '~/i18n/seo';
import { getPublicTopCashbackMerchants, type TopCashbackMerchant } from '~/services/public-stats';
import { shouldRetry } from '~/hooks/query-retry';
import { useLocale } from '~/i18n/locale';
import { Navbar } from '~/components/features/Navbar';
import { Footer } from '~/components/features/Footer';
import { Phase2Gate } from '~/components/Phase2Gate';
import { Spinner } from '~/components/ui/Spinner';
import { CashbackCalculator } from '~/components/features/cashback/CashbackCalculator';
import i18n from '~/i18n/i18next';

/**
 * `/calculator` — standalone pre-signup cashback calculator
 * (ADR 020). Visitor-side marketing funnel: pick a merchant from a
 * dropdown, type an amount, see projected cashback. Complements the
 * per-merchant `/cashback/:slug` calculator (#741) — this route is
 * the discovery path for visitors who haven't landed on a specific
 * merchant page yet.
 *
 * Merchant list sourced from `/api/public/top-cashback-merchants`
 * (ADR 020 Tier-1) — the same never-500 / cached list that powers
 * the home-page "best cashback" tiles, so the dropdown is always
 * populated with real merchants even on a fresh deployment.
 *
 * Mounted full-width with the regular Navbar + Footer. The calc
 * card (#741) self-contains input state and the debounced preview
 * fetch, so this route just orchestrates merchant selection.
 */

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [
    { title: i18n.t('cashback:calculator.meta.title') },
    {
      name: 'description',
      content: i18n.t('cashback:calculator.meta.description'),
    },
    { tagName: 'link', rel: 'canonical', href: canonicalHref(params, '/calculator') },
  ];
}

export default function CalculatorRoute(): React.JSX.Element {
  return (
    <Phase2Gate>
      <CalculatorRouteBody />
    </Phase2Gate>
  );
}

function CalculatorRouteBody(): React.JSX.Element {
  const { t } = useTranslation('cashback');
  // CAT-02 (2026-06-30 cold audit): this route was the last of three
  // country-blind catalog surfaces — the dropdown showed every
  // merchant globally regardless of the visitor's locale, unlike
  // home.tsx / brand.$slug.tsx.
  const { country } = useLocale();
  const query = useQuery({
    queryKey: ['public-top-cashback-merchants', 50, country],
    queryFn: () => getPublicTopCashbackMerchants({ limit: 50, country }),
    retry: shouldRetry,
    staleTime: 5 * 60 * 1000,
  });

  const merchants = query.data?.merchants ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const active =
    selectedId !== null ? merchants.find((m) => m.id === selectedId) : (merchants[0] ?? null);

  return (
    <>
      <Navbar />
      {/* UX-03 (docs/ux-pass-2026-07-09.md, bundled into U-3): the H1
          below used to render with its top ~15px clipped under the
          fixed Navbar on load. `pt-20` clears it — same offset
          brand.$slug.tsx uses for the same fixed-Navbar overlap. */}
      <main className="container mx-auto max-w-3xl px-4 pb-12 pt-20">
        <header className="text-center">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-3">
            {t('calculator.heading')}
          </h1>
          <p className="text-lg text-gray-600 dark:text-gray-400 mb-10">{t('calculator.sub')}</p>
        </header>

        {query.isPending ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : merchants.length === 0 ? (
          <p className="text-center text-gray-600 dark:text-gray-400">
            {t('calculator.noMerchants')}
          </p>
        ) : (
          <section className="space-y-6">
            <MerchantPicker
              merchants={merchants}
              selectedId={active?.id ?? null}
              onSelect={setSelectedId}
            />
            {active !== null && active !== undefined ? (
              <CashbackCalculator merchantId={active.id} />
            ) : null}
            {/* Conversion CTA — visitors who've typed an amount and
                seen a concrete cashback number are warm leads. Match
                the copy/style on /cashback/:slug so a visitor
                bouncing between calculator + merchant pages gets a
                consistent call-to-action. */}
            <div className="text-center pt-2">
              <Link
                to="/auth"
                className="inline-block rounded-lg bg-blue-600 px-6 py-3 text-base font-semibold text-white hover:bg-blue-700"
              >
                {t('calculator.cta')}
              </Link>
            </div>
          </section>
        )}
      </main>
      <Footer />
    </>
  );
}

function MerchantPicker({
  merchants,
  selectedId,
  onSelect,
}: {
  merchants: TopCashbackMerchant[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation('cashback');
  return (
    <label className="flex flex-col gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
      {t('calculator.merchantPicker.label')}
      <select
        value={selectedId ?? ''}
        onChange={(e) => onSelect(e.target.value)}
        aria-label={t('calculator.merchantPicker.ariaLabel')}
        className="w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-base text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
      >
        {merchants.map((m) => (
          <option key={m.id} value={m.id}>
            {t('calculator.merchantPicker.option', {
              name: m.name,
              pct: Number(m.userCashbackPct).toFixed(2).replace(/\.0+$/, ''),
            })}
          </option>
        ))}
      </select>
    </label>
  );
}
