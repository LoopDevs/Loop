import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CtxFetchOptions } from '../api-fetch.js';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('../../upstream.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  upstreamUrl: (path: string) => `http://ctx.test${path}`,
}));

const ctxFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../api-fetch.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  ctxFetch: ctxFetchMock,
}));

import {
  CtxAccountRequestError,
  CtxAccountShapeError,
  depositCtxSavings,
  fetchCtxAccount,
  linkCtxWallet,
  unlinkCtxWallet,
  updateCtxWallet,
  withdrawCtxSavings,
} from '../account.js';

const ADDRESS = 'G' + 'A'.repeat(55);

function ctxLink(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'w-1',
    chain: 'XLM',
    address: ADDRESS,
    autoPayout: true,
    status: 'active',
    created: '2026-09-23T10:00:00Z',
    ...overrides,
  };
}

function ctxAccount(): Record<string, unknown> {
  return {
    id: 'acct-1',
    userId: 'ctx-user-1',
    wallet: [{ currency: 'XLM.GBPLOOP', amount: '0.4000000' }],
    savings: [
      {
        currency: 'XLM.USDC',
        provider: 'ctxmock',
        principal: '5.0000000',
        value: '5.1200000',
        earnt: '0.1200000',
      },
    ],
    savingsPrincipal: [{ currency: 'XLM.USDC', amount: '5.0000000' }],
    pendingOperations: [
      {
        id: 'op-1',
        type: 'deposit',
        status: 'pending',
        currency: 'XLM.USDC',
        amount: '1.0000000',
        created: '2026-09-23T10:00:00Z',
      },
    ],
    linkedWallets: [ctxLink()],
    payouts: [
      {
        id: 'p-1',
        status: 'complete',
        chain: 'XLM',
        address: ADDRESS,
        currency: 'XLM.GBPLOOP',
        amount: '0.4000000',
        giftCardId: 'gc-1',
        txHash: 'abc',
        created: '2026-09-23T10:00:00Z',
        finalised: '2026-09-23T10:00:05Z',
      },
    ],
    created: '2026-09-01T00:00:00Z',
    updated: '2026-09-23T10:00:05Z',
  };
}

const respond = (status: number, body: unknown): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

beforeEach(() => {
  ctxFetchMock.mockReset();
});

describe('fetchCtxAccount', () => {
  it('GETs /users/:id/account acting as the customer and fills omitted keys with null', async () => {
    ctxFetchMock.mockResolvedValueOnce(respond(200, ctxAccount()));

    const view = await fetchCtxAccount({ ctxUserId: 'ctx-user-1', clientId: 'loopios' });

    const [url, init, options] = ctxFetchMock.mock.calls[0] as [
      string,
      RequestInit,
      CtxFetchOptions,
    ];
    expect(url).toBe('http://ctx.test/users/ctx-user-1/account');
    expect(init.method).toBe('GET');
    expect(options.actAs).toEqual({ userId: 'ctx-user-1', clientId: 'loopios' });
    expect(view.wallet).toEqual([{ currency: 'XLM.GBPLOOP', amount: '0.4000000' }]);
    expect(view.linkedWallets[0]).toEqual({
      id: 'w-1',
      chain: 'XLM',
      address: ADDRESS,
      autoPayout: true,
      status: 'active',
      created: '2026-09-23T10:00:00Z',
      removed: null,
    });
    expect(view.payouts[0]?.transferId).toBeNull();
    expect(view.payouts[0]?.error).toBeNull();
    expect(view.payouts[0]?.txHash).toBe('abc');
    expect(view.pendingOperations[0]?.finalisedAt).toBeNull();
  });

  it('throws a shape error when the account payload is malformed', async () => {
    ctxFetchMock.mockResolvedValueOnce(respond(200, { id: 'acct-1' }));
    await expect(fetchCtxAccount({ ctxUserId: 'ctx-user-1' })).rejects.toBeInstanceOf(
      CtxAccountShapeError,
    );
  });

  it('throws a shape error on a non-JSON body', async () => {
    ctxFetchMock.mockResolvedValueOnce(respond(200, '<html>'));
    await expect(fetchCtxAccount({ ctxUserId: 'ctx-user-1' })).rejects.toBeInstanceOf(
      CtxAccountShapeError,
    );
  });
});

describe('linkCtxWallet', () => {
  it('POSTs the link body and returns the created link', async () => {
    ctxFetchMock.mockResolvedValueOnce(respond(201, ctxLink()));

    const link = await linkCtxWallet(
      { ctxUserId: 'ctx-user-1' },
      { chain: 'XLM', address: ADDRESS, autoPayout: true },
    );

    const [url, init] = ctxFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://ctx.test/users/ctx-user-1/wallets');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      chain: 'XLM',
      address: ADDRESS,
      autoPayout: true,
    });
    expect(link.id).toBe('w-1');
  });

  it('surfaces CTX field validation as a request error with the fields', async () => {
    ctxFetchMock.mockResolvedValueOnce(
      respond(400, { error: 'bad request', fields: { address: ['invalid'] } }),
    );

    const err = await linkCtxWallet(
      { ctxUserId: 'ctx-user-1' },
      { chain: 'XLM', address: ADDRESS },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CtxAccountRequestError);
    expect((err as CtxAccountRequestError).status).toBe(400);
    expect((err as CtxAccountRequestError).fields).toEqual({ address: ['invalid'] });
  });
});

