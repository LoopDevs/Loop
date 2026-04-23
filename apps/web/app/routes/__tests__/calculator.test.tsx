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

afterEach(cleanup);

const { mocks } = vi.hoisted(() => ({
  mocks: {
    getPublicTopCashbackMerchants: vi.fn(),
    getPublicCashbackPreview: vi.fn(),
  },
}));

vi.mock('~/services/public-stats', async (importActual) => {
  const actual = (await importActual()) as typeof PublicStats;
  return {
    ...actual,
    getPublicTopCashbackMerchants: (opts?: { limit?: number }) =>
      mocks.getPublicTopCashbackMerchants(opts),
    getPublicCashbackPreview: (args: { merchantId: string; amountMinor: number }) =>
      mocks.getPublicCashbackPreview(args),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));
vi.mock('~/hooks/use-auth', () => ({ useAuth: () => ({ isAuthenticated: false }) }));
vi.mock('~/hooks/use-native-platform', () => ({ useNativePlatform: () => ({ isNative: false }) }));

function renderRoute(): HTMLElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/calculator']}>
        <Routes>
          <Route path="/calculator" element={<CalculatorRoute />} />
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
});
