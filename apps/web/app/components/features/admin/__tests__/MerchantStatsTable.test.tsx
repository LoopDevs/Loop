// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type * as AdminModule from '~/services/admin';
import { MerchantStatsTable, fmtMinor } from '../MerchantStatsTable';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getMerchantStats: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getMerchantStats: () => adminMock.getMerchantStats(),
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
        <MerchantStatsTable />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('fmtMinor', () => {
  it('formats minor units as localized currency', () => {
    expect(fmtMinor('12500', 'GBP')).toMatch(/125\.00/);
  });

  it('returns em-dash for non-finite input', () => {
    expect(fmtMinor('abc', 'GBP')).toBe('—');
  });
});

describe('<MerchantStatsTable />', () => {
  it('renders aggregate rows with merchant id + Loop margin', async () => {
    adminMock.getMerchantStats.mockResolvedValue({
      since: '2026-03-23T00:00:00.000Z',
      rows: [
        {
          merchantId: 'mer-123',
          orderCount: 42,
          faceValueMinor: '420000',
          wholesaleMinor: '336000',
          userCashbackMinor: '42000',
          loopMarginMinor: '42000',
          lastFulfilledAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          currency: 'GBP',
        },
      ],
    });
    renderComponent();
    await waitFor(() => {
      expect(screen.getByText('mer-123')).toBeDefined();
    });
    expect(screen.getByText('42')).toBeDefined();
    // Face value £4,200.00 and wholesale / margin values all share the
    // minor-unit format; any match confirms fmtMinor wired through.
    expect(screen.getAllByText(/\d+\.00/).length).toBeGreaterThan(0);
    // Relative timestamp within minutes window.
    expect(screen.getByText(/\dm ago/)).toBeDefined();
  });

  it('surfaces an empty-state when no fulfilled orders in window', async () => {
    adminMock.getMerchantStats.mockResolvedValue({
      since: '2026-03-23T00:00:00.000Z',
      rows: [],
    });
    renderComponent();
    await waitFor(() => {
      expect(screen.getByText(/No fulfilled orders in the window/)).toBeDefined();
    });
  });

  it('surfaces an error banner on fetch failure', async () => {
    adminMock.getMerchantStats.mockRejectedValue(new Error('boom'));
    renderComponent();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load merchant stats/)).toBeDefined();
    });
  });
});
