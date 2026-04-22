// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type * as AdminModule from '~/services/admin';
import { OrdersSparkline, toPoints } from '../OrdersSparkline';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getOrdersActivity: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getOrdersActivity: () => adminMock.getOrdersActivity(),
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
        <OrdersSparkline />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('toPoints', () => {
  it('returns empty string for empty input', () => {
    expect(toPoints([])).toBe('');
  });

  it('renders a single value at x=0 baseline y', () => {
    expect(toPoints([10])).toBe('0.0,2.0');
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

describe('<OrdersSparkline />', () => {
  it('renders created + fulfilled totals once data lands', async () => {
    adminMock.getOrdersActivity.mockResolvedValue({
      windowDays: 14,
      days: [
        { day: '2026-04-20', created: 3, fulfilled: 2 },
        { day: '2026-04-21', created: 0, fulfilled: 0 },
        { day: '2026-04-22', created: 5, fulfilled: 4 },
      ],
    });
    renderComponent();
    await waitFor(() => {
      expect(screen.getByText(/8 created/)).toBeDefined();
    });
    expect(screen.getByText(/6 fulfilled/)).toBeDefined();
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/8 created, 6 fulfilled/);
  });

  it('surfaces an error banner when the fetch fails', async () => {
    adminMock.getOrdersActivity.mockRejectedValue(new Error('boom'));
    renderComponent();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load orders activity/)).toBeDefined();
    });
  });
});
