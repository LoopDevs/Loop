import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAllMerchants } from '~/hooks/use-merchants';
import { getImageProxyUrl } from '~/utils/image';
import { LoopLogo } from '~/components/ui/LoopLogo';
import { MerchantTile, useCountUp } from './atoms';

interface ScreenCopy {
  eyebrow?: string;
  title: string;
  sub: string;
}

interface ScreenProps {
  active: boolean;
  copy: ScreenCopy;
}

interface TrustWelcomeProps extends ScreenProps {
  /**
   * U-2 / UX-01 (docs/ux-pass-2026-07-09.md): the receipt-card below
   * is hardcoded UI, not sourced from `copy`, so it needs its own
   * phase switch — swaps the "Total cashback" label for "Total
   * saved" so the card doesn't promise a Phase-2 feature. Optional /
   * defaults to Phase-2 framing so existing callers (if any are
   * added later) don't silently regress.
   */
  phase1Only?: boolean;
}

/**
 * Screen 1 — brand moment. Loop wordmark, a receipt-card with an
 * animated "total cashback" counter that re-ticks every time the
 * screen becomes active, then the headline + sub.
 */
export function TrustWelcome({
  active,
  copy,
  phase1Only = false,
}: TrustWelcomeProps): React.JSX.Element {
  const { t } = useTranslation('onboarding');
  const savings = useCountUp(2847, active, 1600);
  const [dollars, cents] = savings.toFixed(2).split('.');
  const totalLabel = phase1Only ? t('trust.totalSaved') : t('trust.totalCashback');
  return (
    <div className="flex-1 flex flex-col px-6">
      <div className="flex-1 flex flex-col items-center justify-center gap-6">
        {/* Loop wordmark — inline vector so it stays crisp at any DPI. */}
        <LoopLogo className="h-10 w-auto text-ink" />

        <div className="w-full max-w-[280px] rounded-[18px] p-5 bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-[0_2px_10px_rgba(0,0,0,0.04),0_20px_40px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_10px_rgba(0,0,0,0.20),0_20px_40px_rgba(0,0,0,0.30)]">
          <div className="text-[11px] uppercase tracking-[0.08em] font-semibold text-gray-500 dark:text-gray-400 mb-2">
            {totalLabel}
          </div>
          <div
            className="text-[44px] font-extrabold text-gray-950 dark:text-white leading-none"
            style={{ letterSpacing: '-0.035em', fontVariantNumeric: 'tabular-nums' }}
          >
            ${dollars}
            <span className="text-[28px] font-bold text-gray-400 dark:text-gray-500">.{cents}</span>
          </div>
          <div className="mt-3.5 pt-3.5 border-t border-dashed border-gray-200 dark:border-gray-700 flex justify-between text-[13px] text-gray-600 dark:text-gray-300">
            <span>{t('trust.thisYearSoFar')}</span>
            <span className="font-semibold text-green-700 dark:text-green-400">+$2,847</span>
          </div>
        </div>

        <div className="text-center pt-2">
          <h1
            className="text-[40px] font-bold leading-[1.02] text-gray-950 dark:text-white whitespace-pre-line"
            style={{ letterSpacing: '-0.035em', textWrap: 'balance' }}
          >
            {copy.title}
          </h1>
          <p
            className="text-[16px] leading-[1.45] text-gray-600 dark:text-gray-300 mt-3"
            style={{ textWrap: 'pretty' }}
          >
            {copy.sub}
          </p>
        </div>
      </div>
    </div>
  );
}

type StepVisual = 'app' | 'card' | 'bank';

function TrustStepVisual({ visual }: { visual: StepVisual }): React.JSX.Element {
  if (visual === 'app') {
    return (
      <div className="w-[52px] h-[52px] rounded-xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
        <div className="w-6 h-6 rounded-[7px] bg-gray-950 dark:bg-white text-white dark:text-gray-950 text-[13px] font-extrabold flex items-center justify-center">
          L
        </div>
      </div>
    );
  }
  if (visual === 'card') {
    return (
      <div
        className="relative overflow-hidden rounded-md"
        style={{
          width: 52,
          height: 36,
          padding: 5,
          background: 'linear-gradient(135deg, #3b82f6, #2563eb)',
        }}
      >
        <div
          className="rounded-[1px]"
          style={{ width: 8, height: 6, background: '#E5B041', marginBottom: 3 }}
        />
        <div
          className="text-white"
          style={{
            fontSize: 5,
            letterSpacing: 0.2,
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          }}
        >
          •••• 4271
        </div>
      </div>
    );
  }
  return (
    <div className="w-[52px] h-[52px] rounded-xl bg-green-50 dark:bg-green-900/30 flex items-center justify-center">
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
        <path d="M3 9l8-5 8 5v9H3V9z" stroke="#15803d" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M8 18v-4h6v4" stroke="#15803d" strokeWidth="1.8" />
      </svg>
    </div>
  );
}

interface TrustHowItWorksProps extends ScreenProps {
  /**
   * U-2 / UX-01 (docs/ux-pass-2026-07-09.md): step 3's label below is
   * hardcoded UI, not sourced from `copy` — "Cashback lands in your
   * bank" is a Phase-2 settlement claim (Loop doesn't do bank
   * transfers in Phase 1). Swaps to the discount-at-checkout framing
   * when set. Optional / defaults to Phase-2 framing so existing
   * callers (if any are added later) don't silently regress.
   */
  phase1Only?: boolean;
}

/**
 * Screen 2 — three-step explainer. Each step card fades+slides in
 * with a staggered delay when the screen becomes active.
 */
