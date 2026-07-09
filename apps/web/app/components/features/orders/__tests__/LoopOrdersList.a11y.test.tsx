// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type * as OrdersLoopModule from '~/services/orders-loop';
import type { LoopOrderView } from '~/services/orders-loop';

/**
 * ADR 042 (B-2): runtime DOM a11y smoke test for the orders list. Mocking
 * mirrors the sibling LoopOrdersList.test.tsx pattern (fixture + wrapper).
 */

expect.extend(toHaveNoViolations);

const listMock = vi.fn();
vi.mock('~/services/orders-loop', async () => {
  const actual = await vi.importActual<typeof OrdersLoopModule>('~/services/orders-loop');
  return {
    ...actual,
    listLoopOrders: () => listMock(),
  };
});

vi.mock('~/hooks/use-merchants', () => ({
  useAllMerchants: () => ({
    merchants: [{ id: 'm1', name: 'Target', enabled: true }],
  }),
}));

import { LoopOrdersList } from '../LoopOrdersList';

function wrap(ui: React.ReactElement): React.JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

function mkOrder(overrides: Partial<LoopOrderView> = {}): LoopOrderView {
  return {
    id: 'o-1',
    merchantId: 'm1',
    state: 'fulfilled',
    faceValueMinor: '1000',
    currency: 'USD',
    chargeMinor: '1000',
    chargeCurrency: 'USD',
    paymentMethod: 'usdc',
    paymentMemo: 'MEMO',
    stellarAddress: null,
    userCashbackMinor: '50',
    ctxOrderId: 'ctx-1',
    redeemCode: 'GIFT-123',
    redeemPin: '4242',
    redeemUrl: null,
    failureReason: null,
    createdAt: '2026-04-21T12:00:00Z',
    paidAt: '2026-04-21T12:01:00Z',
    fulfilledAt: '2026-04-21T12:05:00Z',
    failedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  listMock.mockReset();
});
afterEach(cleanup);

describe('<LoopOrdersList /> a11y', () => {
  it('has no axe violations at WCAG 2.1 A/AA with a mixed-state order list', async () => {
    listMock.mockResolvedValue({
      orders: [
        mkOrder({ id: 'o-1', state: 'fulfilled' }),
        mkOrder({ id: 'o-2', state: 'pending_payment' }),
        mkOrder({ id: 'o-3', state: 'failed', failureReason: 'Card declined' }),
      ],
    });
    const { container } = render(wrap(<LoopOrdersList enabled={true} />));
    await waitFor(() => expect(container.querySelector('section')).not.toBeNull());
    const results = await axe(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    expect(results).toHaveNoViolations();
  });
});
