import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { envState, payoutAssetState, discordState } = vi.hoisted(() => ({
  envState: {
    LOOP_STELLAR_DEPOSIT_ADDRESS: undefined as string | undefined,
    LOOP_STELLAR_USDC_ISSUER: undefined as string | undefined,
  },
  payoutAssetState: {
    USD: { code: 'USDLOOP', issuer: null as string | null },
    GBP: { code: 'GBPLOOP', issuer: null as string | null },
    EUR: { code: 'EURLOOP', issuer: null as string | null },
  },
  discordState: {
    notifyCashbackRecycled: vi.fn(),
    notifyFirstCashbackRecycled: vi.fn(),
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

vi.mock('../../discord.js', () => ({
  notifyCashbackRecycled: discordState.notifyCashbackRecycled,
  notifyFirstCashbackRecycled: discordState.notifyFirstCashbackRecycled,
}));

import { buildLoopCreateResponse } from '../loop-create-response.js';

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
  currency: string;
  faceValueMinor: bigint;
  paymentMemo: string | null;
}

function order(overrides: Partial<OrderShape> = {}): OrderShape {
  return {
    id: 'order-1',
    paymentMethod: 'xlm',
    chargeMinor: 1000n,
    chargeCurrency: 'USD',
    currency: 'USD',
    faceValueMinor: 1000n,
    paymentMemo: 'MEMO-XLM-AAAAAAAAAAAA',
    ...overrides,
  };
}

const merchant = { name: 'Test Merchant' };

beforeEach(() => {
  envState.LOOP_STELLAR_DEPOSIT_ADDRESS = 'GDEPOSIT';
  envState.LOOP_STELLAR_USDC_ISSUER = 'GUSDCISSUER';
  payoutAssetState.USD.issuer = 'GISSUERUSD';
  payoutAssetState.GBP.issuer = 'GISSUERGBP';
  payoutAssetState.EUR.issuer = 'GISSUEREUR';
  discordState.notifyCashbackRecycled.mockReset();
  discordState.notifyFirstCashbackRecycled.mockReset();
});

function baseArgs(
  o: OrderShape,
  homeCurrency: 'USD' | 'GBP' | 'EUR' = 'USD',
): {
  order: never;
  userId: string;
  homeCurrency: 'USD' | 'GBP' | 'EUR';
  merchant: never;
  firstLoopAsset: boolean;
} {
  return {
    order: o as never,
    userId: 'user-1',
    homeCurrency,
    merchant: merchant as never,
    firstLoopAsset: false,
  };
}

describe('buildLoopCreateResponse', () => {
  it('builds a credit-method response without leaking deposit address or memo', async () => {
    const res = await buildLoopCreateResponse(
      fakeContext(),
      baseArgs(order({ paymentMethod: 'credit' })),
    );
    const body = (await res.json()) as { orderId: string; payment: Record<string, string> };
    expect(body.orderId).toBe('order-1');
    expect(body.payment).toEqual({ method: 'credit', amountMinor: '1000', currency: 'USD' });
    expect(body.payment.stellarAddress).toBeUndefined();
  });

  it('builds an XLM-method response with deposit address + memo', async () => {
    const res = await buildLoopCreateResponse(
      fakeContext(),
      baseArgs(order({ paymentMethod: 'xlm' })),
    );
    const body = (await res.json()) as { payment: { stellarAddress: string; memo: string } };
    expect(body.payment.stellarAddress).toBe('GDEPOSIT');
    expect(body.payment.memo).toBe('MEMO-XLM-AAAAAAAAAAAA');
  });

  it('builds a loop_asset response with assetCode + assetIssuer and fires the flywheel notify', async () => {
    const res = await buildLoopCreateResponse(
      fakeContext(),
      baseArgs(order({ paymentMethod: 'loop_asset', chargeCurrency: 'GBP' }), 'GBP'),
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
    expect(discordState.notifyCashbackRecycled).toHaveBeenCalledTimes(1);
  });

  it('returns 503 for loop_asset when the issuer for the currency is unset', async () => {
    payoutAssetState.USD.issuer = null;
    const res = await buildLoopCreateResponse(
      fakeContext(),
      baseArgs(order({ paymentMethod: 'loop_asset', chargeCurrency: 'USD' })),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('SERVICE_UNAVAILABLE');
  });

  describe('usdc order-create-time issuer gate (AUDIT-2 P2 follow-up b)', () => {
    it('builds a usdc response with the issuer embedded in the SEP-7 URI when configured', async () => {
      const res = await buildLoopCreateResponse(
        fakeContext(),
        baseArgs(order({ paymentMethod: 'usdc' })),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { payment: { method: string; paymentUri: string } };
      expect(body.payment.method).toBe('usdc');
      expect(body.payment.paymentUri).toContain('asset_code=USDC');
      expect(body.payment.paymentUri).toContain('asset_issuer=GUSDCISSUER');
    });

    it('returns 503 SERVICE_UNAVAILABLE for a usdc order when LOOP_STELLAR_USDC_ISSUER is unset — never a malformed URI', async () => {
      envState.LOOP_STELLAR_USDC_ISSUER = undefined;
      const res = await buildLoopCreateResponse(
        fakeContext(),
        baseArgs(order({ paymentMethod: 'usdc' })),
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as { code: string; payment?: unknown };
      expect(body.code).toBe('SERVICE_UNAVAILABLE');
      // The pre-fix bug: no guard meant a 200 with `asset_issuer=`
      // (empty) baked into the URI — un-payable, stalls to 24h expiry.
      expect(body.payment).toBeUndefined();
    });

    it('xlm create is unaffected by an unset USDC issuer (non-regression)', async () => {
      envState.LOOP_STELLAR_USDC_ISSUER = undefined;
      const res = await buildLoopCreateResponse(
        fakeContext(),
        baseArgs(order({ paymentMethod: 'xlm' })),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { payment: { method: string } };
      expect(body.payment.method).toBe('xlm');
    });
  });

  it('falls back to empty memo when paymentMemo is null', async () => {
    const res = await buildLoopCreateResponse(
      fakeContext(),
      baseArgs(order({ paymentMethod: 'xlm', paymentMemo: null })),
    );
    const body = (await res.json()) as { payment: { memo: string } };
    expect(body.payment.memo).toBe('');
  });
});
