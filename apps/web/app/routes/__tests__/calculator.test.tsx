// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router';
import type * as PublicStats from '~/services/public-stats';
import CalculatorRoute from '../calculator';

// Navbar + Footer read the ui.store at mount, which touches matchMedia
// (unavailable in jsdom). Neither is what this route test is about, so
// stub both to null renders.
vi.mock('~/components/features/Navbar', () => ({ Navbar: () => null }));
vi.mock('~/components/features/Footer', () => ({ Footer: () => null }));

afterEach(() => {
  cleanup();
  mocks.phase1Only = false;
});

const { mocks } = vi.hoisted(() => ({
  mocks: {
    getPublicTopCashbackMerchants: vi.fn(),
    getPublicCashbackPreview: vi.fn(),
    phase1Only: false,
  },
}));

// U-3 / UX-02 (docs/ux-pass-2026-07-09.md): `/calculator` is now
// wrapped in `Phase2Gate`, same as `/cashback`. Default the mock to
// phase1Only=false so the existing body-rendering tests below keep
// exercising the real page; the dedicated gate tests further down
// flip this per-case. Mirrors `cashback.test.tsx`'s mocking pattern.
vi.mock('~/hooks/use-app-config', () => ({
  useAppConfig: () => ({ config: { phase1Only: mocks.phase1Only }, isLoading: false }),
}));

vi.mock('~/services/public-stats', async (importActual) => {
  const actual = (await importActual()) as typeof PublicStats;
  return {
    ...actual,
    getPublicTopCashbackMerchants: (opts?: { limit?: number; country?: string }) =>
      mocks.getPublicTopCashbackMerchants(opts),
    getPublicCashbackPreview: (args: { merchantId: string; amountMinor: number }) =>
      mocks.getPublicCashbackPreview(args),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));
vi.mock('~/hooks/use-auth', () => ({ useAuth: () => ({ isAuthenticated: false }) }));
vi.mock('~/hooks/use-native-platform', () => ({ useNativePlatform: () => ({ isNative: false }) }));

function renderRoute(path = '/calculator'): HTMLElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/calculator" element={<CalculatorRoute />} />
          <Route path="/:country/:lang/calculator" element={<CalculatorRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return container;
}

describe('<CalculatorRoute />', () => {
  it('renders the dropdown populated with the top-cashback list', async () => {
    mocks.getPublicTopCashbackMerchants.mockResolvedValue({
      merchants: [
        { id: 'amazon-us', name: 'Amazon', logoUrl: null, userCashbackPct: '2.50' },
        { id: 'target-us', name: 'Target', logoUrl: null, userCashbackPct: '5.00' },
      ],
      asOf: new Date().toISOString(),
    });
    mocks.getPublicCashbackPreview.mockResolvedValue({
      merchantId: 'amazon-us',
      merchantName: 'Amazon',
      orderAmountMinor: '5000',
      cashbackPct: '2.50',
      cashbackMinor: '125',
      currency: 'USD',
    });
    renderRoute();
    // Wait for the dropdown to render a matching <option>. getByRole
    // finds options even inside a closed <select>.
    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Amazon · 2\.50% cashback/ })).toBeDefined();
    });
    expect(screen.getByRole('option', { name: /Target · 5% cashback/ })).toBeDefined();
  });

  it('switches merchantId in the preview when the dropdown changes', async () => {
    mocks.getPublicTopCashbackMerchants.mockResolvedValue({
      merchants: [
        { id: 'amazon-us', name: 'Amazon', logoUrl: null, userCashbackPct: '2.50' },
        { id: 'target-us', name: 'Target', logoUrl: null, userCashbackPct: '5.00' },
      ],
      asOf: new Date().toISOString(),
    });
    mocks.getPublicCashbackPreview.mockImplementation(async ({ merchantId, amountMinor }) => ({
      merchantId,
      merchantName: merchantId === 'amazon-us' ? 'Amazon' : 'Target',
      orderAmountMinor: String(amountMinor),
      cashbackPct: merchantId === 'amazon-us' ? '2.50' : '5.00',
      cashbackMinor: String(
        Math.floor((amountMinor * (merchantId === 'amazon-us' ? 250 : 500)) / 10_000),
      ),
      currency: 'USD',
    }));

    renderRoute();
    // Wait for the combobox (merchant picker) to render — means the
    // top-merchants query resolved and the section is mounted.
    const select = (await screen.findByRole('combobox', {
      name: /Select merchant/i,
    })) as HTMLSelectElement;
    // And wait for the initial preview call to fire.
    await waitFor(() => {
      expect(mocks.getPublicCashbackPreview).toHaveBeenCalledWith({
        merchantId: 'amazon-us',
        amountMinor: 5000,
      });
    });
    fireEvent.change(select, { target: { value: 'target-us' } });
    await waitFor(() => {
      expect(mocks.getPublicCashbackPreview).toHaveBeenCalledWith({
        merchantId: 'target-us',
        amountMinor: 5000,
      });
    });
  });

  it('shows empty-state copy when the top-merchants list is empty', async () => {
    mocks.getPublicTopCashbackMerchants.mockResolvedValue({
      merchants: [],
      asOf: new Date().toISOString(),
    });
    renderRoute();
    await waitFor(() => {
      expect(screen.getByText(/No merchants available right now/)).toBeDefined();
    });
  });

  // CAT-02 (2026-06-30 cold audit): this route was one of three
  // country-blind catalog surfaces — the dropdown showed every
  // merchant globally regardless of the visitor's locale.
  it('passes the URL country segment through to the top-merchants request', async () => {
    mocks.getPublicTopCashbackMerchants.mockResolvedValue({
      merchants: [],
      asOf: new Date().toISOString(),
    });
    renderRoute('/gb/en/calculator');
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
    renderRoute('/calculator');
    await waitFor(() => {
      expect(mocks.getPublicTopCashbackMerchants).toHaveBeenCalledWith(
        expect.objectContaining({ country: 'us' }),
      );
    });
  });
});