describe('updateCtxWallet / unlinkCtxWallet', () => {
  it('PUTs the autoPayout toggle to the wallet id path', async () => {
    ctxFetchMock.mockResolvedValueOnce(respond(200, ctxLink({ autoPayout: false })));

    const link = await updateCtxWallet({ ctxUserId: 'ctx-user-1' }, 'w 1', { autoPayout: false });

    const [url, init] = ctxFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://ctx.test/users/ctx-user-1/wallets/w%201');
    expect(init.method).toBe('PUT');
    expect(link.autoPayout).toBe(false);
  });

  it('DELETEs the wallet id path and returns the removed link', async () => {
    ctxFetchMock.mockResolvedValueOnce(
      respond(200, ctxLink({ status: 'removed', removed: '2026-09-23T11:00:00Z' })),
    );

    const link = await unlinkCtxWallet({ ctxUserId: 'ctx-user-1' }, 'w-1');

    const [url, init] = ctxFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://ctx.test/users/ctx-user-1/wallets/w-1');
    expect(init.method).toBe('DELETE');
    expect(link.status).toBe('removed');
    expect(link.removed).toBe('2026-09-23T11:00:00Z');
  });

  it('maps a CTX 404 to a request error carrying the status', async () => {
    ctxFetchMock.mockResolvedValueOnce(respond(404, { error: 'not found' }));
    const err = await unlinkCtxWallet({ ctxUserId: 'ctx-user-1' }, 'missing').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CtxAccountRequestError);
    expect((err as CtxAccountRequestError).status).toBe(404);
  });
});

describe('savings', () => {
  const operation = {
    id: 'sop-1',
    type: 'deposit',
    potId: 'pot-1',
    status: 'pending',
    currency: 'XLM.USDC',
    amount: '1.0000000',
    created: '2026-09-23T10:00:00Z',
  };

  it('POSTs a deposit acting as the customer and maps the operation', async () => {
    ctxFetchMock.mockResolvedValueOnce(respond(201, operation));
    const view = await depositCtxSavings(
      { ctxUserId: 'ctx-user-1', clientId: 'loopios' },
      { currency: 'XLM.USDC', amount: '1' },
    );
    const [url, init, options] = ctxFetchMock.mock.calls[0] as [
      string,
      RequestInit,
      CtxFetchOptions,
    ];
    expect(url).toBe('http://ctx.test/users/ctx-user-1/account/savings/deposits');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ currency: 'XLM.USDC', amount: '1' });
    expect(options.actAs?.userId).toBe('ctx-user-1');
    expect(view).toEqual({
      id: 'sop-1',
      type: 'deposit',
      potId: 'pot-1',
      status: 'pending',
      currency: 'XLM.USDC',
      amount: '1.0000000',
      created: '2026-09-23T10:00:00Z',
      finalisedAt: null,
      error: null,
    });
  });

  it('POSTs a withdrawal and surfaces the lock refusal as a 400 request error', async () => {
    ctxFetchMock.mockResolvedValueOnce(
      respond(400, { error: 'part of this savings balance is still within its lock period' }),
    );
    await expect(
      withdrawCtxSavings({ ctxUserId: 'ctx-user-1' }, { currency: 'XLM.USDC', amount: '5' }),
    ).rejects.toMatchObject({ status: 400, message: /lock period/ });
    const [url] = ctxFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://ctx.test/users/ctx-user-1/account/savings/withdrawals');
  });

  it('reads the lock and yield fields on positions and accepts every CTX payout status', async () => {
    const account = ctxAccount();
    account.savings = [
      {
        potId: 'pot-1',
        currency: 'XLM.USDC',
        provider: 'defindex',
        principal: '5.0000000',
        value: '5.1200000',
        earnt: '0.1200000',
        locked: '1.0000000',
        available: '4.1200000',
        unlocksAt: '2026-09-24T10:00:00Z',
        estimatedApr: 0.0412,
        projectedYearlyEarnings: '0.2109440',
      },
    ];
    account.payouts = [{ ...(account.payouts as Record<string, unknown>[])[0], status: 'held' }];
    ctxFetchMock.mockResolvedValueOnce(respond(200, account));

    const view = await fetchCtxAccount({ ctxUserId: 'ctx-user-1' });

    expect(view.savings[0]).toEqual({
      potId: 'pot-1',
      currency: 'XLM.USDC',
      provider: 'defindex',
      principal: '5.0000000',
      value: '5.1200000',
      earnt: '0.1200000',
      locked: '1.0000000',
      available: '4.1200000',
      unlocksAt: '2026-09-24T10:00:00Z',
      estimatedApr: 0.0412,
      projectedYearlyEarnings: '0.2109440',
    });
    expect(view.payouts[0]?.status).toBe('held');
  });
});
