import { useEffect, useRef, useState } from 'react';

import { REGIONS, regionByCode } from '@loop/shared';

import { useRegionStore } from '~/stores/region.store';

/**
 * Top-right navbar control to pick the region (US / CA / UK / EUR). The first guess comes
 * from IP geolocation (seeded by {@link useRegionStore.hydrate}); the user can override it,
 * which persists. Drives the home merchant filter + price-display currency.
 */
export function RegionSelector(): React.JSX.Element {
  const region = useRegionStore((s) => s.region);
  const setRegion = useRegionStore((s) => s.setRegion);
  const hydrate = useRegionStore((s) => s.hydrate);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = regionByCode(region);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Region: ${current.label}`}
        className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-2 text-sm font-medium text-ink transition-colors hover:bg-gray-50"
      >
        <span aria-hidden className="text-base leading-none">
          {current.flag}
        </span>
        <span className="hidden sm:inline">{current.code}</span>
        <svg
          aria-hidden
          viewBox="0 0 12 12"
          className={`h-3 w-3 text-ink-muted transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M3 4.5 6 7.5 9 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <ul
          role="listbox"
          aria-label="Select region"
          className="absolute right-0 z-[1200] mt-1.5 w-48 overflow-hidden rounded-md border border-gray-200 bg-white py-1 shadow-lg"
        >
          {REGIONS.map((r) => {
            const selected = r.code === region;
            return (
              <li key={r.code}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    setRegion(r.code);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-gray-50 ${
                    selected ? 'font-semibold text-blue-600' : 'text-ink'
                  }`}
                >
                  <span aria-hidden className="text-base leading-none">
                    {r.flag}
                  </span>
                  <span className="flex-1">{r.label}</span>
                  <span className="text-xs text-ink-muted">{r.currency}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