/**
 * U-3 / UX-02 (docs/ux-pass-2026-07-09.md): `/calculator` had no
 * `LOOP_PHASE_1_ONLY` gate at all, so it rendered live with
 * Phase-2 copy and a "No merchants available right now" empty state
 * that read as a data glitch rather than "not launched yet." Fixed
 * by wrapping the route in the same `Phase2Gate` `/cashback` already
 * uses (`apps/web/app/routes/cashback.tsx`). These tests assert the
 * gate itself, on both settings of the flag — the block above always
 * forces `phase1Only: false` and never exercised the gate.
 */
describe('<CalculatorRoute /> Phase-1 gate', () => {
  it('renders the "Coming soon" gate when phase1Only is true and never fetches merchants', () => {
    mocks.phase1Only = true;
    mocks.getPublicTopCashbackMerchants.mockClear();
    renderRoute();
    expect(screen.getByRole('heading', { name: /coming soon/i })).toBeDefined();
    expect(screen.queryByText(/Cashback calculator/)).toBeNull();
    expect(screen.queryByText(/No merchants available right now/)).toBeNull();
    expect(mocks.getPublicTopCashbackMerchants).not.toHaveBeenCalled();
  });

  it('renders the real calculator page when phase1Only is false', async () => {
    mocks.phase1Only = false;
    mocks.getPublicTopCashbackMerchants.mockResolvedValue({
      merchants: [],
      asOf: new Date().toISOString(),
    });
    renderRoute();
    expect(screen.getByRole('heading', { name: /cashback calculator/i })).toBeDefined();
    expect(screen.queryByRole('heading', { name: /coming soon/i })).toBeNull();
    await waitFor(() => {
      expect(mocks.getPublicTopCashbackMerchants).toHaveBeenCalled();
    });
  });
});
