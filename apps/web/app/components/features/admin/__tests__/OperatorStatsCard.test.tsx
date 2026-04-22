// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type * as AdminModule from '~/services/admin';
import { OperatorStatsCard, successRatePct } from '../OperatorStatsCard';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getOperatorStats: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getOperatorStats: (opts?: { since?: string }) => adminMock.getOperatorStats(opts),
  };
});

vi.mock('~/hooks/query-retry', () => ({
  shouldRetry: () => false,
}));

function renderCard(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <OperatorStatsCard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('successRatePct', () => {
  it('returns em-dash for an operator with zero orders', () => {
    expect(
      successRatePct({
        operatorId: 'op-none',
        orderCount: 0,
        fulfilledCount: 0,
        failedCount: 0,
        lastOrderAt: '2026-04-22T00:00:00Z',
      }),
    ).toBe('—');
  });

  it('renders the ratio to one decimal', () => {
    expect(
      successRatePct({
        operatorId: 'op-a',
        orderCount: 10,
        fulfilledCount: 8,
        failedCount: 1,
        lastOrderAt: '2026-04-22T00:00:00Z',
      }),
    ).toBe('80.0%');
  });

  it('clamps above 100% from a malformed backend row', () => {
    expect(
      successRatePct({
        operatorId: 'op-lie',
        orderCount: 1,
        fulfilledCount: 5,
        failedCount: 0,
        lastOrderAt: '2026-04-22T00:00:00Z',
      }),
    ).toBe('100.0%');
  });
});

describe('<OperatorStatsCard />', () => {
  it('renders operator rows with drill-down links', async () => {
    adminMock.getOperatorStats.mockResolvedValue({
      since: new Date().toISOString(),
      rows: [
        {
          operatorId: 'op-alpha-01',
          orderCount: 42,
          fulfilledCount: 40,
          failedCount: 2,
          lastOrderAt: new Date().toISOString(),
        },
      ],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('op-alpha-01')).toBeDefined();
    });
    const row = screen.getByRole('link', { name: /show orders carried by op-alpha-01/i });
    expect(row.getAttribute('href')).toBe('/admin/orders?ctxOperatorId=op-alpha-01');
    // Non-zero failed count becomes its own failed-state drill link.
    const failedLink = screen.getByRole('link', { name: /review 2 failed orders on op-alpha-01/i });
    expect(failedLink.getAttribute('href')).toBe(
      '/admin/orders?state=failed&ctxOperatorId=op-alpha-01',
    );
  });

  it('renders an empty-state when no operator traffic in window', async () => {
    adminMock.getOperatorStats.mockResolvedValue({
      since: new Date().toISOString(),
      rows: [],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/No operator activity in the last 24 hours/)).toBeDefined();
    });
  });

  it('surfaces an error banner on fetch failure', async () => {
    adminMock.getOperatorStats.mockRejectedValue(new Error('boom'));
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load operator stats/)).toBeDefined();
    });
  });
});
