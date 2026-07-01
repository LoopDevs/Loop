// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router';
import { ApiException } from '@loop/shared';
import type * as PublicStats from '~/services/public-stats';
import CashbackMerchantLanding from '../cashback.$slug';

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
  mocks: {
    getPublicMerchant: vi.fn(),
    getPublicCashbackPreview: vi.fn(),
  },
}));

vi.mock('~/services/public-stats', async (importActual) => {
  const actual = (await importActual()) as typeof PublicStats;
  return {
    ...actual,
    getPublicMerchant: (idOrSlug: string, opts?: { country?: string }) =>
      mocks.getPublicMerchant(idOrSlug, opts),
    getPublicCashbackPreview: (args: { merchantId: string; amountMinor: number }) =>
      mocks.getPublicCashbackPreview(args),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderRoute(path: string): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/cashback/:slug" element={<CashbackMerchantLanding />} />
          <Route path="/:country/:lang/cashback/:slug" element={<CashbackMerchantLanding />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<CashbackMerchantLanding />', () => {
  // CAT-02 (2026-06-30 cold audit): this route was one of three
  // country-blind catalog surfaces — /cashback/:slug resolved any
  // slug regardless of the visitor's country.
  it('passes the URL country segment through to the merchant lookup', async () => {
    mocks.getPublicMerchant.mockResolvedValue({
      id: 'm-1',
      name: 'Argos',
      slug: 'argos',
      logoUrl: null,
      userCashbackPct: '5.50',
      asOf: new Date().toISOString(),
    });
    renderRoute('/gb/en/cashback/argos');
    await waitFor(() => {
      expect(mocks.getPublicMerchant).toHaveBeenCalledWith('argos', { country: 'gb' });
    });
  });

  it('defaults to the fallback market on an unprefixed route', async () => {
    mocks.getPublicMerchant.mockResolvedValue({
      id: 'm-1',
      name: 'Argos',
      slug: 'argos',
      logoUrl: null,
      userCashbackPct: '5.50',
      asOf: new Date().toISOString(),
    });
    renderRoute('/cashback/argos');
    await waitFor(() => {
      expect(mocks.getPublicMerchant).toHaveBeenCalledWith('argos', { country: 'us' });
    });
  });

  it('renders a not-found state for a 404 (e.g. country-filtered-out merchant)', async () => {
    mocks.getPublicMerchant.mockRejectedValue(
      new ApiException(404, { code: 'NOT_FOUND', message: 'not found' }),
    );
    renderRoute('/cashback/argos');
    await waitFor(() => {
      expect(screen.getByText(/isn.t on Loop/i)).toBeDefined();
    });
  });
});
