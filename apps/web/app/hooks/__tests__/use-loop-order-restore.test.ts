// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { ApiException } from '@loop/shared';
import type * as OrdersLoopModule from '~/services/orders-loop';
import type { CreateLoopOrderResponse, LoopOrderView } from '~/services/orders-loop';

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

function mkCreate(
  overrides: Partial<CreateLoopOrderResponse['payment']> = {},
): CreateLoopOrderResponse {
  return {
    orderId: ORDER_ID,
    payment: {
      method: 'usdc',
      stellarAddress: STELLAR_ADDRESS,
      memo: PAYMENT_MEMO,
      amountMinor: '1000',
      currency: 'USD',
      assetAmount: '10.0000000',
      // Must embed the SAME destination + memo as stellarAddress/memo
      // above — use-loop-order-restore.ts cross-checks both against
      // the server record independently (a tampered paymentUri that
      // deep-links elsewhere must fail even if the top-level fields
      // are correct).
      paymentUri: `web+stellar:pay?destination=${STELLAR_ADDRESS}&amount=10.0000000&memo=${PAYMENT_MEMO}&memo_type=MEMO_TEXT`,
      ...overrides,
    } as CreateLoopOrderResponse['payment'],
  };
}

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

/** Seeds storage directly (bypassing the fire-and-forget persist queue)
 *  so tests get a deterministic starting state. */
