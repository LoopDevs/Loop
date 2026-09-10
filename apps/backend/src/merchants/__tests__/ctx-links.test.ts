// ADR 052 cashback delivery — `ctx-links.ts`
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { ctxFetchMock, companyIdMock } = vi.hoisted(() => ({
  ctxFetchMock: vi.fn(),
  companyIdMock: vi.fn(),
}));

vi.mock('../../ctx/api-fetch.js', () => ({
  ctxFetch: ctxFetchMock,
}));
vi.mock('../../orders/ctx-order.js', () => ({
  operatorCompanyId: companyIdMock,
}));
vi.mock('../../upstream.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  upstreamUrl: (path: string) => `http://ctx.test${path}`,
}));
vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { db, __resetDbForTests } from '../../db/client.js';
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

async function seedConfig(
  merchantId: string,
  userCashbackPct: number,
  active: boolean,
): Promise<void> {
  await db.collection('merchant_cashback_configs').insertOne({
    merchantId,
    userCashbackPct,
    active,
    updatedBy: 'test-operator',
    updatedAt: new Date(),
  });
}

beforeEach(() => {
  __resetDbForTests();
  __resetCtxLinksForTests();
  ctxFetchMock.mockReset();
  ctxFetchMock.mockResolvedValue(okResponse());
  companyIdMock.mockReset();
  companyIdMock.mockResolvedValue('company-1');
});

describe('desiredUserDiscountBp', () => {
  it('floors operator bp × pct / 100', () => {
    const link = { id: 'l1', operatorDiscountBasisPoints: 750, userDiscountBasisPoints: null };
    expect(desiredUserDiscountBp(link, 33)).toBe(247);
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
    await seedConfig('m-drifted', 50, true);
    await seedConfig('m-ok', 50, true);
    await seedConfig('m-no-link', 10, true);
    await seedConfig('m-inactive', 50, false);
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
    await seedConfig('m1', 0, true);
    await reconcileUserDiscounts();
    expect(ctxFetchMock).not.toHaveBeenCalled();
  });

  it('swallows a config-read failure', async () => {
    const configs = db.collection('merchant_cashback_configs');
    vi.spyOn(configs, 'findMany').mockRejectedValueOnce(new Error('db down'));
    await expect(reconcileUserDiscounts()).resolves.toBeUndefined();
  });
});
