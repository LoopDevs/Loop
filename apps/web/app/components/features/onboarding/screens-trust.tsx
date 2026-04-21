import { useMemo } from 'react';
import { useAllMerchants } from '~/hooks/use-merchants';
import { getImageProxyUrl } from '~/utils/image';
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

/**
 * Screen 1 — brand moment. Loop wordmark, a receipt-card with an
 * animated "total cashback" counter that re-ticks every time the
 * screen becomes active, then the headline + sub.
 */
export function TrustWelcome({ active, copy }: ScreenProps): React.JSX.Element {
  const savings = useCountUp(2847, active, 1600);
  const [dollars, cents] = savings.toFixed(2).split('.');
  return (
    <div className="flex-1 flex flex-col px-6">
      <div className="flex-1 flex flex-col items-center justify-center gap-6">
        {/* Loop wordmark — real logo asset, theme-swapped. Dark logo
            on light bg, white logo on dark bg. Matches the height of
            the text wordmark in the original design (~40px). */}
        <img src="/loop-logo.svg" alt="Loop" className="h-10 dark:hidden" />
        <img src="/loop-logo-white.svg" alt="Loop" className="h-10 hidden dark:block" />

        <div className="w-full max-w-[280px] rounded-[18px] p-5 bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-[0_2px_10px_rgba(0,0,0,0.04),0_20px_40px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_10px_rgba(0,0,0,0.20),0_20px_40px_rgba(0,0,0,0.30)]">
          <div className="text-[11px] uppercase tracking-[0.08em] font-semibold text-gray-500 dark:text-gray-400 mb-2">
            Total cashback
          </div>
          <div
            className="text-[44px] font-extrabold text-gray-950 dark:text-white leading-none"
            style={{ letterSpacing: '-0.035em', fontVariantNumeric: 'tabular-nums' }}
          >
            ${dollars}
            <span className="text-[28px] font-bold text-gray-400 dark:text-gray-500">.{cents}</span>
          </div>
          <div className="mt-3.5 pt-3.5 border-t border-dashed border-gray-200 dark:border-gray-700 flex justify-between text-[13px] text-gray-600 dark:text-gray-300">
            <span>This year so far</span>
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

/**
 * Screen 2 — three-step explainer. Each step card fades+slides in
 * with a staggered delay when the screen becomes active.
 */
export function TrustHowItWorks({ active, copy }: ScreenProps): React.JSX.Element {
  const steps: { num: string; label: string; visual: StepVisual }[] = [
    { num: '1', label: 'Open Loop before you shop', visual: 'app' },
    { num: '2', label: 'Buy a gift card at the store', visual: 'card' },
    { num: '3', label: 'Cashback lands in your bank', visual: 'bank' },
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
      <div className="text-center text-xs text-gray-500 dark:text-gray-400">+ 500 more brands</div>
    </div>
  );
}