async function seed(
  record: Partial<{
    merchantId: string;
    orderId: string;
    create: CreateLoopOrderResponse;
    savedAt: number;
  }>,
): Promise<void> {
  await savePendingOrder(
    {
      merchantId: MERCHANT_ID,
      orderId: ORDER_ID,
      create: mkCreate(),
      savedAt: Math.floor(Date.now() / 1000),
      ...record,
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

describe('validatePersistedLoopOrder', () => {
  it('accepts a well-formed record scoped to the expected merchant', () => {
    const raw = {
      merchantId: MERCHANT_ID,
      orderId: ORDER_ID,
      create: mkCreate(),
      savedAt: Math.floor(Date.now() / 1000),
    };
    const result = validatePersistedLoopOrder(raw, MERCHANT_ID);
    expect(result).not.toBeNull();
    expect(result?.orderId).toBe(ORDER_ID);
  });

  it('rejects a record scoped to a different merchant', () => {
    const raw = {
      merchantId: 'other-merchant',
      orderId: ORDER_ID,
      create: mkCreate(),
      savedAt: Math.floor(Date.now() / 1000),
    };
    expect(validatePersistedLoopOrder(raw, MERCHANT_ID)).toBeNull();
  });

  it('rejects an expired (past-TTL) record', () => {
    const raw = {
      merchantId: MERCHANT_ID,
      orderId: ORDER_ID,
      create: mkCreate(),
      savedAt: Math.floor(Date.now() / 1000) - LOOP_PENDING_ORDER_TTL_SECONDS - 1,
    };
    expect(validatePersistedLoopOrder(raw, MERCHANT_ID)).toBeNull();
  });

  it('rejects malformed / tampered payloads (missing payment fields, mismatched orderId, non-object)', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(validatePersistedLoopOrder(null, MERCHANT_ID)).toBeNull();
    expect(validatePersistedLoopOrder('not-an-object', MERCHANT_ID)).toBeNull();
    expect(
      validatePersistedLoopOrder(
        { merchantId: MERCHANT_ID, orderId: ORDER_ID, savedAt: now, create: { orderId: 'other' } },
        MERCHANT_ID,
      ),
    ).toBeNull();
    expect(
      validatePersistedLoopOrder(
        {
          merchantId: MERCHANT_ID,
          orderId: ORDER_ID,
          savedAt: now,
          create: { orderId: ORDER_ID, payment: { method: 'usdc' /* missing fields */ } },
        },
        MERCHANT_ID,
      ),
    ).toBeNull();
  });

  it('accepts a credit-method record without stellar fields', () => {
    const raw = {
      merchantId: MERCHANT_ID,
      orderId: ORDER_ID,
      savedAt: Math.floor(Date.now() / 1000),
      create: {
        orderId: ORDER_ID,
        payment: { method: 'credit', amountMinor: '1000', currency: 'USD' },
      },
    };
    expect(validatePersistedLoopOrder(raw, MERCHANT_ID)).not.toBeNull();
  });
});

describe('useLoopOrderRestore', () => {
  it('stays null when no persisted record exists (the common case)', async () => {
    const { result } = renderHook(() =>
      useLoopOrderRestore({ merchantId: MERCHANT_ID, enabled: true }),
    );
    await waitFor(() => expect(getLoopOrderMock).not.toHaveBeenCalled());
    expect(result.current.restored).toBeNull();
  });

  it('does nothing while disabled — never fires the GET', async () => {
    await seed({});
    renderHook(() => useLoopOrderRestore({ merchantId: MERCHANT_ID, enabled: false }));
    await new Promise((r) => setTimeout(r, 20));
    expect(getLoopOrderMock).not.toHaveBeenCalled();
  });

  it('restores a still-payable (pending_payment) persisted order', async () => {
    await seed({});
    getLoopOrderMock.mockResolvedValue(mkOrder());
    const { result } = renderHook(() =>
      useLoopOrderRestore({ merchantId: MERCHANT_ID, enabled: true }),
    );
    await waitFor(() => expect(result.current.restored).not.toBeNull());
    expect(result.current.restored?.create.orderId).toBe(ORDER_ID);
    expect(getLoopOrderMock).toHaveBeenCalledWith(ORDER_ID);
    // Read-only: never calls the create endpoint (no createLoopOrder import
    // even exists in this module — asserting the GET is the only call).
    expect(getLoopOrderMock).toHaveBeenCalledTimes(1);
  });

  it('also restores while the order is already paid/procuring (still non-terminal)', async () => {
    await seed({});
    getLoopOrderMock.mockResolvedValue(mkOrder({ state: 'procuring' }));
    const { result } = renderHook(() =>
      useLoopOrderRestore({ merchantId: MERCHANT_ID, enabled: true }),
    );
    await waitFor(() => expect(result.current.restored).not.toBeNull());
  });

  it('does not restore a record scoped to a different merchant', async () => {
    await seed({});
    const { result } = renderHook(() =>
      useLoopOrderRestore({ merchantId: 'a-different-merchant', enabled: true }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.restored).toBeNull();
    expect(getLoopOrderMock).not.toHaveBeenCalled();
  });

  it('clears the persisted record and does not restore a fulfilled order', async () => {
    await seed({});
    getLoopOrderMock.mockResolvedValue(mkOrder({ state: 'fulfilled' }));
    const { result } = renderHook(() =>
      useLoopOrderRestore({ merchantId: MERCHANT_ID, enabled: true }),
    );
    await waitFor(() => expect(getLoopOrderMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.restored).toBeNull();
    await waitFor(async () => {
      expect(await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)).toBeNull();
    });
  });

  it('clears the persisted record and does not restore an expired order', async () => {
    await seed({});
    getLoopOrderMock.mockResolvedValue(mkOrder({ state: 'expired' }));
    const { result } = renderHook(() =>
      useLoopOrderRestore({ merchantId: MERCHANT_ID, enabled: true }),
    );
    await waitFor(async () => {
      expect(await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)).toBeNull();
    });
    expect(result.current.restored).toBeNull();
  });

  it('clears the persisted record on a 404 (order not found / not owned) without crashing', async () => {
    await seed({});
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

  it('clears the persisted record on a 403 (forbidden — stale record from a different session) without crashing', async () => {
    await seed({});
    getLoopOrderMock.mockRejectedValue(
      new ApiException(403, { code: 'FORBIDDEN', message: 'not yours' }),
    );
    const { result } = renderHook(() =>
      useLoopOrderRestore({ merchantId: MERCHANT_ID, enabled: true }),
    );
    await waitFor(async () => {
      expect(await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)).toBeNull();
    });
    expect(result.current.restored).toBeNull();
  });

  it('leaves the persisted record alone on a transient 500 — a future remount gets another chance', async () => {
    await seed({});
    getLoopOrderMock.mockRejectedValue(
      new ApiException(500, { code: 'INTERNAL_ERROR', message: 'blip' }),
    );
    const { result } = renderHook(() =>
      useLoopOrderRestore({ merchantId: MERCHANT_ID, enabled: true }),
    );
    await waitFor(() => expect(getLoopOrderMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.restored).toBeNull();
    // Not cleared — still there for a future attempt.
    const stillThere = await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY);
    expect(stillThere).not.toBeNull();
  });

  it('refuses to restore + clears when the server deposit address/memo do not match the persisted copy (tamper/staleness guard)', async () => {
    await seed({});
    getLoopOrderMock.mockResolvedValue(
      mkOrder({ stellarAddress: 'GDIFFERENTADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' }),
    );
    const { result } = renderHook(() =>
      useLoopOrderRestore({ merchantId: MERCHANT_ID, enabled: true }),
    );
    await waitFor(async () => {
      expect(await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)).toBeNull();
    });
    expect(result.current.restored).toBeNull();
  });

  it('refuses to restore when the persisted payment method disagrees with the server record', async () => {
    await seed({ create: mkCreate({ method: 'xlm' }) });
    getLoopOrderMock.mockResolvedValue(mkOrder({ paymentMethod: 'usdc' }));
    const { result } = renderHook(() =>
      useLoopOrderRestore({ merchantId: MERCHANT_ID, enabled: true }),
    );
    await waitFor(async () => {
      expect(await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)).toBeNull();
    });
    expect(result.current.restored).toBeNull();
  });

  it('refuses to restore + clears when the persisted paymentUri deep-links to a DIFFERENT destination than stellarAddress/memo (SEP-7 tamper guard)', async () => {
    // Top-level stellarAddress/memo match the server exactly — only the
    // embedded SEP-7 URI is tampered. This is the attack the address/memo
    // check alone can't catch: on native, `paymentUri` is the only
    // payment affordance shown (NativePaymentBody has no separate
    // address/memo text), so a correct-looking record with a poisoned
    // deep-link must still fail closed.
    await seed({
      create: mkCreate({
        paymentUri: `web+stellar:pay?destination=GATTACKERADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX&amount=10.0000000&memo=${PAYMENT_MEMO}&memo_type=MEMO_TEXT`,
      }),
    });
    getLoopOrderMock.mockResolvedValue(mkOrder());
    const { result } = renderHook(() =>
      useLoopOrderRestore({ merchantId: MERCHANT_ID, enabled: true }),
    );
    await waitFor(async () => {
      expect(await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)).toBeNull();
    });
    expect(result.current.restored).toBeNull();
  });

  it('refuses to restore + clears when the persisted paymentUri is missing the memo (fails closed, not silently accepted)', async () => {
    await seed({
      create: mkCreate({
        paymentUri: `web+stellar:pay?destination=${STELLAR_ADDRESS}&amount=10.0000000&memo_type=MEMO_TEXT`,
      }),
    });
    getLoopOrderMock.mockResolvedValue(mkOrder());
    const { result } = renderHook(() =>
      useLoopOrderRestore({ merchantId: MERCHANT_ID, enabled: true }),
    );
    await waitFor(async () => {
      expect(await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)).toBeNull();
    });
    expect(result.current.restored).toBeNull();
  });

  it('does not clobber a FRESHER persisted order that appeared while the restore GET was in flight', async () => {
    await seed({});
    let resolveGet!: (order: LoopOrderView) => void;
    getLoopOrderMock.mockImplementation(
      () =>
        new Promise<LoopOrderView>((resolve) => {
          resolveGet = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useLoopOrderRestore({ merchantId: MERCHANT_ID, enabled: true }),
    );
    // While the GET for the original order is still pending, simulate a
    // fresh order create superseding the persisted record — exactly what
    // PurchaseContainer's saveLoopPendingOrder call does on a new
    // createLoopOrder success.
    const FRESH_ORDER_ID = 'fresh-order-id';
    saveLoopPendingOrder({
      merchantId: MERCHANT_ID,
      orderId: FRESH_ORDER_ID,
      create: { ...mkCreate(), orderId: FRESH_ORDER_ID },
    });
    await waitFor(async () => {
      const raw = (await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)) as Record<
        string,
        unknown
      >;
      expect(raw.orderId).toBe(FRESH_ORDER_ID);
    });

    // Now let the original (stale) GET resolve as still-valid.
    resolveGet(mkOrder());
    await waitFor(() => expect(getLoopOrderMock).toHaveBeenCalled());
    // Give the hook's async continuation a turn to run.
    await new Promise((r) => setTimeout(r, 20));

    // Must NOT have restored the stale order, and must NOT have
    // overwritten the fresher persisted record.
    expect(result.current.restored).toBeNull();
    const raw = (await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)) as Record<string, unknown>;
    expect(raw.orderId).toBe(FRESH_ORDER_ID);
  });
});

