// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Merchant } from '@loop/shared';

/**
 * ADR 042 (B-2): runtime DOM a11y smoke test for the purchase flow's
 * inline-auth screen (the unauthenticated entry point — the highest-traffic
 * state for a first-time buyer). Mocking mirrors
 * PurchaseContainer.credit-rail.test.tsx's established pattern.
 */

expect.extend(toHaveNoViolations);

afterEach(cleanup);

const { authState, walletState, userMock } = vi.hoisted(() => ({
  authState: { email: null as string | null, accessToken: null as string | null },
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

vi.mock('~/services/user', () => ({ getMyCredits: () => userMock.getMyCredits() }));
vi.mock('~/services/orders', () => ({ createOrder: vi.fn() }));
vi.mock('~/services/orders-loop', () => ({ createLoopOrder: vi.fn() }));
vi.mock('~/services/auth', () => ({ requestOtp: vi.fn(), verifyOtp: vi.fn() }));
vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));
vi.mock('~/native/haptics', () => ({
  triggerHaptic: vi.fn(),
  triggerHapticNotification: vi.fn(),
}));

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
// The amount grid isn't reachable in the unauthenticated render — not the
// subject of this test either way.
vi.mock('../AmountSelection', () => ({ AmountSelection: () => null }));

import { PurchaseContainer } from '../PurchaseContainer';

const MERCHANT: Merchant = {
  id: 'm1',
  name: 'Target',
  enabled: true,
} as unknown as Merchant;

function renderContainer(): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PurchaseContainer merchant={MERCHANT} />
    </QueryClientProvider>,
  );
}

describe('<PurchaseContainer /> a11y', () => {
  it('has no axe violations at WCAG 2.1 A/AA on the signed-out inline-auth form', async () => {
    const { container } = renderContainer();
    await waitFor(() => {
      expect(screen.getByLabelText(/email address/i)).toBeDefined();
    });
    const results = await axe(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    expect(results).toHaveNoViolations();
  });
});
