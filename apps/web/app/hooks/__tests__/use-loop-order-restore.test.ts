// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { ApiException } from '@loop/shared';
import type * as OrdersLoopModule from '~/services/orders-loop';
import type { LoopOrderView } from '~/services/orders-loop';

const getLoopOrderMock = vi.fn();
vi.mock('~/services/orders-loop', async () => {
  const actual = await vi.importActual<typeof OrdersLoopModule>('~/services/orders-loop');
  return {
    ...actual,
    getLoopOrder: (id: string) => getLoopOrderMock(id) as Promise<LoopOrderView>,
  };
});

import {
  useLoopOrderRestore,
  saveLoopPendingOrder,
  clearLoopPendingOrder,
  validatePersistedLoopOrder,
  loopOrderViewToCreate,
  LOOP_PENDING_ORDER_TTL_SECONDS,
} from '../use-loop-order-restore';
import {
  LOOP_NATIVE_PENDING_ORDER_KEY,
  savePendingOrder,
  loadPendingOrder,
} from '~/native/purchase-storage';

const MERCHANT_ID = 'm1';
const ORDER_ID = '12345678-aaaa-bbbb-cccc-000000000000';
const STELLAR_ADDRESS = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';
const PAYMENT_MEMO = 'MEMO-ABCDEFGHIJKLMN';
// The server-authoritative payment guidance a pending usdc order returns.
const SERVER_ASSET_AMOUNT = '10.0000000';
const SERVER_PAYMENT_URI = `web+stellar:pay?destination=${STELLAR_ADDRESS}&amount=${SERVER_ASSET_AMOUNT}&memo=${PAYMENT_MEMO}&memo_type=MEMO_TEXT&asset_code=USDC`;

/** A server `LoopOrderView` for a pending usdc order, with the Q6-4b
 *  server-derived payment-guidance fields populated. */
function mkOrder(overrides: Partial<LoopOrderView> = {}): LoopOrderView {
  return {
    id: ORDER_ID,
    merchantId: MERCHANT_ID,
    state: 'pending_payment',
    faceValueMinor: '1000',
    currency: 'USD',
    chargeMinor: '1000',
    chargeCurrency: 'USD',
    paymentMethod: 'usdc',
    paymentMemo: PAYMENT_MEMO,
    stellarAddress: STELLAR_ADDRESS,
    assetAmount: SERVER_ASSET_AMOUNT,
    paymentUri: SERVER_PAYMENT_URI,
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

/** Seeds a persisted record directly. `extra` lets a test simulate a
 *  TAMPERED record that carries attacker-injected payment fields on top
 *  of the pointer — the restore must ignore them entirely. */
async function seedPointer(
  overrides: { merchantId?: string; orderId?: string; savedAt?: number } = {},
  extra: Record<string, unknown> = {},
): Promise<void> {
  await savePendingOrder(
    {
      merchantId: MERCHANT_ID,
      orderId: ORDER_ID,
      savedAt: Math.floor(Date.now() / 1000),
      ...overrides,
      ...extra,
    },
    LOOP_NATIVE_PENDING_ORDER_KEY,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  getLoopOrderMock.mockReset();
});
afterEach(() => {
  sessionStorage.clear();
});

describe('validatePersistedLoopOrder (pointer-only)', () => {
  it('accepts a well-formed pointer scoped to the expected merchant', () => {
    const now = Math.floor(Date.now() / 1000);
    const result = validatePersistedLoopOrder(
      { merchantId: MERCHANT_ID, orderId: ORDER_ID, savedAt: now },
      MERCHANT_ID,
    );
    expect(result).toEqual({ merchantId: MERCHANT_ID, orderId: ORDER_ID });
  });

  it('IGNORES extra tampered keys — returns only the pointer, never a payment blob', () => {
    const now = Math.floor(Date.now() / 1000);
    const result = validatePersistedLoopOrder(
      {
        merchantId: MERCHANT_ID,
        orderId: ORDER_ID,
        savedAt: now,
        // Attacker-injected junk that must never be read:
        create: {
          payment: {
            assetAmount: '999999.0000000',
            paymentUri: 'web+stellar:pay?destination=GEVIL',
          },
        },
      },
      MERCHANT_ID,
    );
    expect(result).toEqual({ merchantId: MERCHANT_ID, orderId: ORDER_ID });
    expect(result).not.toHaveProperty('create');
  });

  it('rejects a pointer for a different merchant', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(
      validatePersistedLoopOrder(
        { merchantId: 'other', orderId: ORDER_ID, savedAt: now },
        MERCHANT_ID,
      ),
    ).toBeNull();
  });

  it('rejects an expired (past-TTL) pointer', () => {
    const savedAt = Math.floor(Date.now() / 1000) - LOOP_PENDING_ORDER_TTL_SECONDS - 1;
    expect(
      validatePersistedLoopOrder(
        { merchantId: MERCHANT_ID, orderId: ORDER_ID, savedAt },
        MERCHANT_ID,
      ),
    ).toBeNull();
  });

  it('rejects malformed payloads', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(validatePersistedLoopOrder(null, MERCHANT_ID)).toBeNull();
    expect(validatePersistedLoopOrder('nope', MERCHANT_ID)).toBeNull();
    expect(
      validatePersistedLoopOrder({ merchantId: MERCHANT_ID, savedAt: now }, MERCHANT_ID),
    ).toBeNull();
    expect(
      validatePersistedLoopOrder({ merchantId: MERCHANT_ID, orderId: ORDER_ID }, MERCHANT_ID),
    ).toBeNull();
  });
});

