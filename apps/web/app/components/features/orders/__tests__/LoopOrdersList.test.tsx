// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ApiException } from '@loop/shared';
import type * as OrdersLoopModule from '~/services/orders-loop';
import type { LoopOrderView } from '~/services/orders-loop';

const listMock = vi.fn();
vi.mock('~/services/orders-loop', async () => {
  const actual = await vi.importActual<typeof OrdersLoopModule>('~/services/orders-loop');
  return {
    ...actual,
    listLoopOrders: () => listMock(),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

vi.mock('~/hooks/use-merchants', () => ({
  useAllMerchants: () => ({
    merchants: [{ id: 'm1', name: 'Target', enabled: true }],
  }),
}));

import { LoopOrdersList } from '../LoopOrdersList';

function wrap(ui: React.ReactElement): React.JSX.Element {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
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
    userCashbackMinor: '50',
    ctxOrderId: 'ctx-1',
    paymentCryptoCurrency: 'XLM',
    payment: null,
    redeemCode: 'GIFT-123',
    redeemPin: '4242',
    redeemUrl: null,
    failureReason: null,
    createdAt: '2026-04-21T12:00:00Z',
    fulfilledAt: '2026-04-21T12:05:00Z',
    failedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  listMock.mockReset();
});
afterEach(cleanup);

describe('LoopOrdersList', () => {
  it('renders null when the flag is off — no fetch', () => {
    const { container } = render(wrap(<LoopOrdersList enabled={false} />));
    expect(container.innerHTML).toBe('');
    expect(listMock).not.toHaveBeenCalled();
  });

  it('shows the empty state with a browse CTA when there are no orders', async () => {
    listMock.mockResolvedValue({ orders: [] });
    render(wrap(<LoopOrdersList enabled={true} />));
    await waitFor(() => expect(screen.getByText('No orders yet.')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Browse gift cards' })).toBeTruthy();
  });

  it('shows a row per order with merchant + amount + state pill', async () => {
    listMock.mockResolvedValue({
      orders: [
        mkOrder({ id: 'o-1' }),
        mkOrder({ id: 'o-2', state: 'unpaid', faceValueMinor: '2500' }),
      ],
    });
    render(wrap(<LoopOrdersList enabled={true} />));
    await waitFor(() => expect(screen.getAllByText('Target')).toHaveLength(2));
    expect(screen.getByText('$10.00')).toBeTruthy();
    expect(screen.getByText('$25.00')).toBeTruthy();
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.getByText('Waiting for payment')).toBeTruthy();
  });

  it('links each row to the order detail page', async () => {
    listMock.mockResolvedValue({ orders: [mkOrder({ id: 'o-1' })] });
    render(wrap(<LoopOrdersList enabled={true} />));
    const link = await waitFor(() => screen.getByRole('link', { name: /Target/ }));
    expect(link.getAttribute('href')).toBe('/orders/o-1');
  });

  it('keeps the redemption payload off the list', async () => {
    listMock.mockResolvedValue({ orders: [mkOrder({ id: 'o-1' })] });
    render(wrap(<LoopOrdersList enabled={true} />));
    await waitFor(() => screen.getByRole('link', { name: /Target/ }));
    expect(screen.queryByText('GIFT-123')).toBeNull();
    expect(screen.queryByText('4242')).toBeNull();
  });

  it('surfaces earned cashback on the row for fulfilled orders', async () => {
    listMock.mockResolvedValue({
      orders: [mkOrder({ id: 'o-1', state: 'fulfilled', userCashbackMinor: '125' })],
    });
    render(wrap(<LoopOrdersList enabled={true} />));
    await waitFor(() => expect(screen.getByText('+$1.25 cashback')).toBeTruthy());
  });

  it('hides the cashback pill when userCashbackMinor is zero', async () => {
    listMock.mockResolvedValue({ orders: [mkOrder({ id: 'o-1', userCashbackMinor: '0' })] });
    render(wrap(<LoopOrdersList enabled={true} />));
    await waitFor(() => screen.getByRole('link', { name: /Target/ }));
    expect(screen.queryByText(/cashback/)).toBeNull();
  });

  it('hides the cashback pill on an unfulfilled order even if minor is non-zero', async () => {
    listMock.mockResolvedValue({
      orders: [mkOrder({ id: 'o-1', state: 'paid', userCashbackMinor: '125' })],
    });
    render(wrap(<LoopOrdersList enabled={true} />));
    await waitFor(() => screen.getByRole('link', { name: /Target/ }));
    expect(screen.queryByText(/cashback/)).toBeNull();
  });

  it('shows a retry affordance when the list fails to load', async () => {
    listMock.mockRejectedValueOnce(new Error('boom'));
    listMock.mockResolvedValue({ orders: [mkOrder({ id: 'o-1' })] });
    render(wrap(<LoopOrdersList enabled={true} />));
    const retry = await waitFor(() => screen.getByRole('button', { name: 'Retry' }));
    retry.click();
    await waitFor(() => screen.getByRole('link', { name: /Target/ }));
  });

  it('shows the sign-in message on a 401', async () => {
    listMock.mockRejectedValue(new ApiException(401, { code: 'UNAUTHORIZED', message: 'nope' }));
    render(wrap(<LoopOrdersList enabled={true} />));
    await waitFor(() =>
      expect(screen.getByText('Please sign in to view your orders.')).toBeTruthy(),
    );
  });
});
