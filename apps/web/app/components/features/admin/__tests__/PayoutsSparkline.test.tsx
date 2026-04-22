// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type * as AdminModule from '~/services/admin';
import type { PayoutsActivityResponse } from '~/services/admin';
import { PayoutsSparkline, dayTotalStroops } from '../PayoutsSparkline';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getPayoutsActivity: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getPayoutsActivity: () => adminMock.getPayoutsActivity(),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderComponent(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PayoutsSparkline />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function snapshot(
  rows: Array<{
    day: string;
    count: number;
    byAsset: Array<{ assetCode: string; stroops: string; count: number }>;
  }>,
): PayoutsActivityResponse {
  return { days: rows.length, rows };
}

describe('dayTotalStroops', () => {
  it('returns 0 for a zero-day (empty byAsset)', () => {
    expect(dayTotalStroops({ day: '2026-04-22', count: 0, byAsset: [] })).toBe(0);
  });

  it('sums stroops across every asset bucket on the day', () => {
    expect(
      dayTotalStroops({
        day: '2026-04-22',
        count: 3,
        byAsset: [
          { assetCode: 'USDLOOP', stroops: '1000', count: 2 },
          { assetCode: 'GBPLOOP', stroops: '500', count: 1 },
        ],
      }),
    ).toBe(1500);
  });

  it('skips malformed stroop strings without throwing', () => {
    expect(
      dayTotalStroops({
        day: '2026-04-22',
        count: 2,
        byAsset: [
          { assetCode: 'USDLOOP', stroops: '100', count: 1 },
          { assetCode: 'GBPLOOP', stroops: 'not-a-number', count: 1 },
        ],
      }),
    ).toBe(100);
  });
});

describe('<PayoutsSparkline />', () => {
  it('renders the polyline chart and total confirmed count once data lands', async () => {
    adminMock.getPayoutsActivity.mockResolvedValue(
      snapshot([
        {
          day: '2026-04-20',
          count: 3,
          byAsset: [{ assetCode: 'USDLOOP', stroops: '150000', count: 3 }],
        },
        { day: '2026-04-21', count: 0, byAsset: [] },
        {
          day: '2026-04-22',
          count: 5,
          byAsset: [{ assetCode: 'GBPLOOP', stroops: '400000', count: 5 }],
        },
      ]),
    );
    renderComponent();
    await waitFor(() => {
      expect(screen.getByText('8 confirmed')).toBeDefined();
    });
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/8 transactions/);
  });

  it('surfaces an error banner when the fetch fails', async () => {
    adminMock.getPayoutsActivity.mockRejectedValue(new Error('boom'));
    renderComponent();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load payouts activity/)).toBeDefined();
    });
  });
});
