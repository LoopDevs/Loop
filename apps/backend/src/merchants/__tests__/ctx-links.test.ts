/**
 * ADR 052 cashback delivery — `ctx-links.ts`.
 *
 * Pins the three things that matter commercially:
 *
 *   1. `desiredUserDiscountBp` floors and never invents a value when
 *      the operator discount is unknown (unknown ≠ zero).
 *   2. The push writes the bulk `PUT /merchant-links` body CTX
 *      expects (company-targeted, link-id-keyed, user bp only) and
 *      is a no-op when the link already matches.
 *   3. The sweep reconcile pushes only drifted active configs and
 *      swallows every failure (fail-soft — the next sweep retries).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { ctxFetchMock, companyIdMock, dbRows } = vi.hoisted(() => ({
  ctxFetchMock: vi.fn(),
  companyIdMock: vi.fn(),
  dbRows: { value: [] as Array<Record<string, unknown>> },
}));

vi.mock('../../ctx/api-fetch.js', () => ({
  ctxFetch: ctxFetchMock,
}));
vi.mock('../../orders/ctx-order.js', () => ({
  operatorCompanyId: companyIdMock,
}));
vi.mock('../../upstream.js', () => ({
  upstreamUrl: (path: string) => `http://ctx.test${path}`,
}));
vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(dbRows.value),
      }),
    }),
  },
}));
vi.mock('../../db/schema.js', () => ({
  merchantCashbackConfigs: {
    merchantId: 'merchant_id',
    userCashbackPct: 'user_cashback_pct',
    active: 'active',
  },
}));
vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import {
  __resetCtxLinksForTests,
  desiredUserDiscountBp,
  getMerchantLink,
  pushUserDiscountForMerchant,
  reconcileUserDiscounts,
  replaceMerchantLinks,
} from '../ctx-links.js';

function okResponse(): Response {
  return new Response('{}', { status: 200 });
}

beforeEach(() => {
  __resetCtxLinksForTests();
  ctxFetchMock.mockReset();
  ctxFetchMock.mockResolvedValue(okResponse());
  companyIdMock.mockReset();
  companyIdMock.mockResolvedValue('company-1');
  dbRows.value = [];
});

describe('desiredUserDiscountBp', () => {
  it('floors operator bp × pct / 100', () => {
    const link = { id: 'l1', operatorDiscountBasisPoints: 750, userDiscountBasisPoints: null };
    expect(desiredUserDiscountBp(link, 33)).toBe(247); // floor(247.5)
    expect(desiredUserDiscountBp(link, 0)).toBe(0);
    expect(desiredUserDiscountBp(link, 100)).toBe(750);
  });

  it('returns null (never zero) when the operator discount is unknown', () => {
    expect(desiredUserDiscountBp(undefined, 50)).toBeNull();
    expect(
      desiredUserDiscountBp(
        { id: 'l1', operatorDiscountBasisPoints: null, userDiscountBasisPoints: null },
        50,
      ),
    ).toBeNull();
  });
});

describe('pushUserDiscountForMerchant', () => {
  it('PUTs the company-targeted bulk update keyed by link id', async () => {
    replaceMerchantLinks(
      new Map([
        ['m1', { id: 'link-1', operatorDiscountBasisPoints: 800, userDiscountBasisPoints: null }],
      ]),
    );
    const pushed = await pushUserDiscountForMerchant('m1', 25, true);
    expect(pushed).toBe(true);
    expect(ctxFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = ctxFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://ctx.test/merchant-links');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      targetEntityType: 'company',
      targetEntityId: 'company-1',
      update: [{ id: 'link-1', userDiscountBasisPoints: 200 }],
    });
    // Registry reflects the landed write so a same-value re-save no-ops.
    expect(getMerchantLink('m1')?.userDiscountBasisPoints).toBe(200);
  });

  it('pushes 0 for an inactive config (cashback off, Loop keeps the spread)', async () => {
    replaceMerchantLinks(
      new Map([
        ['m1', { id: 'link-1', operatorDiscountBasisPoints: 800, userDiscountBasisPoints: 200 }],
      ]),
    );
    await pushUserDiscountForMerchant('m1', 25, false);
    const body = JSON.parse(
      (ctxFetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.update[0].userDiscountBasisPoints).toBe(0);
  });

  it('no-ops when the link already carries the desired bp', async () => {
    replaceMerchantLinks(
      new Map([
        ['m1', { id: 'link-1', operatorDiscountBasisPoints: 800, userDiscountBasisPoints: 200 }],
      ]),
    );
    const pushed = await pushUserDiscountForMerchant('m1', 25, true);
    expect(pushed).toBe(true);
    expect(ctxFetchMock).not.toHaveBeenCalled();
  });

  it('defers (returns false, no throw) when the merchant has no link data yet', async () => {
    const pushed = await pushUserDiscountForMerchant('unknown', 25, true);
    expect(pushed).toBe(false);
    expect(ctxFetchMock).not.toHaveBeenCalled();
  });

  it('fails soft when CTX rejects the write', async () => {
    replaceMerchantLinks(
      new Map([
        ['m1', { id: 'link-1', operatorDiscountBasisPoints: 800, userDiscountBasisPoints: null }],
      ]),
    );
    ctxFetchMock.mockResolvedValue(new Response('{"error":"nope"}', { status: 422 }));
    const pushed = await pushUserDiscountForMerchant('m1', 25, true);
    expect(pushed).toBe(false);
    // Registry NOT updated — the sweep will retry.
    expect(getMerchantLink('m1')?.userDiscountBasisPoints).toBeNull();
  });

  it('fails soft when the company id is unresolvable', async () => {
    companyIdMock.mockResolvedValue(null);
    replaceMerchantLinks(
      new Map([
        ['m1', { id: 'link-1', operatorDiscountBasisPoints: 800, userDiscountBasisPoints: null }],
      ]),
    );
    const pushed = await pushUserDiscountForMerchant('m1', 25, true);
    expect(pushed).toBe(false);
    expect(ctxFetchMock).not.toHaveBeenCalled();
  });
});

describe('reconcileUserDiscounts', () => {
  it('pushes only drifted links and skips merchants without link data', async () => {
    replaceMerchantLinks(
      new Map([
        ['m-drifted', { id: 'l-a', operatorDiscountBasisPoints: 1000, userDiscountBasisPoints: 0 }],
        ['m-ok', { id: 'l-b', operatorDiscountBasisPoints: 1000, userDiscountBasisPoints: 500 }],
      ]),
    );
    dbRows.value = [
      { merchantId: 'm-drifted', userCashbackPct: '50.00', active: true },
      { merchantId: 'm-ok', userCashbackPct: '50.00', active: true },
      { merchantId: 'm-no-link', userCashbackPct: '10.00', active: true },
    ];
    await reconcileUserDiscounts();
    expect(ctxFetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (ctxFetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.update).toEqual([{ id: 'l-a', userDiscountBasisPoints: 500 }]);
  });

  it('treats a link with no override as 0 (skips when the config wants 0)', async () => {
    replaceMerchantLinks(
      new Map([
        ['m1', { id: 'l-a', operatorDiscountBasisPoints: 1000, userDiscountBasisPoints: null }],
      ]),
    );
    dbRows.value = [{ merchantId: 'm1', userCashbackPct: '0.00', active: true }];
    await reconcileUserDiscounts();
    expect(ctxFetchMock).not.toHaveBeenCalled();
  });

  it('swallows a config-read failure', async () => {
    const dbModule = await import('../../db/client.js');
    vi.spyOn(dbModule.db, 'select').mockImplementation(() => {
      throw new Error('db down');
    });
    await expect(reconcileUserDiscounts()).resolves.toBeUndefined();
  });
});
