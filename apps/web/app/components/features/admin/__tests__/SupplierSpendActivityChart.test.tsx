// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as AdminModule from '~/services/admin';
import { SupplierSpendActivityChart } from '../SupplierSpendActivityChart';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getSupplierSpendActivity: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getSupplierSpendActivity: (opts?: { days?: number; currency?: 'USD' | 'GBP' | 'EUR' }) =>
      adminMock.getSupplierSpendActivity(opts),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderChart(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <SupplierSpendActivityChart />
    </QueryClientProvider>,
  );
}

describe('<SupplierSpendActivityChart />', () => {
  it('renders empty-state copy when every day is zero spend', async () => {
    adminMock.getSupplierSpendActivity.mockResolvedValue({
      windowDays: 30,
      currency: 'USD',
      days: [
        {
          day: '2026-04-20',
          currency: 'USD',
          count: 0,
          faceValueMinor: '0',
          wholesaleMinor: '0',
          userCashbackMinor: '0',
          loopMarginMinor: '0',
        },
      ],
    });
    renderChart();
    await waitFor(() => {
      expect(screen.getByText(/No fulfilled USD orders in the last 30 days/i)).toBeDefined();
    });
  });

  it('renders an inline error line on fetch failure', async () => {
    adminMock.getSupplierSpendActivity.mockRejectedValue(new Error('boom'));
    renderChart();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load supplier-spend activity/i)).toBeDefined();
    });
  });

  it('renders one row per day with formatted wholesale and aria label', async () => {
    adminMock.getSupplierSpendActivity.mockResolvedValue({
      windowDays: 2,
      currency: 'USD',
      days: [
        {
          day: '2026-04-21',
          currency: 'USD',
          count: 10,
          faceValueMinor: '100000',
          wholesaleMinor: '95000',
          userCashbackMinor: '3000',
          loopMarginMinor: '2000',
        },
        {
          day: '2026-04-22',
          currency: 'USD',
          count: 20,
          faceValueMinor: '250000',
          wholesaleMinor: '240000',
          userCashbackMinor: '7500',
          loopMarginMinor: '2500',
        },
      ],
    });
    renderChart();
    await waitFor(() => {
      expect(screen.getByLabelText(/Apr 21: \$950\.00 wholesale/)).toBeDefined();
    });
    expect(screen.getByLabelText(/Apr 22: \$2,400\.00 wholesale/)).toBeDefined();
  });

  it('switches currency via the tab picker and refetches', async () => {
    adminMock.getSupplierSpendActivity.mockResolvedValue({
      windowDays: 30,
      currency: 'USD',
      days: [],
    });
    renderChart();
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'USD' })).toHaveProperty('ariaSelected', 'true');
    });
    fireEvent.click(screen.getByRole('tab', { name: 'GBP' }));
    await waitFor(() => {
      expect(
        adminMock.getSupplierSpendActivity.mock.calls.some(
          (call) => (call[0] as { currency?: string } | undefined)?.currency === 'GBP',
        ),
      ).toBe(true);
    });
  });
});
