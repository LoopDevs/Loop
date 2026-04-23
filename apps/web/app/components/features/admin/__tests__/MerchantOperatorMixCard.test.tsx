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

function renderCard(merchantId = 'mctx-acme'): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MerchantOperatorMixCard merchantId={merchantId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
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
});