describe('loopOrderViewToCreate (server-authoritative rebuild)', () => {
  it('builds a usdc create purely from the server view', () => {
    const create = loopOrderViewToCreate(mkOrder());
    expect(create).not.toBeNull();
    expect(create!.orderId).toBe(ORDER_ID);
    expect(create!.payment).toMatchObject({
      method: 'usdc',
      stellarAddress: STELLAR_ADDRESS,
      memo: PAYMENT_MEMO,
      amountMinor: '1000',
      currency: 'USD',
      assetAmount: SERVER_ASSET_AMOUNT,
      paymentUri: SERVER_PAYMENT_URI,
    });
  });

  it('builds a credit create (no stellar fields needed)', () => {
    const create = loopOrderViewToCreate(
      mkOrder({
        paymentMethod: 'credit',
        stellarAddress: null,
        paymentMemo: null,
        assetAmount: null,
        paymentUri: null,
      }),
    );
    expect(create).not.toBeNull();
    expect(create!.payment).toEqual({ method: 'credit', amountMinor: '1000', currency: 'USD' });
  });

  it('builds a loop_asset create with the server assetCode/assetIssuer', () => {
    const create = loopOrderViewToCreate(
      mkOrder({ paymentMethod: 'loop_asset', assetCode: 'USDLOOP', assetIssuer: 'GISSUER' }),
    );
    expect(create).not.toBeNull();
    expect(create!.payment).toMatchObject({
      method: 'loop_asset',
      assetCode: 'USDLOOP',
      assetIssuer: 'GISSUER',
      assetAmount: SERVER_ASSET_AMOUNT,
    });
  });

  it('returns null when an on-chain order is missing server-derived guidance', () => {
    expect(loopOrderViewToCreate(mkOrder({ assetAmount: null }))).toBeNull();
    expect(loopOrderViewToCreate(mkOrder({ paymentUri: null }))).toBeNull();
    expect(loopOrderViewToCreate(mkOrder({ stellarAddress: null }))).toBeNull();
  });

  it('returns null for a loop_asset order missing assetCode/assetIssuer', () => {
    expect(
      loopOrderViewToCreate(
        mkOrder({ paymentMethod: 'loop_asset', assetCode: null, assetIssuer: null }),
      ),
    ).toBeNull();
  });
});

