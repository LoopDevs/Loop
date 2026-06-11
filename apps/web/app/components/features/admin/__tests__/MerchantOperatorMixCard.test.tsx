// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as AdminModule from '~/services/admin';
import { MerchantOperatorMixCard } from '../MerchantOperatorMixCard';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getMerchantOperatorMix: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getMerchantOperatorMix: (id: string, opts?: unknown) =>
      adminMock.getMerchantOperatorMix(id, opts),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderCard(merchantId = 'mctx-acme'): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MerchantOperatorMixCard merchantId={merchantId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

describe('<MerchantOperatorMixCard />', () => {
  it('renders an empty-state when no operator has carried an order', async () => {
    adminMock.getMerchantOperatorMix.mockResolvedValue({
      merchantId: 'mctx-drained',
      since: '2026-04-22T01:00:00.000Z',
      rows: [],
    });
    renderCard('mctx-drained');
    await waitFor(() => {
      expect(screen.getByText(/No operator has carried an order for this merchant/i)).toBeDefined();
    });
  });

  it('renders an inline error line on fetch failure', async () => {
    adminMock.getMerchantOperatorMix.mockRejectedValue(new Error('boom'));
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load operator mix/i)).toBeDefined();
    });
  });

  it('renders rows with operator-drill + failed-triage links', async () => {
    adminMock.getMerchantOperatorMix.mockResolvedValue({
      merchantId: 'mctx-acme',
      since: '2026-04-22T01:00:00.000Z',
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
    renderCard('mctx-acme');

    await waitFor(() => {
      expect(screen.getByText('op-alpha-01')).toBeDefined();
    });

    const drill = screen.getByRole('link', { name: /open operator detail for op-alpha-01/i });
    expect(drill.getAttribute('href')).toBe('/admin/operators/op-alpha-01');

    const failed = screen.getByRole('link', {
      name: /review 2 failed orders on op-alpha-01 for this merchant/i,
    });
    expect(failed.getAttribute('href')).toBe(
      '/admin/orders?state=failed&merchantId=mctx-acme&ctxOperatorId=op-alpha-01',
    );

    // Success rate renders to 1dp.
    expect(screen.getByText('95.2%')).toBeDefined();
  });

  it('formats success % as "—" for zero-order rows (defensive)', async () => {
    adminMock.getMerchantOperatorMix.mockResolvedValue({
      merchantId: 'mctx-acme',
      since: '',
      rows: [
        {
          operatorId: 'op-idle',
          orderCount: 0,
          fulfilledCount: 0,
          failedCount: 0,
          lastOrderAt: new Date().toISOString(),
        },
      ],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('—')).toBeDefined();
    });
  });

  // Comprehensive-audit 2026-06-11 P10: `since` must be derived at
  // fetch time. A render-time `since` isn't part of the queryKey, so
  // long-lived pages would refetch with the original (ever-staler)
  // window forever. Same pattern in OperatorMerchantMixCard,
  // OperatorStatsCard, UserOperatorMixCard, SupplierSpendCard,
  // TopUsersTable — this test pins the representative instance.
  it('recomputes `since` at fetch time so refetches use a fresh rolling window', async () => {
    adminMock.getMerchantOperatorMix.mockReset();
    adminMock.getMerchantOperatorMix.mockResolvedValue({
      merchantId: 'mctx-drained',
      since: '2026-04-22T01:00:00.000Z',
      rows: [],
    });
    const qc = renderCard('mctx-drained');
    await waitFor(() => {
      expect(adminMock.getMerchantOperatorMix).toHaveBeenCalledTimes(1);
    });
    const firstSince = (adminMock.getMerchantOperatorMix.mock.calls[0]?.[1] as { since: string })
      .since;

    // Pretend an hour passes while the page sits open, then refetch.
    const later = Date.now() + 60 * 60 * 1000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      await qc.refetchQueries();
    } finally {
      nowSpy.mockRestore();
    }
    expect(adminMock.getMerchantOperatorMix).toHaveBeenCalledTimes(2);
    const secondSince = (adminMock.getMerchantOperatorMix.mock.calls[1]?.[1] as { since: string })
      .since;
    expect(new Date(secondSince).getTime() - new Date(firstSince).getTime()).toBeGreaterThanOrEqual(
      60 * 60 * 1000,
    );
  });
});