export function TrustHowItWorks({
  active,
  copy,
  phase1Only = false,
}: TrustHowItWorksProps): React.JSX.Element {
  const { t } = useTranslation('onboarding');
  const steps: { num: string; label: string; visual: StepVisual }[] = [
    { num: '1', label: t('trust.step1'), visual: 'app' },
    { num: '2', label: t('trust.step2'), visual: 'card' },
    {
      num: '3',
      label: phase1Only ? t('trust.step3Phase1') : t('trust.step3Phase2'),
      visual: 'bank',
    },
  ];
  return (
    <div className="flex-1 flex flex-col justify-center gap-6 px-6 overflow-hidden py-6">
      <div>
        <div className="text-xs font-semibold uppercase tracking-[0.04em] text-gray-500 dark:text-gray-400 mb-3">
          {copy.eyebrow}
        </div>
        <h1
          className="text-[32px] font-bold leading-[1.1] text-gray-950 dark:text-white mb-3"
          style={{ letterSpacing: '-0.02em', textWrap: 'balance' }}
        >
          {copy.title}
        </h1>
        <p
          className="text-[16px] leading-[1.45] text-gray-600 dark:text-gray-300 mb-6"
          style={{ textWrap: 'pretty' }}
        >
          {copy.sub}
        </p>
      </div>
      <div className="flex flex-col gap-3.5 overflow-auto">
        {steps.map((s, i) => (
          <div
            key={s.num}
            className="flex items-center gap-3.5 rounded-2xl p-4 bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800"
            style={{
              opacity: active ? 1 : 0,
              transform: active ? 'translateY(0)' : 'translateY(12px)',
              transition: `opacity 420ms ease ${i * 100 + 100}ms, transform 420ms cubic-bezier(0.4,0,0.2,1) ${i * 100 + 100}ms`,
            }}
          >
            <div className="w-9 h-9 rounded-[10px] bg-gray-950 dark:bg-white text-white dark:text-gray-950 text-base font-bold flex items-center justify-center flex-shrink-0">
              {s.num}
            </div>
            <div className="flex-1 text-[15px] font-medium text-gray-900 dark:text-white leading-tight">
              {s.label}
            </div>
            <TrustStepVisual visual={s.visual} />
          </div>
        ))}
      </div>
    </div>
  );
}

interface TileMerchant {
  name: string;
  pct: string;
  logoUrl?: string | undefined;
}

/**
 * Screen 3 — "brands you'll actually use". Pulls the first 12
 * enabled merchants from the catalog (served out of the app's
 * localStorage-seeded cache on cold start, so this renders with
 * data instantly). Falls back to a small hardcoded set if the
 * catalog hasn't loaded yet, so the grid always reads as populated.
 */
export function TrustMerchants({ active, copy }: ScreenProps): React.JSX.Element {
  const { t } = useTranslation('onboarding');
  const { merchants } = useAllMerchants();

  const tiles = useMemo<TileMerchant[]>(() => {
    const fallback: TileMerchant[] = [
      { name: 'Amazon', pct: '4%' },
      { name: 'Target', pct: '3%' },
      { name: 'Starbucks', pct: '5%' },
      { name: 'Uber', pct: '6%' },
      { name: 'Walmart', pct: '3%' },
      { name: 'DoorDash', pct: '7%' },
      { name: 'Costco', pct: '4%' },
      { name: 'Best Buy', pct: '3%' },
      { name: 'CVS', pct: '5%' },
      { name: 'Nike', pct: '4%' },
      { name: 'Home Depot', pct: '4%' },
      { name: 'Kroger', pct: '5%' },
    ];
    // Prefer real merchants from the catalog so the grid shows what
    // Loop actually supports. Sort by savings desc so the highest
    // savings anchor the first row — matches how the grid reads in
    // the design mockup (bigger percentages up top).
    if (merchants.length === 0) return fallback;
    return merchants
      .filter((m) => m.enabled !== false && m.logoUrl !== undefined)
      .slice()
      .sort((a, b) => (b.savingsPercentage ?? 0) - (a.savingsPercentage ?? 0))
      .slice(0, 12)
      .map((m) => ({
        name: m.name,
        pct: `${(m.savingsPercentage ?? 0).toFixed(0)}%`,
        logoUrl: m.logoUrl !== undefined ? getImageProxyUrl(m.logoUrl, 128) : undefined,
      }));
  }, [merchants]);

  return (
    <div className="flex-1 flex flex-col justify-center gap-6 px-6 overflow-hidden py-6">
      <div>
        <div className="text-xs font-semibold uppercase tracking-[0.04em] text-gray-500 dark:text-gray-400 mb-3">
          {copy.eyebrow}
        </div>
        <h1
          className="text-[32px] font-bold leading-[1.1] text-gray-950 dark:text-white mb-3"
          style={{ letterSpacing: '-0.02em', textWrap: 'balance' }}
        >
          {copy.title}
        </h1>
        <p
          className="text-[16px] leading-[1.45] text-gray-600 dark:text-gray-300 mb-6"
          style={{ textWrap: 'pretty' }}
        >
          {copy.sub}
        </p>
      </div>
      <div className="grid grid-cols-4 gap-x-[18px] gap-y-5 content-start">
        {tiles.map((m, i) => (
          <div
            key={m.name}
            style={{
              opacity: active ? 1 : 0,
              transform: active ? 'scale(1)' : 'scale(0.85)',
              transition: `opacity 320ms ease ${i * 40}ms, transform 420ms cubic-bezier(0.34,1.56,0.64,1) ${i * 40}ms`,
            }}
          >
            <MerchantTile m={m} size={54} />
          </div>
        ))}
      </div>
      <div className="text-center text-xs text-gray-500 dark:text-gray-400">
        {t('trust.moreBrands')}
      </div>
    </div>
  );
}