describe('useLoopOrderRestore', () => {
  it('stays null when no pointer exists (the common case)', async () => {
    const { result } = renderHook(() =>
      useLoopOrderRestore({ merchantId: MERCHANT_ID, enabled: true }),
    );
    await waitFor(() => expect(getLoopOrderMock).not.toHaveBeenCalled());
    expect(result.current.restored).toBeNull();
  });

  it('does nothing while disabled — never fires the GET', async () => {
    await seedPointer();
    renderHook(() => useLoopOrderRestore({ merchantId: MERCHANT_ID, enabled: false }));
    await new Promise((r) => setTimeout(r, 20));
    expect(getLoopOrderMock).not.toHaveBeenCalled();
  });

  it('restores a pending order, rebuilt entirely from the server (read-only — one GET, no POST)', async () => {
    await seedPointer();
    getLoopOrderMock.mockResolvedValue(mkOrder());
    const { result } = renderHook(() =>
      useLoopOrderRestore({ merchantId: MERCHANT_ID, enabled: true }),
    );
    await waitFor(() => expect(result.current.restored).not.toBeNull());
    expect(result.current.restored!.create.payment).toMatchObject({
      assetAmount: SERVER_ASSET_AMOUNT,
      paymentUri: SERVER_PAYMENT_URI,
    });
    expect(getLoopOrderMock).toHaveBeenCalledWith(ORDER_ID);
    expect(getLoopOrderMock).toHaveBeenCalledTimes(1);
  });

  it('TAMPER-IGNORED: a persisted record with attacker-injected amount/asset/paymentUri is ignored — the restore uses the SERVER values', async () => {
    // Simulate an attacker (XSS / malicious extension / device compromise)
    // who inflated the stored blob's amount 100x, swapped the asset, and
    // poisoned the SEP-7 deep-link to their own address. The pointer's
    // orderId is left correct.
    await seedPointer(
      {},
      {
        create: {
          orderId: ORDER_ID,
          payment: {
            method: 'usdc',
            stellarAddress: STELLAR_ADDRESS,
            memo: PAYMENT_MEMO,
            amountMinor: '100000', // 100x
            currency: 'USD',
            assetAmount: '1000.0000000', // 100x
            paymentUri:
              'web+stellar:pay?destination=GATTACKERADDRESS&amount=1000.0000000&memo=MEMO-ABCDEFGHIJKLMN',
          },
        },
      },
    );
    getLoopOrderMock.mockResolvedValue(mkOrder());
    const { result } = renderHook(() =>
      useLoopOrderRestore({ merchantId: MERCHANT_ID, enabled: true }),
    );
    await waitFor(() => expect(result.current.restored).not.toBeNull());
    const payment = result.current.restored!.create.payment as {
      assetAmount: string;
      amountMinor: string;
      paymentUri: string;
    };
    // Server-authoritative values, NOT the tampered blob's 100x figures.
    expect(payment.assetAmount).toBe(SERVER_ASSET_AMOUNT);
    expect(payment.amountMinor).toBe('1000');
    expect(payment.paymentUri).toBe(SERVER_PAYMENT_URI);
    expect(payment.paymentUri).not.toContain('GATTACKERADDRESS');
  });

  it('also restores while the order is paid/procuring (still non-terminal)', async () => {
    await seedPointer();
    getLoopOrderMock.mockResolvedValue(mkOrder({ state: 'procuring' }));
    const { result } = renderHook(() =>
      useLoopOrderRestore({ merchantId: MERCHANT_ID, enabled: true }),
    );
    await waitFor(() => expect(result.current.restored).not.toBeNull());
  });

  it('does not restore a pointer scoped to a different merchant (no GET fired)', async () => {
    await seedPointer();
    const { result } = renderHook(() =>
      useLoopOrderRestore({ merchantId: 'a-different-merchant', enabled: true }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.restored).toBeNull();
    expect(getLoopOrderMock).not.toHaveBeenCalled();
  });

  it('clears the pointer and does not restore a fulfilled order', async () => {
    await seedPointer();
    getLoopOrderMock.mockResolvedValue(mkOrder({ state: 'fulfilled' }));
    const { result } = renderHook(() =>
      useLoopOrderRestore({ merchantId: MERCHANT_ID, enabled: true }),
    );
    await waitFor(async () => {
      expect(await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)).toBeNull();
    });
    expect(result.current.restored).toBeNull();
  });

  it('clears the pointer on a 404 (order not found / not owned / tampered id) without crashing', async () => {
    await seedPointer();
    getLoopOrderMock.mockRejectedValue(
      new ApiException(404, { code: 'NOT_FOUND', message: 'nope' }),
    );
    const { result } = renderHook(() =>
      useLoopOrderRestore({ merchantId: MERCHANT_ID, enabled: true }),
    );
    await waitFor(async () => {
      expect(await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)).toBeNull();
    });
    expect(result.current.restored).toBeNull();
  });

  it('clears the pointer on a 403 without crashing', async () => {
    await seedPointer();
    getLoopOrderMock.mockRejectedValue(new ApiException(403, { code: 'FORBIDDEN', message: 'no' }));
    const { result } = renderHook(() =>
      useLoopOrderRestore({ merchantId: MERCHANT_ID, enabled: true }),
    );
    await waitFor(async () => {
      expect(await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)).toBeNull();
    });
    expect(result.current.restored).toBeNull();
  });

  it('leaves the pointer alone on a transient 500 — a future remount retries', async () => {
    await seedPointer();
    getLoopOrderMock.mockRejectedValue(
      new ApiException(500, { code: 'INTERNAL_ERROR', message: 'blip' }),
    );
    const { result } = renderHook(() =>
      useLoopOrderRestore({ merchantId: MERCHANT_ID, enabled: true }),
    );
    await waitFor(() => expect(getLoopOrderMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.restored).toBeNull();
    expect(await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)).not.toBeNull();
  });

  it("does not restore (or clobber) when the server can't derive on-chain guidance (oracle down → null fields)", async () => {
    await seedPointer();
    getLoopOrderMock.mockResolvedValue(mkOrder({ assetAmount: null, paymentUri: null }));
    const { result } = renderHook(() =>
      useLoopOrderRestore({ merchantId: MERCHANT_ID, enabled: true }),
    );
    await waitFor(() => expect(getLoopOrderMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.restored).toBeNull();
    // Pointer retained so a later remount retries once the oracle recovers.
    expect(await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)).not.toBeNull();
  });

  it('does not clobber a FRESHER pointer that appeared while the restore GET was in flight', async () => {
    await seedPointer();
    let resolveGet!: (order: LoopOrderView) => void;
    getLoopOrderMock.mockImplementation(
      () => new Promise<LoopOrderView>((resolve) => (resolveGet = resolve)),
    );
    const { result } = renderHook(() =>
      useLoopOrderRestore({ merchantId: MERCHANT_ID, enabled: true }),
    );
    const FRESH_ORDER_ID = 'fresh-order-id';
    saveLoopPendingOrder({ merchantId: MERCHANT_ID, orderId: FRESH_ORDER_ID });
    await waitFor(async () => {
      const raw = (await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)) as Record<
        string,
        unknown
      >;
      expect(raw.orderId).toBe(FRESH_ORDER_ID);
    });
    resolveGet(mkOrder());
    await waitFor(() => expect(getLoopOrderMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.restored).toBeNull();
    const raw = (await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)) as Record<string, unknown>;
    expect(raw.orderId).toBe(FRESH_ORDER_ID);
  });
});

