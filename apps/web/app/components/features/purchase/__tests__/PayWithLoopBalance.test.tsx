// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';

import type * as OrdersLoopModule from '~/services/orders-loop';
import type * as WalletModule from '~/services/wallet';
import type { CreateLoopOrderResponse, LoopOrderView } from '~/services/orders-loop';
import type { MeWalletResponse } from '~/services/wallet';

const { ordersMock, walletMock, authMock } = vi.hoisted(() => ({
  ordersMock: { getLoopOrder: vi.fn() },
  walletMock: { getMyWallet: vi.fn(), redeemLoopOrder: vi.fn() },
  authMock: { isAuthenticated: true },
}));

vi.mock('~/services/orders-loop', async () => {
  const actual = await vi.importActual<typeof OrdersLoopModule>('~/services/orders-loop');
  return {
    ...actual,
    getLoopOrder: (id: string) => ordersMock.getLoopOrder(id),
  };
});

// Keep the pure cover-math helpers real — they're part of what's
// under test — and mock only the network-touching fetchers.
vi.mock('~/services/wallet', async () => {
  const actual = await vi.importActual<typeof WalletModule>('~/services/wallet');
  return {
    ...actual,
    getMyWallet: () => walletMock.getMyWallet(),
    redeemLoopOrder: (orderId: string) => walletMock.redeemLoopOrder(orderId),
  };
});

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
}));

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

import { LoopPaymentStep } from '../LoopPaymentStep';

afterEach(cleanup);

beforeEach(() => {
  ordersMock.getLoopOrder.mockReset();
  walletMock.getMyWallet.mockReset();
  walletMock.redeemLoopOrder.mockReset();
  authMock.isAuthenticated = true;
});

const ORDER_ID = '12345678-aaaa-bbbb-cccc-000000000000';

function mkCreate(): CreateLoopOrderResponse {
  return {
    orderId: ORDER_ID,
    payment: {
      method: 'usdc',
      stellarAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      memo: 'MEMO-ABCDEFGHIJKLMN',
      amountMinor: '1000',
      currency: 'USD',
      assetAmount: '10.0000000',
      paymentUri: 'web+stellar:pay?destination=G...&amount=10.0000000',
    },
  };
}

