// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as UserModule from '~/services/user';
import {
  MonthlyCashbackChart,
  barWidthPct,
  computeMax,
  formatMinor,
  monthLabel,
} from '../MonthlyCashbackChart';

afterEach(cleanup);

const { userMock } = vi.hoisted(() => ({
  userMock: {
    getCashbackMonthly: vi.fn(),
  },
}));

vi.mock('~/services/user', async (importActual) => {
  const actual = (await importActual()) as typeof UserModule;
  return {
    ...actual,
    getCashbackMonthly: () => userMock.getCashbackMonthly(),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));
// A2-1156: auth-gate in the component → tests need to pretend
// the user is authenticated so the query fires.
vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: true, user: null, refreshUser: () => {} }),
}));

function renderChart(): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={qc}>
      <MonthlyCashbackChart />
    </QueryClientProvider>,
  );
  return { container: result.container };
}

describe('monthLabel', () => {
  it('formats a valid YYYY-MM', () => {
    expect(monthLabel('2026-04')).toBe('Apr 26');
    expect(monthLabel('2025-11')).toBe('Nov 25');
  });

  it('returns input unchanged on malformed shape', () => {
    expect(monthLabel('2026')).toBe('2026');
    expect(monthLabel('nope')).toBe('nope');
    expect(monthLabel('2026-13')).toBe('2026-13');
  });
});

describe('formatMinor', () => {
  it('formats GBP minor units with no decimals', () => {
    expect(formatMinor('12500', 'GBP')).toMatch(/£125/);
  });

  it('returns em-dash on non-numeric input', () => {
    expect(formatMinor('garbage', 'GBP')).toBe('—');
  });
});

describe('computeMax', () => {
  it('returns 0 for an empty list', () => {
    expect(computeMax([])).toBe(0n);
  });

  it('returns the bigint max across entries', () => {
    const max = computeMax([
      { month: '2026-01', currency: 'GBP', cashbackMinor: '100' },
      { month: '2026-02', currency: 'GBP', cashbackMinor: '2500' },
      { month: '2026-03', currency: 'GBP', cashbackMinor: '1800' },
    ]);
    expect(max).toBe(2500n);
  });

  it('skips malformed amounts silently', () => {
    const max = computeMax([
      { month: '2026-01', currency: 'GBP', cashbackMinor: 'nope' },
      { month: '2026-02', currency: 'GBP', cashbackMinor: '500' },
    ]);
    expect(max).toBe(500n);
  });
});

describe('barWidthPct', () => {
  it('returns 0 when max is zero', () => {
    expect(barWidthPct('100', 0n)).toBe(0);
  });

  it('returns a percentage in the 0..100 range', () => {
    expect(barWidthPct('500', 1000n)).toBe(50);
    expect(barWidthPct('1000', 1000n)).toBe(100);
    expect(barWidthPct('0', 1000n)).toBe(0);
  });

  it('handles malformed value as 0', () => {
    expect(barWidthPct('nope', 100n)).toBe(0);
  });
});

describe('<MonthlyCashbackChart />', () => {
  it('hides silently on fetch error', async () => {
    userMock.getCashbackMonthly.mockRejectedValue(new Error('boom'));
    const { container } = renderChart();
    await waitFor(() => {
      expect(userMock.getCashbackMonthly).toHaveBeenCalled();
    });
    expect(container.querySelector('[aria-labelledby="monthly-cashback-heading"]')).toBeNull();
  });

  it('hides when the user has never earned cashback', async () => {
    userMock.getCashbackMonthly.mockResolvedValue({ entries: [] });
    const { container } = renderChart();
    await waitFor(() => {
      expect(userMock.getCashbackMonthly).toHaveBeenCalled();
    });
    expect(container.querySelector('[aria-labelledby="monthly-cashback-heading"]')).toBeNull();
  });

  it('renders one row per month for a single-currency user', async () => {
    userMock.getCashbackMonthly.mockResolvedValue({
      entries: [
        { month: '2026-02', currency: 'GBP', cashbackMinor: '2500' },
        { month: '2026-03', currency: 'GBP', cashbackMinor: '1800' },
        { month: '2026-04', currency: 'GBP', cashbackMinor: '900' },
      ],
    });
    renderChart();
    await screen.findByText(/Last 12 months/i);
    expect(screen.getByText('Feb 26')).toBeDefined();
    expect(screen.getByText('Mar 26')).toBeDefined();
    expect(screen.getByText('Apr 26')).toBeDefined();
    // Currency-group header + 3 amount labels. Each row carries its
    // own amount so users see the actual number next to the bar.
    expect(screen.getAllByText(/£/).length).toBeGreaterThanOrEqual(3);
  });

  it('groups into one chart per currency for multi-currency users', async () => {
    userMock.getCashbackMonthly.mockResolvedValue({
      entries: [
        { month: '2026-03', currency: 'GBP', cashbackMinor: '2500' },
        { month: '2026-03', currency: 'USD', cashbackMinor: '1200' },
        { month: '2026-04', currency: 'GBP', cashbackMinor: '1800' },
        { month: '2026-04', currency: 'USD', cashbackMinor: '900' },
      ],
    });
    const { container } = renderChart();
    await screen.findByText(/Last 12 months/i);
    // Each currency is its own header within the single section.
    expect(screen.getByText('GBP')).toBeDefined();
    expect(screen.getByText('USD')).toBeDefined();
    // 4 rows total (2 months × 2 currencies), each with a month label.
    const rows = container.querySelectorAll('ul li');
    expect(rows.length).toBe(4);
  });
});
