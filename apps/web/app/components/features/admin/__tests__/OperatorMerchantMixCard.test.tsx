// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as AdminModule from '~/services/admin';
import { OperatorMerchantMixCard } from '../OperatorMerchantMixCard';

afterEach(cleanup);

const { adminMock, merchantsMock } = vi.hoisted(() => ({
  adminMock: {
    getOperatorMerchantMix: vi.fn(),
  },
  merchantsMock: {
    merchants: [] as Array<{ id: string; name: string }>,
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getOperatorMerchantMix: (id: string, opts?: unknown) =>
      adminMock.getOperatorMerchantMix(id, opts),
  };
});

vi.mock('~/hooks/use-merchants', () => ({
  useAllMerchants: () => ({ merchants: merchantsMock.merchants }),
}));

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderCard(operatorId = 'op-alpha-01'): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <OperatorMerchantMixCard operatorId={operatorId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<OperatorMerchantMixCard />', () => {
  it('renders an empty-state when the operator has no attributed orders', async () => {
    merchantsMock.merchants = [];
    adminMock.getOperatorMerchantMix.mockResolvedValue({
      operatorId: 'op-idle',
      since: '2026-04-22T01:00:00.000Z',
      rows: [],
    });
    renderCard('op-idle');
    await waitFor(() => {
      expect(screen.getByText(/This operator hasn.*t carried any orders/i)).toBeDefined();
    });
  });

  it('renders an inline error line on fetch failure', async () => {
    merchantsMock.merchants = [];
    adminMock.getOperatorMerchantMix.mockRejectedValue(new Error('boom'));
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load merchant mix/i)).toBeDefined();
    });
  });

  it('renders merchant rows with display name + drill + failed-triage links', async () => {
    merchantsMock.merchants = [{ id: 'mctx-starbucks', name: 'Starbucks' }];
    adminMock.getOperatorMerchantMix.mockResolvedValue({
      operatorId: 'op-alpha-01',
      since: '2026-04-22T01:00:00.000Z',
      rows: [
        {
          merchantId: 'mctx-starbucks',
          orderCount: 42,
          fulfilledCount: 40,
          failedCount: 2,
          lastOrderAt: new Date().toISOString(),
        },
      ],
    });
    renderCard('op-alpha-01');

    await waitFor(() => {
      expect(screen.getByText('Starbucks')).toBeDefined();
    });

    const drill = screen.getByRole('link', { name: /open merchant detail for starbucks/i });
    expect(drill.getAttribute('href')).toBe('/admin/merchants/mctx-starbucks');

    const failed = screen.getByRole('link', {
      name: /review 2 failed orders on mctx-starbucks carried by this operator/i,
    });
    expect(failed.getAttribute('href')).toBe(
      '/admin/orders?state=failed&merchantId=mctx-starbucks&ctxOperatorId=op-alpha-01',
    );

    // Raw merchantId rendered alongside name for disambiguation.
    expect(screen.getByText('mctx-starbucks')).toBeDefined();
  });

  it('falls back to raw merchantId when the catalog has no entry (evicted)', async () => {
    merchantsMock.merchants = [];
    adminMock.getOperatorMerchantMix.mockResolvedValue({
      operatorId: 'op-alpha-01',
      since: '',
      rows: [
        {
          merchantId: 'mctx-evicted',
          orderCount: 5,
          fulfilledCount: 5,
          failedCount: 0,
          lastOrderAt: new Date().toISOString(),
        },
      ],
    });
    renderCard();
    await waitFor(() => {
      const link = screen.getByRole('link', { name: /open merchant detail for mctx-evicted/i });
      expect(link).toBeDefined();
    });
  });
});
