// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { Merchant } from '@loop/shared';
import Home from '~/routes/home';

/**
 * FE-25-DESKTOP-GRID: the desktop "All merchants" directory grid in
 * routes/home.tsx used to `.map` the full brand catalog (~1,134 listings → ~982
 * groups, ADR 032) into the DOM at once — the same un-windowed hit FE-25 fixed
 * on MobileHome, but on desktop web. This proves the desktop grid is now
 * windowed (only viewport-adjacent cells mounted) via the shared useWindowedGrid
 * hook, with a spacer reserving the scroll height of the un-mounted rows so every
 * group stays reachable by scrolling.
 *
 * jsdom has no real layout (getBoundingClientRect → 0), so the hook falls back to
 * the estimated desktop row pitch + the default jsdom viewport; the exact
 * windowing math (incl. the desktop 3/4-column counts) is asserted directly
 * against `computeGridWindow` in use-windowed-grid.test.ts. Mock shape mirrors
 * MobileHome.virtualization.test.tsx.
 */

afterEach(cleanup);

// 1,000 uniquely-named, enabled merchants. Unique names => groupMerchants keeps
// each as its own (isGroup:false) cell — ADR 032 only collapses "Brand -
// Variant" listings — so the directory would map 1,000 MerchantCards if it were
// not windowed.
const LARGE_CATALOG: Merchant[] = Array.from({ length: 1000 }, (_, i) => ({
  id: `m-${i}`,
  name: `Brand ${String(i).padStart(4, '0')}`,
  enabled: true,
  savingsPercentage: 1,
}));

vi.mock('~/hooks/use-merchants', () => ({
  useAllMerchants: () => ({ merchants: LARGE_CATALOG, isLoading: false, isError: false }),
  useMerchantsCashbackRatesMap: () => ({ lookup: () => null }),
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

// FavoriteToggleButton (inside each MerchantCard) calls these unconditionally,
// before its unauth early-return, so they must resolve even signed-out.
vi.mock('~/hooks/use-favorites', () => ({
  useFavorites: () => ({ favoritedIds: new Set<string>(), isLoading: false }),
  useToggleFavorite: () => ({ mutate: vi.fn(), isPending: false }),
}));

// Chrome around the directory — not under test; stub to keep the tree light and
// off these components' own data deps.
vi.mock('~/components/features/Navbar', () => ({ Navbar: () => null }));
vi.mock('~/components/features/Footer', () => ({ Footer: () => null }));
vi.mock('~/components/features/FavoritesStrip', () => ({ FavoritesStrip: () => null }));
vi.mock('~/components/features/RecentlyPurchasedStrip', () => ({
  RecentlyPurchasedStrip: () => null,
}));
// The mobile dashboard renders in the same tree (hidden by CSS, which jsdom
// doesn't apply); stub it so this test isolates the desktop directory grid and
// skips MobileHome's data deps.
vi.mock('~/components/features/home/MobileHome', () => ({ MobileHome: () => null }));

function renderHome(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function waitForDirectory(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const el = container.querySelector('#directory');
    if (el === null || el.querySelector('[data-index]') === null) {
      throw new Error('directory grid not populated');
    }
    return el as HTMLElement;
  });
}

describe('desktop "All merchants" directory grid windowing (FE-25-DESKTOP-GRID)', () => {
  it('mounts only a bounded window of cells for a 1,000-group catalog, not all of them', async () => {
    const { container } = renderHome();
    const directory = await waitForDirectory(container);
    // Each MerchantCard/MerchantGroupCard root carries data-index; spacers are
    // aria-hidden divs with no data-index, so this counts mounted cards directly.
    // Scoped to #directory so the (separate) featured strip's cards aren't counted.
    const mountedCells = directory.querySelectorAll('[data-index]').length;
    // Un-windowed this is exactly 1,000. Windowed it must be a small fraction —
    // roughly the jsdom viewport worth of rows plus overscan. Cap generously so
    // the assertion is "windowed, not all-mounted", not a brittle node count.
    expect(mountedCells).toBeGreaterThan(0);
    expect(mountedCells).toBeLessThan(200);
    expect(mountedCells).toBeLessThan(LARGE_CATALOG.length);
  });

  it('reserves the scroll height of the un-mounted rows with a spacer (rest reachable by scrolling)', async () => {
    const { container } = renderHome();
    const directory = await waitForDirectory(container);
    // A windowed grid at the top of a long list mounts a bottom spacer reserving
    // the height of every row below the window — proof the remaining ~950+ groups
    // are un-mounted while their scroll position is preserved. An un-windowed grid
    // has no such spacer, so its max reserved height would be 0.
    const spacers = Array.from(
      directory.querySelectorAll('div[aria-hidden="true"]'),
    ) as HTMLElement[];
    const reservedHeight = spacers.reduce((max, el) => {
      const h = Number.parseFloat(el.style.height);
      return Number.isFinite(h) && h > max ? h : max;
    }, 0);
    expect(reservedHeight).toBeGreaterThan(0);
  });
});
