// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { Merchant } from '@loop/shared';
import { MobileHome, computeGridWindow } from '../MobileHome';

/**
 * FE-25 (PRF): the directory grid used to `.map` the full brand catalog
 * (~1,134 listings → ~982 groups, ADR 032) into the DOM at once. This proves
 * the grid is now windowed — only viewport-adjacent cells are mounted — while
 * the full count is still reported and every item stays reachable.
 *
 * jsdom has no real layout (getBoundingClientRect → 0), so the component wiring
 * falls back to the estimated row pitch and the default jsdom viewport; the
 * exact windowing math is asserted directly against the pure
 * `computeGridWindow`. Mock shape mirrors MobileHome.search.test.tsx.
 */

afterEach(cleanup);

// 1,000 uniquely-named, enabled merchants. Unique names => groupMerchants
// keeps each as its own (isGroup:false) cell — ADR 032 only collapses
// "Brand - Variant" listings — so the grid would map 1,000 DirectoryCells
// (one <a> each) if it were not windowed.
const LARGE_CATALOG: Merchant[] = Array.from({ length: 1000 }, (_, i) => ({
  id: `m-${i}`,
  name: `Brand ${String(i).padStart(4, '0')}`,
  enabled: true,
  savingsPercentage: 1,
}));

vi.mock('~/hooks/use-merchants', () => ({
  useAllMerchants: () => ({ merchants: LARGE_CATALOG, isLoading: false, isError: false }),
  useMerchantSearch: (_query: string, options: { enabled?: boolean } = {}) => {
    void options;
    return { merchants: [], isLoading: false, isFetching: false, isError: false, error: null };
  },
  useMerchantsCashbackRatesMap: () => ({ lookup: () => null }),
}));

vi.mock('~/hooks/use-orders', () => ({
  useOrders: () => ({ orders: [], isLoading: false, isError: false }),
}));

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: false, email: null }),
}));

vi.mock('~/hooks/use-app-config', () => ({
  useAppConfig: () => ({ config: { phase1Only: true }, isLoading: false }),
}));

vi.mock('~/hooks/use-native-platform', () => ({
  useNativePlatform: () => ({ isNative: false, platform: 'web' }),
}));

vi.mock('~/services/user', () => ({
  getCashbackSummary: vi.fn().mockRejectedValue(new Error('not authenticated')),
}));

vi.mock('~/components/features/wallet/WalletCard', () => ({ WalletCard: () => null }));
vi.mock('~/components/features/FavoritesStrip', () => ({ FavoritesStrip: () => null }));
vi.mock('~/components/features/RecentlyPurchasedStrip', () => ({
  RecentlyPurchasedStrip: () => null,
}));

function renderHome(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MobileHome />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<MobileHome /> directory grid windowing (FE-25)', () => {
  it('mounts only a bounded window of cells for a 1,000-item catalog, not all of them', async () => {
    const { container } = renderHome();
    const grid = await waitFor(() => {
      const el = container.querySelector('#mobile-home-grid');
      if (el === null || el.querySelector('a') === null) throw new Error('grid not ready');
      return el;
    });
    // The only <a> elements inside #mobile-home-grid are directory cells
    // (spacers are aria-hidden divs), so this counts mounted cards directly.
    const mountedCells = grid.querySelectorAll('a').length;
    // Un-windowed this is exactly 1,000. Windowed it must be a small fraction —
    // roughly the jsdom viewport (768px) worth of rows plus overscan. Cap
    // generously so the assertion is "windowed, not all-mounted", not a brittle
    // exact node count.
    expect(mountedCells).toBeGreaterThan(0);
    expect(mountedCells).toBeLessThan(120);
    expect(mountedCells).toBeLessThan(LARGE_CATALOG.length);
  });

  it('still reports the full catalog count in the section meta (all items exposed)', async () => {
    const { container, getByText } = renderHome();
    await waitFor(() => {
      if (container.querySelector('#mobile-home-grid a') === null) {
        throw new Error('grid not ready');
      }
    });
    // section.resultsMeta renders the full grouped length regardless of how
    // many cells are actually mounted.
    expect(getByText(/1[,.\s]?000 brands/)).toBeDefined();
  });
});

describe('computeGridWindow (FE-25 windowing math)', () => {
  const base = {
    itemCount: 1000,
    columns: 2,
    rowHeight: 120,
    viewportHeight: 800,
    overscanRows: 4,
  };

  it('mounts only a viewport-sized slice at the top of the list', () => {
    const w = computeGridWindow({ ...base, scrolledPastTop: 0 });
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBeLessThan(base.itemCount);
    expect(w.topPad).toBe(0);
    expect(w.bottomPad).toBeGreaterThan(0);
  });

  it('advances the window as the grid scrolls above the viewport', () => {
    const top = computeGridWindow({ ...base, scrolledPastTop: 0 });
    const mid = computeGridWindow({ ...base, scrolledPastTop: 12000 });
    expect(mid.startIndex).toBeGreaterThan(top.startIndex);
    expect(mid.topPad).toBeGreaterThan(0);
    expect(mid.bottomPad).toBeGreaterThan(0);
  });

  it('reaches the end of the list when fully scrolled', () => {
    const w = computeGridWindow({ ...base, scrolledPastTop: 1_000_000 });
    expect(w.endIndex).toBe(base.itemCount);
    expect(w.bottomPad).toBe(0);
  });

  it('exposes every item across the full scroll range (no gaps)', () => {
    const totalRows = Math.ceil(base.itemCount / base.columns);
    const covered = new Set<number>();
    for (let row = 0; row <= totalRows; row++) {
      const w = computeGridWindow({ ...base, scrolledPastTop: row * base.rowHeight });
      for (let i = w.startIndex; i < w.endIndex; i++) covered.add(i);
    }
    expect(covered.size).toBe(base.itemCount);
  });

  it('mounts everything with no spacers for a small list', () => {
    const w = computeGridWindow({ ...base, itemCount: 8, scrolledPastTop: 0 });
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(8);
    expect(w.topPad).toBe(0);
    expect(w.bottomPad).toBe(0);
  });

  it('never mounts more than a bounded window regardless of dataset size', () => {
    const w = computeGridWindow({ ...base, itemCount: 100000, scrolledPastTop: 0 });
    // A ~150k-item catalog still mounts only ~viewport+overscan rows.
    expect(w.endIndex - w.startIndex).toBeLessThan(60);
  });
});
