// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router';
import type * as PublicStats from '~/services/public-stats';
import CashbackIndexRoute from '../cashback';

vi.mock('~/components/features/Navbar', () => ({ Navbar: () => null }));
vi.mock('~/components/features/Footer', () => ({ Footer: () => null }));
vi.mock('~/hooks/use-native-platform', () => ({ useNativePlatform: () => ({ isNative: false }) }));
// Phase2Gate wraps this route — force phase1Only=false so the body
// actually renders (this fix is orthogonal to CF2-08's phase gating).
vi.mock('~/hooks/use-app-config', () => ({
  useAppConfig: () => ({ config: { phase1Only: false }, isLoading: false }),
}));

afterEach(cleanup);

const { mocks } = vi.hoisted(() => ({
  mocks: { getPublicTopCashbackMerchants: vi.fn() },
}));

vi.mock('~/services/public-stats', async (importActual) => {
  const actual = (await importActual()) as typeof PublicStats;
  return {
    ...actual,
    getPublicTopCashbackMerchants: (opts?: { limit?: number; country?: string }) =>
      mocks.getPublicTopCashbackMerchants(opts),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderRoute(path = '/cashback'): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/cashback" element={<CashbackIndexRoute />} />
          <Route path="/:country/:lang/cashback" element={<CashbackIndexRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<CashbackIndexRoute />', () => {
  // CAT-02 (2026-06-30 cold audit): this route was one of three
  // country-blind catalog surfaces — the index listed every merchant
  // globally regardless of the visitor's locale.
  it('passes the URL country segment through to the top-merchants request', async () => {
    mocks.getPublicTopCashbackMerchants.mockResolvedValue({
      merchants: [],
      asOf: new Date().toISOString(),
    });
    renderRoute('/gb/en/cashback');
    await waitFor(() => {
      expect(mocks.getPublicTopCashbackMerchants).toHaveBeenCalledWith(
        expect.objectContaining({ country: 'gb' }),
      );
    });
  });

  it('defaults to the fallback market on an unprefixed route', async () => {
    mocks.getPublicTopCashbackMerchants.mockResolvedValue({
      merchants: [],
      asOf: new Date().toISOString(),
    });
    renderRoute('/cashback');
    await waitFor(() => {
      expect(mocks.getPublicTopCashbackMerchants).toHaveBeenCalledWith(
        expect.objectContaining({ country: 'us' }),
      );
    });
  });

  it('renders a merchant row from the response', async () => {
    mocks.getPublicTopCashbackMerchants.mockResolvedValue({
      merchants: [
        {
          id: 'm-1',
          name: 'Argos',
          slug: 'argos',
          logoUrl: null,
          userCashbackPct: '5.50',
        },
      ],
      asOf: new Date().toISOString(),
    });
    renderRoute();
    await waitFor(() => {
      expect(screen.getByText('Argos')).toBeDefined();
    });
  });
});