function mkOrder(overrides: Partial<LoopOrderView> = {}): LoopOrderView {
  return {
    id: ORDER_ID,
    merchantId: 'm-1',
    state: 'pending_payment',
    faceValueMinor: '1000',
    currency: 'USD',
    chargeMinor: '1000',
    chargeCurrency: 'USD',
    paymentMethod: 'usdc',
    paymentMemo: 'MEMO-ABCDEFGHIJKLMN',
    stellarAddress: null,
    userCashbackMinor: '0',
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

function mkWallet(overrides: Partial<MeWalletResponse> = {}): MeWalletResponse {
  return {
    address: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
    provisioning: 'activated',
    balances: [{ assetCode: 'USDLOOP', balance: '50.0000000' }],
    interestApyBps: 300,
    stale: false,
    ...overrides,
  };
}

function renderStep(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={qc}>
      <LoopPaymentStep create={mkCreate()} />
    </QueryClientProvider>,
  );
}

const BUTTON_RE = /Pay with Loop balance/;

describe('PayWithLoopBalance (via LoopPaymentStep)', () => {
  it('offers the one-tap button when the matching-asset balance covers the charge', async () => {
    ordersMock.getLoopOrder.mockResolvedValue(mkOrder());
    walletMock.getMyWallet.mockResolvedValue(mkWallet());
    renderStep();
    const button = await screen.findByRole('button', { name: BUTTON_RE });
    expect(button.hasAttribute('disabled')).toBe(false);
    // Charge rendered as plain fiat, no asset-code jargon.
    expect(button.textContent).toMatch(/\$10\.00/);
    expect(button.textContent).not.toMatch(/USDLOOP/);
    // The crypto path stays available alongside.
    expect(screen.getByText('Open in wallet')).toBeDefined();
  });

  it('disables the button with the shortfall spelled out when the balance is non-zero but short', async () => {
    ordersMock.getLoopOrder.mockResolvedValue(mkOrder());
    walletMock.getMyWallet.mockResolvedValue(
      mkWallet({ balances: [{ assetCode: 'USDLOOP', balance: '5.0000000' }] }),
    );
    renderStep();
    const button = await screen.findByRole('button', { name: BUTTON_RE });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/Not enough Loop balance/).textContent).toMatch(/\$5\.00/);
  });

  it('hides the button entirely when there is no matching-asset balance', async () => {
    ordersMock.getLoopOrder.mockResolvedValue(mkOrder());
    walletMock.getMyWallet.mockResolvedValue(mkWallet({ balances: [] }));
    renderStep();
    // Wait for both queries to settle, then assert absence.
    await waitFor(() => {
      expect(walletMock.getMyWallet).toHaveBeenCalled();
      expect(screen.getByText('Open in wallet')).toBeDefined();
    });
    expect(screen.queryByRole('button', { name: BUTTON_RE })).toBeNull();
  });

  it('hides the button while the wallet is still provisioning', async () => {
    ordersMock.getLoopOrder.mockResolvedValue(mkOrder());
    walletMock.getMyWallet.mockResolvedValue(
      mkWallet({ provisioning: 'wallet_created', address: null }),
    );
    renderStep();
    await waitFor(() => {
      expect(screen.getByText('Open in wallet')).toBeDefined();
    });
    expect(screen.queryByRole('button', { name: BUTTON_RE })).toBeNull();
  });

  it('hides the button once the order has left pending_payment', async () => {
    ordersMock.getLoopOrder.mockResolvedValue(mkOrder({ state: 'paid' }));
    walletMock.getMyWallet.mockResolvedValue(mkWallet());
    renderStep();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Payment received' })).toBeDefined();
    });
    expect(screen.queryByRole('button', { name: BUTTON_RE })).toBeNull();
  });

  it('tap → POSTs with the order id and the SAME polling query advances the state', async () => {
    ordersMock.getLoopOrder.mockResolvedValue(mkOrder());
    walletMock.getMyWallet.mockResolvedValue(mkWallet());
    walletMock.redeemLoopOrder.mockImplementation(() => {
      // From here the watcher (mocked: the next poll) reports paid —
      // exactly what the crypto path would see after a deposit.
      ordersMock.getLoopOrder.mockResolvedValue(mkOrder({ state: 'paid' }));
      return Promise.resolve({ state: 'paid' });
    });
    renderStep();
    const button = await screen.findByRole('button', { name: BUTTON_RE });
    fireEvent.click(button);
    await waitFor(() => {
      expect(walletMock.redeemLoopOrder).toHaveBeenCalledWith(ORDER_ID);
    });
    // The redeem path invalidates ['loop-order', id], so the
    // existing poll refetches immediately and the shared state machine
    // moves to "Payment received" without any forked polling logic.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Payment received' })).toBeDefined();
    });
    expect(ordersMock.getLoopOrder.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('double-tap fires a single POST (in-flight guard)', async () => {
    ordersMock.getLoopOrder.mockResolvedValue(mkOrder());
    walletMock.getMyWallet.mockResolvedValue(mkWallet());
    let release: (v: { state: string }) => void = () => {};
    walletMock.redeemLoopOrder.mockImplementation(
      () =>
        new Promise<{ state: string }>((resolve) => {
          release = resolve;
        }),
    );
    renderStep();
    const button = await screen.findByRole('button', { name: BUTTON_RE });
    fireEvent.click(button);
    fireEvent.click(button);
    release({ state: 'paid' });
    await waitFor(() => {
      expect(walletMock.redeemLoopOrder).toHaveBeenCalledTimes(1);
    });
  });

  it('surfaces a banner (keeping the crypto path) on 400 INSUFFICIENT_BALANCE', async () => {
    ordersMock.getLoopOrder.mockResolvedValue(mkOrder());
    walletMock.getMyWallet.mockResolvedValue(mkWallet());
    walletMock.redeemLoopOrder.mockRejectedValue(
      new ApiException(400, { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient balance' }),
    );
    renderStep();
    fireEvent.click(await screen.findByRole('button', { name: BUTTON_RE }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/doesn.t cover this order/);
    });
    expect(screen.getByText('Open in wallet')).toBeDefined();
  });

  it('surfaces a temporary-unavailability banner on 503', async () => {
    ordersMock.getLoopOrder.mockResolvedValue(mkOrder());
    walletMock.getMyWallet.mockResolvedValue(mkWallet());
    walletMock.redeemLoopOrder.mockRejectedValue(
      new ApiException(503, { code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable' }),
    );
    renderStep();
    fireEvent.click(await screen.findByRole('button', { name: BUTTON_RE }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/isn.t available right now/);
    });
    expect(screen.getByText('Open in wallet')).toBeDefined();
  });
});
