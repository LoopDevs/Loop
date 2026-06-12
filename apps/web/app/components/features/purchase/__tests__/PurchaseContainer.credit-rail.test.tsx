// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Merchant } from '@loop/shared';

/**
 * ADR 036 OQ3 (resolved 2026-06-12): the purchase flow's payment-rail
 * picker only offers the `credit` rail (inline mirror debit) to the
 * not-yet-activated migration window. Once the embedded wallet is
 * activated, balance = tokens — spending is token redemption (the
 * PayWithLoopBalance button on the payment screen), and the credit
 * rail disappears (the backend rejects it with CREDIT_METHOD_RETIRED
 * anyway).
 */

const { authState, walletState, userMock } = vi.hoisted(() => ({
  authState: { email: 'a@b.com' as string | null, accessToken: 'tok' as string | null },
  walletState: { isActivated: false },
  userMock: { getMyCredits: vi.fn() },
}));

vi.mock('~/stores/auth.store', () => ({
  useAuthStore: (sel: (s: { email: string | null; accessToken: string | null }) => unknown) =>
    sel({ email: authState.email, accessToken: authState.accessToken }),
}));

vi.mock('~/stores/purchase.store', () => ({
  usePurchaseStore: () => ({
    merchantId: null,
    step: 'amount',
    giftCardCode: null,
    giftCardPin: null,
    barcodeImageUrl: null,
    redeemUrl: null,
    redeemChallengeCode: null,
    redeemScripts: [],
    paymentAddress: null,
    xlmAmount: null,
    orderId: null,
    expiresAt: null,
    memo: null,
    amount: null,
    error: null,
    reset: vi.fn(),
    startPurchase: vi.fn(),
    setAmount: vi.fn(),
    setOrderCreated: vi.fn(),
  }),
}));

vi.mock('~/services/user', () => ({
  getMyCredits: () => userMock.getMyCredits(),
}));
vi.mock('~/services/orders', () => ({ createOrder: vi.fn() }));
vi.mock('~/services/orders-loop', () => ({ createLoopOrder: vi.fn() }));
vi.mock('~/services/auth', () => ({ requestOtp: vi.fn(), verifyOtp: vi.fn() }));

vi.mock('~/hooks/use-app-config', () => ({
  useAppConfig: () => ({
    config: { loopOrdersEnabled: true, phase1Only: false },
    isLoading: false,
  }),
}));
vi.mock('~/hooks/use-merchants', () => ({
  useMerchantCashbackRate: () => ({ userCashbackPct: null }),
}));
vi.mock('~/hooks/use-wallet', () => ({
  WALLET_QUERY_KEY: ['me', 'wallet'],
  useWallet: () => ({
    wallet: undefined,
    isActivated: walletState.isActivated,
    balanceFor: () => '0',
    isLoading: false,
    isError: false,
  }),
}));
vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authState.accessToken !== null }),
}));
vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));
vi.mock('~/native/haptics', () => ({
  triggerHaptic: vi.fn(),
  triggerHapticNotification: vi.fn(),
}));
// The amount grid is not the subject — stub it out.
vi.mock('../AmountSelection', () => ({ AmountSelection: () => null }));

import { PurchaseContainer } from '../PurchaseContainer';

afterEach(cleanup);

beforeEach(() => {
  walletState.isActivated = false;
  userMock.getMyCredits.mockReset();
});

const MERCHANT: Merchant = {
  id: 'm1',
  name: 'Target',
  enabled: true,
} as unknown as Merchant;

function renderContainer(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <PurchaseContainer merchant={MERCHANT} />
    </QueryClientProvider>,
  );
}

describe('PurchaseContainer payment-rail picker — ADR 036 credit gating', () => {
  it('offers the credit rail to a not-yet-activated user with a positive mirror balance', async () => {
    userMock.getMyCredits.mockResolvedValue({
      credits: [{ currency: 'USD', balanceMinor: '5000', updatedAt: new Date().toISOString() }],
    });
    renderContainer();
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Loop credit' })).toBeDefined();
    });
    expect(screen.getByRole('radio', { name: 'USDC' })).toBeDefined();
    expect(screen.getByRole('radio', { name: 'XLM' })).toBeDefined();
  });

  it('hides the credit rail once the wallet is activated (redeem replaces it)', async () => {
    walletState.isActivated = true;
    // Even with a positive mirror balance — the tokens are now the
    // balance; the mirror is reconciliation-only (ADR 036).
    userMock.getMyCredits.mockResolvedValue({
      credits: [{ currency: 'USD', balanceMinor: '5000', updatedAt: new Date().toISOString() }],
    });
    renderContainer();
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'USDC' })).toBeDefined();
    });
    expect(screen.queryByRole('radio', { name: 'Loop credit' })).toBeNull();
  });

  it('hides the credit rail when the mirror balance is zero (nothing to spend on it)', async () => {
    userMock.getMyCredits.mockResolvedValue({
      credits: [{ currency: 'USD', balanceMinor: '0', updatedAt: new Date().toISOString() }],
    });
    renderContainer();
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'USDC' })).toBeDefined();
    });
    expect(screen.queryByRole('radio', { name: 'Loop credit' })).toBeNull();
  });
});
