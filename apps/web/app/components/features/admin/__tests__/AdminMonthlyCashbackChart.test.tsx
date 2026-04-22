// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as AdminModule from '~/services/admin';
import { AdminMonthlyCashbackChart } from '../AdminMonthlyCashbackChart';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminCashbackMonthly: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminCashbackMonthly: () => adminMock.getAdminCashbackMonthly(),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderChart(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AdminMonthlyCashbackChart />
    </QueryClientProvider>,
  );
}

describe('<AdminMonthlyCashbackChart />', () => {
  it('renders the explicit empty-state when the backend returns no entries', async () => {
    adminMock.getAdminCashbackMonthly.mockResolvedValue({ entries: [] });
    renderChart();
    await waitFor(() => {
      expect(screen.getByText(/No cashback emitted in the last 12 months yet/i)).toBeDefined();
    });
  });

  it('renders an inline error line on fetch failure (not silent-hide)', async () => {
    adminMock.getAdminCashbackMonthly.mockRejectedValue(new Error('boom'));
    renderChart();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load monthly cashback/i)).toBeDefined();
    });
  });

  it('renders one row per (month, currency) pair with bar + label', async () => {
    adminMock.getAdminCashbackMonthly.mockResolvedValue({
      entries: [
        { month: '2026-02', currency: 'GBP', cashbackMinor: '100000' },
        { month: '2026-03', currency: 'GBP', cashbackMinor: '150000' },
        { month: '2026-04', currency: 'GBP', cashbackMinor: '180000' },
        { month: '2026-04', currency: 'USD', cashbackMinor: '45000' },
      ],
    });
    renderChart();
    // Wait for the first bar row to land — the component renders a list
    // of <li aria-label="Apr 26 £1,800"> items.
    await waitFor(() => {
      // Two April 2026 entries (GBP + USD) — both render aria-labels
      // starting with "Apr 26". Matching count rather than uniqueness.
      expect(screen.getAllByLabelText(/Apr 26/)).toHaveLength(2);
    });
    // 4 rows total — 3 GBP + 1 USD.
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    // Per-currency headings: component renders "GBP" and "USD" above
    // each bar group. Currency bucket headers appear exactly once
    // each.
    expect(screen.getAllByText('GBP')).toHaveLength(1);
    expect(screen.getAllByText('USD')).toHaveLength(1);
  });
});
