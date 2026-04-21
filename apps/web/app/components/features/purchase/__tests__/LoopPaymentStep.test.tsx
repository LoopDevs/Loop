// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type * as OrdersLoopModule from '~/services/orders-loop';
const getLoopOrderMock = vi.fn();
vi.mock('~/services/orders-loop', async () => {
  const actual = await vi.importActual<typeof OrdersLoopModule>('~/services/orders-loop');
  return {
    ...actual,
    getLoopOrder: (id: string) => getLoopOrderMock(id),
  };
});

import { LoopPaymentStep } from '../LoopPaymentStep';
import type { CreateLoopOrderResponse, LoopOrderView } from '~/services/orders-loop';

function wrap(ui: React.ReactElement): React.JSX.Element {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

function mkStellarCreate(
  overrides: Partial<CreateLoopOrderResponse['payment']> = {},
): CreateLoopOrderResponse {
  return {
    orderId: '12345678-aaaa-bbbb-cccc-000000000000',
    payment: {
      method: 'usdc',
      stellarAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      memo: 'MEMO-ABCDEFGHIJKLMN',
      amountMinor: '1000',
      currency: 'USD',
      ...overrides,
    } as CreateLoopOrderResponse['payment'],
  };
}

function mkCreditCreate(): CreateLoopOrderResponse {
  return {
    orderId: '12345678-aaaa-bbbb-cccc-000000000000',
    payment: {
      method: 'credit',
      amountMinor: '1000',
      currency: 'USD',
    },
  };
}

function mkOrder(overrides: Partial<LoopOrderView> = {}): LoopOrderView {
  return {
    id: '12345678-aaaa-bbbb-cccc-000000000000',
    merchantId: 'm1',
    state: 'pending_payment',
    faceValueMinor: '1000',
    currency: 'USD',
    paymentMethod: 'usdc',
    paymentMemo: 'MEMO-ABCDEFGHIJKLMN',
    stellarAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
    userCashbackMinor: '50',
    ctxOrderId: null,
    redeemCode: null,
    redeemPin: null,
    redeemUrl: null,
    failureReason: null,
    createdAt: new Date().toISOString(),
    paidAt: null,
    fulfilledAt: null,
    failedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  getLoopOrderMock.mockReset();
});
afterEach(cleanup);

describe('LoopPaymentStep — stellar (xlm/usdc)', () => {
  it('renders the deposit address, memo, and formatted amount', async () => {
    getLoopOrderMock.mockResolvedValue(mkOrder());
    render(wrap(<LoopPaymentStep create={mkStellarCreate()} />));
    await waitFor(() => screen.getByText(/Waiting for payment/i));
    expect(screen.getByText(/GABCDEFGHIJKLMNOPQRSTUVWXYZ234567/)).toBeDefined();
    expect(screen.getByText('MEMO-ABCDEFGHIJKLMN')).toBeDefined();
    // $10.00 USDC
    expect(screen.getByText(/10\.00 USD in USDC/)).toBeDefined();
  });

  it('updates the state label as the order transitions', async () => {
    getLoopOrderMock.mockResolvedValue(
      mkOrder({ state: 'paid', paidAt: new Date().toISOString() }),
    );
    render(wrap(<LoopPaymentStep create={mkStellarCreate()} />));
    await waitFor(() => screen.getByText(/Payment received/i));
  });

  it('shows the failure reason on a failed order', async () => {
    getLoopOrderMock.mockResolvedValue(
      mkOrder({
        state: 'failed',
        failureReason: 'CTX returned 500',
        failedAt: new Date().toISOString(),
      }),
    );
    render(wrap(<LoopPaymentStep create={mkStellarCreate()} />));
    await waitFor(() => screen.getByText('CTX returned 500'));
  });

  it('calls onTerminal exactly once when the state becomes terminal', async () => {
    const spy = vi.fn();
    getLoopOrderMock.mockResolvedValue(
      mkOrder({ state: 'fulfilled', ctxOrderId: 'ctx-abc', fulfilledAt: new Date().toISOString() }),
    );
    render(wrap(<LoopPaymentStep create={mkStellarCreate()} onTerminal={spy} />));
    await waitFor(() => expect(spy).toHaveBeenCalledOnce());
    expect((spy.mock.calls[0]![0] as LoopOrderView).ctxOrderId).toBe('ctx-abc');
  });

  it('copy buttons write to navigator.clipboard', async () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    getLoopOrderMock.mockResolvedValue(mkOrder());
    render(wrap(<LoopPaymentStep create={mkStellarCreate()} />));
    await waitFor(() => screen.getAllByRole('button', { name: /Copy/i }));
    const buttons = screen.getAllByRole('button', { name: /Copy/i });
    await act(async () => {
      fireEvent.click(buttons[0]!);
    });
    expect(writeText).toHaveBeenCalled();
  });
});

describe('LoopPaymentStep — credit', () => {
  it('shows a "no action needed" body and spinner while in flight', async () => {
    getLoopOrderMock.mockResolvedValue(
      mkOrder({ state: 'paid', paymentMethod: 'credit', paymentMemo: null, stellarAddress: null }),
    );
    render(wrap(<LoopPaymentStep create={mkCreditCreate()} />));
    await waitFor(() => screen.getByText(/Loop credit balance/i));
    await waitFor(() => screen.getByText(/Payment received/i));
  });

  it('stops polling once the order is terminal and fires onTerminal', async () => {
    const spy = vi.fn();
    getLoopOrderMock.mockResolvedValue(
      mkOrder({
        state: 'fulfilled',
        paymentMethod: 'credit',
        paymentMemo: null,
        stellarAddress: null,
        ctxOrderId: 'ctx-xyz',
        fulfilledAt: new Date().toISOString(),
      }),
    );
    render(wrap(<LoopPaymentStep create={mkCreditCreate()} onTerminal={spy} />));
    await waitFor(() => expect(spy).toHaveBeenCalledOnce());
  });
});