describe('saveLoopPendingOrder / clearLoopPendingOrder', () => {
  it('persists a POINTER only — no payment-directing field is written to storage', async () => {
    saveLoopPendingOrder({ merchantId: MERCHANT_ID, orderId: ORDER_ID });
    await waitFor(async () => {
      expect(await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)).not.toBeNull();
    });
    const raw = (await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)) as Record<string, unknown>;
    expect(raw.orderId).toBe(ORDER_ID);
    expect(raw.merchantId).toBe(MERCHANT_ID);
    // Nothing payment-directing is ever persisted.
    expect(raw).not.toHaveProperty('create');
    expect(raw).not.toHaveProperty('payment');
    expect(raw).not.toHaveProperty('paymentUri');
    expect(raw).not.toHaveProperty('assetAmount');
    expect(raw).not.toHaveProperty('stellarAddress');
  });

  it('sets an explicit expiresAt = savedAt + LOOP_PENDING_ORDER_TTL_SECONDS', async () => {
    saveLoopPendingOrder({ merchantId: MERCHANT_ID, orderId: ORDER_ID });
    await waitFor(async () => {
      expect(await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)).not.toBeNull();
    });
    const raw = (await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)) as Record<string, unknown>;
    expect((raw.expiresAt as number) - (raw.savedAt as number)).toBe(
      LOOP_PENDING_ORDER_TTL_SECONDS,
    );
  });

  it('clears a persisted pointer', async () => {
    saveLoopPendingOrder({ merchantId: MERCHANT_ID, orderId: ORDER_ID });
    await waitFor(async () => {
      expect(await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)).not.toBeNull();
    });
    clearLoopPendingOrder();
    await waitFor(async () => {
      expect(await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)).toBeNull();
    });
  });
});
