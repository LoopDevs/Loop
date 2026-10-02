// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type * as OrdersLoopModule from '~/services/orders-loop';
import type * as WebviewModule from '~/native/webview';
import type { LoopOrderView } from '~/services/orders-loop';

const { authMock, getMock, purchaseCompleteMock, openWebViewMock } = vi.hoisted(() => ({
  authMock: { isAuthenticated: true },
  getMock: vi.fn<(id: string) => Promise<LoopOrderView>>(),
  purchaseCompleteMock: vi.fn(),
  openWebViewMock: vi.fn<() => Promise<void>>(),
}));

vi.mock('~/hooks/use-native-platform', () => ({
  useNativePlatform: () => ({ isNative: false }),
}));
vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
}));
vi.mock('~/hooks/use-merchants', () => ({
  useAllMerchants: () => ({ merchants: [{ id: 'm1', name: 'Target', enabled: true }] }),
}));
vi.mock('~/services/orders-loop', async () => {
  const actual = await vi.importActual<typeof OrdersLoopModule>('~/services/orders-loop');
  return { ...actual, getLoopOrder: (id: string) => getMock(id) };
});
vi.mock('~/components/features/Navbar', () => ({ Navbar: () => null }));
vi.mock('~/components/features/cashback/LinkWalletNudge', () => ({ LinkWalletNudge: () => null }));
vi.mock('~/components/features/purchase/PurchaseComplete', () => ({
  PurchaseComplete: (props: Record<string, unknown>) => {
    purchaseCompleteMock(props);
    return <div data-testid="purchase-complete">{String(props['code'])}</div>;
  },
}));
vi.mock('~/native/webview', async () => {
  const actual = await vi.importActual<typeof WebviewModule>('~/native/webview');
  return { ...actual, openWebView: () => openWebViewMock() };
});

import OrderDetailRoute from '../orders.$id';

function mkOrder(overrides: Partial<LoopOrderView> = {}): LoopOrderView {
  return {
    id: 'o-1',
    merchantId: 'm1',
    state: 'fulfilled',
    faceValueMinor: '1000',
    currency: 'USD',
    chargeMinor: '960',
    chargeCurrency: 'USD',
    userCashbackMinor: '40',
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

function renderRoute(id = 'o-1'): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/orders/${id}`]}>
        <Routes>
          <Route path="/orders/:id" element={<OrderDetailRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  authMock.isAuthenticated = true;
  getMock.mockReset();
  purchaseCompleteMock.mockReset();
  openWebViewMock.mockReset();
  openWebViewMock.mockResolvedValue();
});
afterEach(cleanup);

describe('OrderDetailRoute', () => {
  it('reads the Loop order by route id and renders the gift card with the Loop barcode id', async () => {
    getMock.mockResolvedValue(mkOrder());
    renderRoute('o-1');
    await waitFor(() => expect(screen.getByTestId('purchase-complete')).toBeTruthy());
    expect(getMock).toHaveBeenCalledWith('o-1');
    expect(screen.getByRole('heading', { level: 1, name: 'Target' })).toBeTruthy();
    expect(screen.getByText('$10.00')).toBeTruthy();
    expect(purchaseCompleteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantName: 'Target',
        code: 'GIFT-123',
        pin: '4242',
        barcodeOrderId: 'o-1',
      }),
    );
    expect(screen.getByText('$0.40 cashback credited.')).toBeTruthy();
    expect(screen.queryByText('Ready')).toBeNull();
  });

  it('opens a URL-redeem card in the in-app WebView', async () => {
    getMock.mockResolvedValue(
      mkOrder({ redeemCode: null, redeemPin: null, redeemUrl: 'https://redeem.example.com/x' }),
    );
    renderRoute();
    const cta = await waitFor(() => screen.getByRole('button', { name: 'Open redemption page' }));
    cta.click();
    await waitFor(() => expect(openWebViewMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('purchase-complete')).toBeNull();
  });

  it('drops a non-http redeem URL and shows the pending-redemption copy instead', async () => {
    getMock.mockResolvedValue(
      mkOrder({ redeemCode: null, redeemPin: null, redeemUrl: 'javascript:alert(1)' }),
    );
    renderRoute();
    await waitFor(() =>
      expect(screen.getByText(/Redemption details are still coming through/)).toBeTruthy(),
    );
    expect(screen.queryByRole('button', { name: 'Open redemption page' })).toBeNull();
  });

  it('shows the awaiting-payment banner with the charge amount for an unpaid order', async () => {
    getMock.mockResolvedValue(mkOrder({ state: 'unpaid', redeemCode: null, redeemPin: null }));
    renderRoute();
    await waitFor(() => expect(screen.getByText(/Pay \$9\.60 in XLM/)).toBeTruthy());
    expect(screen.getByText('Waiting for payment')).toBeTruthy();
    expect(screen.queryByTestId('purchase-complete')).toBeNull();
  });

  it('shows the failure reason for a rejected order', async () => {
    getMock.mockResolvedValue(
      mkOrder({
        state: 'rejected',
        failureReason: 'Card declined',
        redeemCode: null,
        redeemPin: null,
      }),
    );
    renderRoute();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Card declined'));
  });

  it('shows the signed-out copy and does not fetch when unauthenticated', async () => {
    authMock.isAuthenticated = false;
    renderRoute();
    expect(screen.getByText('Sign in to view this order.')).toBeTruthy();
    expect(getMock).not.toHaveBeenCalled();
  });
});
