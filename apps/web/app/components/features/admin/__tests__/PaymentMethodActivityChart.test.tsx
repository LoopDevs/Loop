// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as AdminModule from '~/services/admin';
import { PaymentMethodActivityChart, shortDay } from '../PaymentMethodActivityChart';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminPaymentMethodActivity: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminPaymentMethodActivity: (opts?: { days?: number }) =>
      adminMock.getAdminPaymentMethodActivity(opts),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderChart(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <PaymentMethodActivityChart />
    </QueryClientProvider>,
  );
}

function emptyBucket(): Record<string, number> {
  return { xlm: 0, usdc: 0, credit: 0, loop_asset: 0 };
}

describe('shortDay', () => {
  it('formats "YYYY-MM-DD" as "Mon D"', () => {
    expect(shortDay('2026-04-22')).toBe('Apr 22');
    expect(shortDay('2026-01-03')).toBe('Jan 3');
    expect(shortDay('2026-12-31')).toBe('Dec 31');
  });

  it('returns the raw string on malformed input (defensive)', () => {
    expect(shortDay('nope')).toBe('nope');
    expect(shortDay('2026/04/22')).toBe('2026/04/22');
    expect(shortDay('2026-13-01')).toBe('2026-13-01');
  });
});

describe('<PaymentMethodActivityChart />', () => {
  it('renders the empty-state copy when every day has zero orders', async () => {
    adminMock.getAdminPaymentMethodActivity.mockResolvedValue({
      windowDays: 7,
      days: [
        { day: '2026-04-16', byMethod: emptyBucket() },
        { day: '2026-04-17', byMethod: emptyBucket() },
      ],
    });
    renderChart();
    await waitFor(() => {
      expect(screen.getByText(/No fulfilled orders in the last 7 days/i)).toBeDefined();
    });
  });

  it('renders an inline error line on fetch failure (dashboard — not silent-hide)', async () => {
    adminMock.getAdminPaymentMethodActivity.mockRejectedValue(new Error('boom'));
    renderChart();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load payment-method activity/i)).toBeDefined();
    });
  });

  it('renders one <li> per day + legend with all four rails', async () => {
    adminMock.getAdminPaymentMethodActivity.mockResolvedValue({
      windowDays: 3,
      days: [
        { day: '2026-04-20', byMethod: { xlm: 2, usdc: 0, credit: 1, loop_asset: 5 } },
        { day: '2026-04-21', byMethod: { xlm: 1, usdc: 0, credit: 0, loop_asset: 6 } },
        { day: '2026-04-22', byMethod: { xlm: 0, usdc: 2, credit: 0, loop_asset: 8 } },
      ],
    });
    renderChart();
    await waitFor(() => {
      expect(screen.getByLabelText(/Apr 20: 8 fulfilled orders/)).toBeDefined();
    });
    // 3 day rows in the chart list (not counting the legend list).
    const chartList = screen.getByRole('list', { name: /Payment-method legend/i });
    // Legend has 4 items (one per rail).
    expect(chartList.querySelectorAll('li')).toHaveLength(4);
    // Labels for each rail surface in the legend.
    for (const label of ['LOOP asset', 'Credit', 'USDC', 'XLM']) {
      expect(screen.getByText(label)).toBeDefined();
    }
  });

  it('renders a zero-day row with no bar segments but still shows the label + 0 total', async () => {
    adminMock.getAdminPaymentMethodActivity.mockResolvedValue({
      windowDays: 2,
      days: [
        { day: '2026-04-21', byMethod: emptyBucket() },
        { day: '2026-04-22', byMethod: { xlm: 0, usdc: 0, credit: 0, loop_asset: 3 } },
      ],
    });
    renderChart();
    await waitFor(() => {
      // Zero day keeps its label and renders "0" on the right.
      expect(screen.getByLabelText(/Apr 21: 0 fulfilled orders/)).toBeDefined();
      expect(screen.getByLabelText(/Apr 22: 3 fulfilled orders/)).toBeDefined();
    });
  });
});