describe('TTL consistency between the module TTL and the generic storage layer', () => {
  it("saveLoopPendingOrder sets an explicit expiresAt so the record survives the full LOOP_PENDING_ORDER_TTL_SECONDS window (not the generic layer's shorter default)", async () => {
    saveLoopPendingOrder({ merchantId: MERCHANT_ID, orderId: ORDER_ID, create: mkCreate() });
    await waitFor(async () => {
      expect(await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)).not.toBeNull();
    });
    const raw = (await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)) as Record<string, unknown>;
    const savedAt = raw.savedAt as number;
    const expiresAt = raw.expiresAt as number;
    expect(expiresAt - savedAt).toBe(LOOP_PENDING_ORDER_TTL_SECONDS);
  });
});

describe('saveLoopPendingOrder / clearLoopPendingOrder', () => {
  it('persists a record that loadPendingOrder can read back', async () => {
    saveLoopPendingOrder({ merchantId: MERCHANT_ID, orderId: ORDER_ID, create: mkCreate() });
    await waitFor(async () => {
      const raw = await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY);
      expect(raw).not.toBeNull();
    });
    const raw = (await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)) as Record<string, unknown>;
    expect(raw.orderId).toBe(ORDER_ID);
    expect(raw.merchantId).toBe(MERCHANT_ID);
  });

  it('clears a persisted record', async () => {
    saveLoopPendingOrder({ merchantId: MERCHANT_ID, orderId: ORDER_ID, create: mkCreate() });
    await waitFor(async () => {
      expect(await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)).not.toBeNull();
    });
    clearLoopPendingOrder();
    await waitFor(async () => {
      expect(await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY)).toBeNull();
    });
  });
});
