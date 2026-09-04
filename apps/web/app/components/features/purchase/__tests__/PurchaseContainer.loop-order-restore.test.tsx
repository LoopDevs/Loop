// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Merchant } from '@loop/shared';
import { ApiException } from '@loop/shared';
import type * as OrdersLoopModule from '~/services/orders-loop';

/**
 * Q6-4 follow-up: the loop-native payment screen (`LoopPaymentStep`)
 * renders from `loopCreate`, ephemeral component-local state in
 * `PurchaseContainer`. It is never re-derived from the server, so ANY
 * remount mid-payment — a re-render that fires the container's
 * `[merchant.id]` cleanup effect, a slow-connection late fetch, a tab
 * refresh — strands the user at the amount-selection form despite a
 * live, payable order existing server-side. This suite proves the
 * restore mechanism (`~/hooks/use-loop-order-restore.ts`) fixes that
 * without regressing Q6-4's first-touch fix.
 *
 * Mocking notes:
 *  - `~/stores/purchase.store` is NOT mocked — the restore mechanism's
 *    correctness depends on the real `startPurchase`/`reset` semantics
 *    (specifically: `isCurrentMerchant` gating survives a remount).
 *  - `AmountSelection` is mocked as a clickable stub (not `() => null`)
 *    so tests can drive `handlePurchase` through the UI.
 */

const { authState, appConfigState } = vi.hoisted(() => ({
  authState: { email: 'a@b.com' as string | null, accessToken: 'tok' as string | null },
  appConfigState: {
    loopOrdersEnabled: true,
    phase1Only: false,
    ctxPaymentCurrencies: ['XLM'] as string[],
  },
}));

vi.mock('~/stores/auth.store', () => ({
  useAuthStore: (sel: (s: { email: string | null; accessToken: string | null }) => unknown) =>
    sel({ email: authState.email, accessToken: authState.accessToken }),
}));

const createLoopOrderMock = vi.fn();
const getLoopOrderMock = vi.fn();
vi.mock('~/services/orders-loop', async () => {
  const actual = await vi.importActual<typeof OrdersLoopModule>('~/services/orders-loop');
  return {
    ...actual,
    createLoopOrder: (...args: unknown[]) => createLoopOrderMock(...args),
    getLoopOrder: (id: string) => getLoopOrderMock(id) as Promise<unknown>,
  };
});

vi.mock('~/services/auth', () => ({ requestOtp: vi.fn(), verifyOtp: vi.fn() }));

vi.mock('~/hooks/use-app-config', () => ({
  useAppConfig: () => ({
    config: {
      loopOrdersEnabled: appConfigState.loopOrdersEnabled,
      phase1Only: appConfigState.phase1Only,
      ctxPaymentCurrencies: appConfigState.ctxPaymentCurrencies,
    },
    isLoading: false,
  }),
}));
vi.mock('~/hooks/use-merchants', () => ({
  useMerchantCashbackRate: () => ({ userCashbackPct: null }),
}));
vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authState.accessToken !== null }),
}));
vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));
vi.mock('~/native/haptics', () => ({
  triggerHaptic: vi.fn(),
  triggerHapticNotification: vi.fn(),
}));
// Clickable stub — real AmountSelection isn't the subject; tests need to
// be able to trigger `onConfirm` to drive order creation.
vi.mock('../AmountSelection', () => ({
  AmountSelection: ({ onConfirm }: { onConfirm: (amount: number) => void }) => (
    <button type="button" onClick={() => onConfirm(10)}>
      confirm-amount
    </button>
  ),
}));

import { PurchaseContainer } from '../PurchaseContainer';
import { usePurchaseStore } from '~/stores/purchase.store';
import { loadPendingOrder, LOOP_NATIVE_PENDING_ORDER_KEY } from '~/native/purchase-storage';
import type { CreateLoopOrderResponse, LoopOrderView } from '~/services/orders-loop';

const MERCHANT: Merchant = {
  id: 'm1',
  name: 'Target',
  enabled: true,
  denominations: { type: 'min-max', denominations: [], currency: 'USD' },
} as unknown as Merchant;

const ADDRESS = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';
const SERVER_CRYPTO_AMOUNT = '10.0000000';
const SERVER_PAYMENT_URI = `web+stellar:pay?destination=${ADDRESS}&amount=${SERVER_CRYPTO_AMOUNT}`;

