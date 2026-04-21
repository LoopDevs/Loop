import { useEffect, useState } from 'react';

/**
 * Six-position dot progress indicator shown at the top of the
 * onboarding screens. Active dot widens; done dots are a darker
 * shade of the resting tone. Dark variant is driven by `html.dark`
 * via Tailwind so no prop is needed.
 */
export function Dots({ active, total }: { active: number; total: number }): React.JSX.Element {
  return (
    <div className="flex justify-center gap-1.5 pt-3 pb-1">
      {Array.from({ length: total }, (_, i) => {
        const state = i === active ? 'active' : i < active ? 'done' : 'idle';
        const base =
          'h-1.5 rounded-full transition-all duration-[280ms] ease-[cubic-bezier(0.4,0,0.2,1)]';
        const width = state === 'active' ? 'w-[22px]' : 'w-1.5';
        const color =
          state === 'active'
            ? 'bg-gray-950 dark:bg-white'
            : state === 'done'
              ? 'bg-black/35 dark:bg-white/45'
              : 'bg-black/15 dark:bg-white/20';
        return <div key={i} className={`${base} ${width} ${color}`} />;
      })}
    </div>
  );
}

interface MerchantTileData {
  name: string;
  pct: string;
  logoUrl?: string | undefined;
}

/**
 * Square rounded tile with a merchant logo and a savings pill below.
 * Falls back to the merchant's initial when the logo URL is missing
 * or fails — onboarding is illustrative, and a mostly-full grid
 * reads better than blanks when one logo 404s.
 */
export function MerchantTile({
  m,
  size = 54,
}: {
  m: MerchantTileData;
  size?: number;
}): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  const showLogo = m.logoUrl !== undefined && !failed;
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        className="flex items-center justify-center rounded-[14px] bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-[0_1px_3px_rgba(0,0,0,0.08),0_4px_12px_rgba(0,0,0,0.06)] dark:shadow-none overflow-hidden"
        style={{ width: size, height: size, padding: size * 0.22 }}
      >
        {showLogo ? (
          <img
            src={m.logoUrl}
            alt={m.name}
            className="w-full h-full object-contain"
            onError={() => setFailed(true)}
          />
        ) : (
          <span className="text-sm font-bold text-gray-700 dark:text-gray-200">
            {m.name.charAt(0)}
          </span>
        )}
      </div>
      <div className="text-[10px] font-semibold text-green-700 dark:text-green-400 bg-green-100 dark:bg-green-900/30 px-1.5 py-0.5 rounded-full">
        {m.pct}
      </div>
    </div>
  );
}

/**
 * Animated number tweened from 0 to `target` with a cubic ease-out
 * over `duration` ms. Re-runs whenever `active` becomes true — the
 * Welcome screen uses this to replay the savings counter every time
 * the user lands back on step 1.
 */
export function useCountUp(target: number, active: boolean, duration = 1400): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!active) {
      setV(0);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number): void => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setV(target * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, target, duration]);
  return v;
}
