// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type * as AdminModule from '~/services/admin';
import type { CashbackActivityResponse } from '~/services/admin';
import { CashbackSparkline, toPoints } from '../CashbackSparkline';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getCashbackActivity: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getCashbackActivity: () => adminMock.getCashbackActivity(),
  };
});

vi.mock('~/hooks/query-retry', () => ({
  shouldRetry: () => false,
}));

function renderComponent(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CashbackSparkline />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function snapshot(
  rows: Array<{
    day: string;
    count: number;
    byCurrency: Array<{ currency: string; amountMinor: string }>;
  }>,
): CashbackActivityResponse {
  return { days: rows.length, rows };
}

describe('toPoints', () => {
  it('returns empty string for empty input', () => {
    expect(toPoints([])).toBe('');
  });

  it('renders a single value at x=0 baseline y', () => {
    expect(toPoints([10])).toBe('0.0,2.0');
  });

  it('renders a flat series at the top when all values equal', () => {
    const pts = toPoints([5, 5, 5]);
    const ys = pts.split(' ').map((p) => Number(p.split(',')[1]));
    expect(new Set(ys).size).toBe(1);
  });

  it('zero anchors to the chart baseline', () => {
    const pts = toPoints([0, 10]);
    const [first, second] = pts.split(' ').map((p) => Number(p.split(',')[1]));
    expect(first).toBeGreaterThan((second ?? 0) + 10);
  });

  it('distributes x evenly across the width', () => {
    const pts = toPoints([1, 2, 3]).split(' ');
    const xs = pts.map((p) => Number(p.split(',')[0]));
    expect(xs[0]).toBe(0);
    expect(xs[2]).toBe(560);
    expect(xs[1]).toBe(280);
  });
});

describe('<CashbackSparkline />', () => {
  it('renders the polyline chart and total count once data lands', async () => {
    adminMock.getCashbackActivity.mockResolvedValue(
      snapshot([
        { day: '2026-04-20', count: 3, byCurrency: [{ currency: 'GBP', amountMinor: '150' }] },
        { day: '2026-04-21', count: 0, byCurrency: [] },
        { day: '2026-04-22', count: 5, byCurrency: [{ currency: 'USD', amountMinor: '400' }] },
      ]),
    );
    renderComponent();
    await waitFor(() => {
      expect(screen.getByText('8 credits')).toBeDefined();
    });
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/8 credit-transactions/);
  });

  it('surfaces an error banner when the fetch fails', async () => {
    adminMock.getCashbackActivity.mockRejectedValue(new Error('boom'));
    renderComponent();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load cashback activity/)).toBeDefined();
    });
  });

  it('ignores rows with malformed amounts and still totals the valid ones', async () => {
    adminMock.getCashbackActivity.mockResolvedValue(
      snapshot([
        {
          day: '2026-04-22',
          count: 2,
          byCurrency: [
            { currency: 'USD', amountMinor: '100' },
            { currency: 'GBP', amountMinor: 'not-a-number' },
          ],
        },
      ]),
    );
    renderComponent();
    await waitFor(() => {
      expect(screen.getByText('2 credits')).toBeDefined();
    });
  });
});