function mkPayment(): CreateLoopOrderResponse['payment'] {
  return {
    ctxPaymentId: 'pay-1',
    cryptoCurrency: 'XLM',
    cryptoAmount: SERVER_CRYPTO_AMOUNT,
    address: ADDRESS,
    paymentUrls: { XLM: SERVER_PAYMENT_URI },
    amountMinor: '1000',
    currency: 'USD',
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

function mkCreateResponse(): CreateLoopOrderResponse {
  return {
    orderId: '12345678-aaaa-bbbb-cccc-000000000000',
    state: 'unpaid',
    payment: mkPayment(),
  };
}

/** The server GET response. Q6-4b: still-unpaid orders carry CTX's
 *  payment instructions; the restore rebuilds the pay screen ENTIRELY
 *  from these. */
function mkOrderView(overrides: Partial<LoopOrderView> = {}): LoopOrderView {
  return {
    id: '12345678-aaaa-bbbb-cccc-000000000000',
    merchantId: 'm1',
    state: 'unpaid',
    faceValueMinor: '1000',
    currency: 'USD',
    chargeMinor: '1000',
    chargeCurrency: 'USD',
    userCashbackMinor: '0',
    ctxOrderId: null,
    paymentCryptoCurrency: 'XLM',
    payment: mkPayment(),
    redeemCode: null,
    redeemPin: null,
    redeemUrl: null,
    failureReason: null,
    createdAt: new Date().toISOString(),
    fulfilledAt: null,
    failedAt: null,
    ...overrides,
  };
}

function renderContainer(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PurchaseContainer merchant={MERCHANT} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  authState.email = 'a@b.com';
  authState.accessToken = 'tok';
  appConfigState.loopOrdersEnabled = true;
  appConfigState.phase1Only = false;
  appConfigState.ctxPaymentCurrencies = ['XLM'];
  createLoopOrderMock.mockReset();
  getLoopOrderMock.mockReset();
  usePurchaseStore.getState().reset();
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe('loop-native order restore across a remount', () => {
  it('first-touch: creating an order shows the payment step immediately (Q6-4 regression guard)', async () => {
    createLoopOrderMock.mockResolvedValue(mkCreateResponse());
    getLoopOrderMock.mockResolvedValue(mkOrderView());
    renderContainer();

    fireEvent.click(await screen.findByText('confirm-amount'));

    await waitFor(() => {
      expect(screen.getByText(/Order 12345678/i)).toBeDefined();
    });
    expect(createLoopOrderMock).toHaveBeenCalledTimes(1);
  });

  it('remount mid-payment: the payment step re-renders from the server instead of falling back to amount selection', async () => {
    createLoopOrderMock.mockResolvedValue(mkCreateResponse());
    getLoopOrderMock.mockResolvedValue(mkOrderView());
    const first = renderContainer();

    fireEvent.click(await screen.findByText('confirm-amount'));
    await waitFor(() => screen.getByText(/Order 12345678/i));

    // Wait for the fire-and-forget persist to actually land before
    // simulating the remount — otherwise this races the real save.
    await waitFor(async () => {
      expect(await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)).not.toBeNull();
    });

    getLoopOrderMock.mockClear();
    first.unmount();

    // Fresh mount — new QueryClient too, so nothing survives via the
    // react-query cache. If this shows the payment step, it's because
    // the restore mechanism re-derived it, not because of stale cache.
    renderContainer();

    await waitFor(() => {
      expect(screen.getByText(/Order 12345678/i)).toBeDefined();
    });
    // The rendered pay screen is built from the SERVER GET response.
    expect(screen.getByText(new RegExp(`${SERVER_CRYPTO_AMOUNT} XLM`))).toBeDefined();
    expect(screen.getByRole('link', { name: /Open in wallet/i }).getAttribute('href')).toBe(
      SERVER_PAYMENT_URI,
    );
    // Read-only: restoring never re-creates the order.
    expect(createLoopOrderMock).toHaveBeenCalledTimes(1);
    expect(getLoopOrderMock).toHaveBeenCalledWith('12345678-aaaa-bbbb-cccc-000000000000');
  });

  it('SERVER-AUTHORITATIVE: a tampered persisted blob (100x amount + poisoned deep-link) is IGNORED — the pay screen renders the SERVER values', async () => {
    // Proves the Q6-4b P1 fix. Against the pre-fix blob-trusting code this
    // test FAILS: that code read the persisted `create` blob directly and
    // rendered its 100x amount + attacker paymentUri (the tampered blob
    // below keeps destination+memo correct, which is all the old
    // cross-check validated — it never checked the *amount*). The new
    // pointer-only + server-rebuild code ignores the blob entirely, so the
    // screen shows the server's real $10.00 / 10.0000000 USDC and the real
    // deposit deep-link.
    sessionStorage.setItem(
      LOOP_NATIVE_PENDING_ORDER_KEY,
      JSON.stringify({
        merchantId: 'm1',
        orderId: '12345678-aaaa-bbbb-cccc-000000000000',
        savedAt: Math.floor(Date.now() / 1000),
        expiresAt: Math.floor(Date.now() / 1000) + 20 * 60,
        // Attacker-injected payment blob (old storage shape):
        create: {
          orderId: '12345678-aaaa-bbbb-cccc-000000000000',
          payment: {
            cryptoCurrency: 'XLM',
            cryptoAmount: '1000.0000000', // 100x
            address: ADDRESS,
            amountMinor: '100000', // 100x
            currency: 'USD',
            paymentUrls: {
              XLM: `web+stellar:pay?destination=${ADDRESS}&amount=1000.0000000`,
            },
          },
        },
      }),
    );
    getLoopOrderMock.mockResolvedValue(mkOrderView());
    renderContainer();

    await waitFor(() => {
      expect(screen.getByText(/Order 12345678/i)).toBeDefined();
    });
    // Server-authoritative amount + deep-link, NOT the tampered blob's.
    expect(screen.getByText(new RegExp(`${SERVER_CRYPTO_AMOUNT} XLM`))).toBeDefined();
    expect(screen.queryByText(/1000\.0000000 XLM/)).toBeNull();
    expect(screen.getByText(/\$10\.00/)).toBeDefined();
    expect(screen.queryByText(/\$1,000\.00/)).toBeNull();
    expect(screen.getByRole('link', { name: /Open in wallet/i }).getAttribute('href')).toBe(
      SERVER_PAYMENT_URI,
    );
    // No new order was created by the restore.
    expect(createLoopOrderMock).not.toHaveBeenCalled();
  });

  it('terminal order (expired): clears the persisted record and falls back to the normal amount-selection flow', async () => {
    createLoopOrderMock.mockResolvedValue(mkCreateResponse());
    getLoopOrderMock.mockResolvedValue(mkOrderView());
    const first = renderContainer();
    fireEvent.click(await screen.findByText('confirm-amount'));
    await waitFor(() => screen.getByText(/Order 12345678/i));
    await waitFor(async () => {
      expect(await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)).not.toBeNull();
    });
    first.unmount();

    getLoopOrderMock.mockReset();
    getLoopOrderMock.mockResolvedValue(mkOrderView({ state: 'expired' }));
    renderContainer();

    await waitFor(() => {
      expect(screen.getByText('confirm-amount')).toBeDefined();
    });
    expect(screen.queryByText(/Order 12345678/i)).toBeNull();
    await waitFor(async () => {
      expect(await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)).toBeNull();
    });
    expect(createLoopOrderMock).toHaveBeenCalledTimes(1);
  });

  it('fulfilled order: clears the persisted record (so a LATER remount does not try to resurrect it) while this tab keeps showing "Ready"', async () => {
    createLoopOrderMock.mockResolvedValue(mkCreateResponse());
    // Resolves fulfilled from the very first poll — this test is about
    // `onTerminal` clearing the persisted record for EVERY terminal
    // state (not just failed/expired), not about the pending→fulfilled
    // transition (covered by LoopPaymentStep.test.tsx already). The
    // create-time `saveLoopPendingOrder` call and this terminal-time
    // `clearLoopPendingOrder` call race through the same persist queue
    // (see use-loop-order-restore.ts) — this exercises that ordering.
    getLoopOrderMock.mockResolvedValue(mkOrderView({ state: 'fulfilled', ctxOrderId: 'ctx-1' }));
    renderContainer();
    fireEvent.click(await screen.findByText('confirm-amount'));

    // Still on the payment screen (now showing "Ready") — fulfilled
    // doesn't kick the user off the screen they're looking at.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Ready' })).toBeDefined());
    await waitFor(async () => {
      expect(await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)).toBeNull();
    });
  });

  it('404 on restore (order not found / different session): clears the persisted record, does not crash, and shows the normal flow', async () => {
    createLoopOrderMock.mockResolvedValue(mkCreateResponse());
    getLoopOrderMock.mockResolvedValue(mkOrderView());
    const first = renderContainer();
    fireEvent.click(await screen.findByText('confirm-amount'));
    await waitFor(() => screen.getByText(/Order 12345678/i));
    await waitFor(async () => {
      expect(await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)).not.toBeNull();
    });
    first.unmount();

    getLoopOrderMock.mockReset();
    getLoopOrderMock.mockRejectedValue(
      new ApiException(404, { code: 'NOT_FOUND', message: 'nope' }),
    );
    renderContainer();

    await waitFor(() => {
      expect(screen.getByText('confirm-amount')).toBeDefined();
    });
    expect(screen.queryByText(/Order 12345678/i)).toBeNull();
    await waitFor(async () => {
      expect(await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)).toBeNull();
    });
    expect(createLoopOrderMock).toHaveBeenCalledTimes(1);
  });

  it('no persisted order: mounts straight into the normal amount-selection flow (the common case, no restore attempted)', async () => {
    renderContainer();
    await waitFor(() => {
      expect(screen.getByText('confirm-amount')).toBeDefined();
    });
    expect(getLoopOrderMock).not.toHaveBeenCalled();
  });
});
