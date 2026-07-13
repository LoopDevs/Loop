// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type * as OrdersLoopModule from '~/services/orders-loop';
import type * as WalletModule from '~/services/wallet';
import type { CreateLoopOrderResponse, LoopOrderView } from '~/services/orders-loop';
import type { UserWalletResponse } from '~/services/wallet';

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

// NB: `~/native/network` is deliberately NOT mocked — the real web
// `watchNetwork` path (navigator.onLine + online/offline events) is exactly
// what this test exercises, driving the shared `useOnline()` hook end to end.
import { LoopPaymentStep } from '../LoopPaymentStep';

afterEach(() => {
  cleanup();
  // Reset connectivity so an offline case can't leak into the next file/test.
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

beforeEach(() => {
  ordersMock.getLoopOrder.mockReset();
  walletMock.getMyWallet.mockReset();
  walletMock.redeemLoopOrder.mockReset();
  authMock.isAuthenticated = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
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
    assetAmount: null,
    paymentUri: null,
    assetCode: null,
    assetIssuer: null,
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

function mkWallet(overrides: Partial<UserWalletResponse> = {}): UserWalletResponse {
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
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <LoopPaymentStep create={mkCreate()} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const BUTTON_RE = /Pay with Loop balance/;

describe('PayWithLoopBalance — offline gating (FE-43)', () => {
  it('disables the pay button on network loss and re-enables it on reconnect', async () => {
    ordersMock.getLoopOrder.mockResolvedValue(mkOrder());
    walletMock.getMyWallet.mockResolvedValue(mkWallet());
    renderStep();

    const button = await screen.findByRole('button', { name: BUTTON_RE });
    // Baseline: online and covered → enabled.
    expect(button.hasAttribute('disabled')).toBe(false);

    // Go offline: navigator.onLine=false + the browser 'offline' event.
    act(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
      window.dispatchEvent(new Event('offline'));
    });

    // Disabled, with a spoken-aloud reason wired to the button for AT.
    expect(button.hasAttribute('disabled')).toBe(true);
    const hint = screen.getByText(/You.re offline/);
    expect(hint.textContent).toMatch(/reconnect to pay/i);
    expect(button.getAttribute('aria-describedby')).toBe(hint.id);

    // Back online → enabled again, offline hint gone.
    act(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
      window.dispatchEvent(new Event('online'));
    });
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByText(/You.re offline/)).toBeNull();
  });
});
