import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { envState, payoutAssetState } = vi.hoisted(() => ({
  envState: {
    LOOP_STELLAR_DEPOSIT_ADDRESS: undefined as string | undefined,
  },
  payoutAssetState: {
    USD: { code: 'USDLOOP', issuer: null as string | null },
    GBP: { code: 'GBPLOOP', issuer: null as string | null },
    EUR: { code: 'EURLOOP', issuer: null as string | null },
  },
}));

vi.mock('../../env.js', () => ({
  get env() {
    return envState;
  },
}));

vi.mock('../../credits/payout-asset.js', () => ({
  payoutAssetFor: (c: 'USD' | 'GBP' | 'EUR') => payoutAssetState[c],
}));

import { replayOrderResponse } from '../loop-replay-response.js';

function fakeContext(): Context {
  return {
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

interface OrderShape {
  id: string;
  paymentMethod: 'xlm' | 'usdc' | 'credit' | 'loop_asset';
  chargeMinor: bigint;
  chargeCurrency: string;
  paymentMemo: string | null;
}

function order(overrides: Partial<OrderShape> = {}): OrderShape {
  return {
    id: 'order-1',
    paymentMethod: 'xlm',
    chargeMinor: 1000n,
    chargeCurrency: 'USD',
    paymentMemo: 'MEMO-XLM-AAAAAAAAAAAA',
    ...overrides,
  };
}

beforeEach(() => {
  envState.LOOP_STELLAR_DEPOSIT_ADDRESS = 'GDEPOSIT';
  payoutAssetState.USD.issuer = 'GISSUERUSD';
  payoutAssetState.GBP.issuer = 'GISSUERGBP';
  payoutAssetState.EUR.issuer = 'GISSUEREUR';
});

describe('replayOrderResponse', () => {
  it('replays a credit-method order without leaking deposit address or memo', async () => {
    const res = replayOrderResponse(fakeContext(), order({ paymentMethod: 'credit' }) as never);
    const body = (await res.json()) as { orderId: string; payment: Record<string, string> };
    expect(body.orderId).toBe('order-1');
    expect(body.payment).toEqual({ method: 'credit', amountMinor: '1000', currency: 'USD' });
    expect(body.payment.stellarAddress).toBeUndefined();
  });

  it('replays an XLM-method order with deposit address + memo', async () => {
    const res = replayOrderResponse(fakeContext(), order({ paymentMethod: 'xlm' }) as never);
    const body = (await res.json()) as { payment: { stellarAddress: string; memo: string } };
    expect(body.payment.stellarAddress).toBe('GDEPOSIT');
    expect(body.payment.memo).toBe('MEMO-XLM-AAAAAAAAAAAA');
  });

  it('replays a USDC-method order with the same envelope shape as XLM', async () => {
    const res = replayOrderResponse(fakeContext(), order({ paymentMethod: 'usdc' }) as never);
    const body = (await res.json()) as { payment: { method: string } };
    expect(body.payment.method).toBe('usdc');
  });

  it('replays a loop_asset order with assetCode + assetIssuer', async () => {
    const res = replayOrderResponse(
      fakeContext(),
      order({ paymentMethod: 'loop_asset', chargeCurrency: 'GBP' }) as never,
    );
    const body = (await res.json()) as {
      payment: { method: string; assetCode: string; assetIssuer: string };
    };
    expect(body.payment).toEqual(
      expect.objectContaining({
        method: 'loop_asset',
        assetCode: 'GBPLOOP',
        assetIssuer: 'GISSUERGBP',
      }),
    );
  });

  it('returns 500 when a stored loop_asset order has a chargeCurrency outside the home-currency enum', async () => {
    const res = replayOrderResponse(
      fakeContext(),
      order({ paymentMethod: 'loop_asset', chargeCurrency: 'JPY' }) as never,
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INTERNAL_ERROR');
  });

  it('returns 503 for loop_asset replay when the issuer for the currency has been unset', async () => {
    payoutAssetState.USD.issuer = null;
    const res = replayOrderResponse(
      fakeContext(),
      order({ paymentMethod: 'loop_asset', chargeCurrency: 'USD' }) as never,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('returns 503 for xlm/usdc replay when LOOP_STELLAR_DEPOSIT_ADDRESS has been unset', async () => {
    envState.LOOP_STELLAR_DEPOSIT_ADDRESS = undefined;
    const res = replayOrderResponse(fakeContext(), order({ paymentMethod: 'xlm' }) as never);
    expect(res.status).toBe(503);
  });

  it('falls back to empty memo when paymentMemo is null', async () => {
    const res = replayOrderResponse(
      fakeContext(),
      order({ paymentMethod: 'xlm', paymentMemo: null }) as never,
    );
    const body = (await res.json()) as { payment: { memo: string } };
    expect(body.payment.memo).toBe('');
  });
});
