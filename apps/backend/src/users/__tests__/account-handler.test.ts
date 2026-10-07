import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import type { UserAccountView, WalletLinkView } from '@loop/shared';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const state = vi.hoisted(() => ({
  user: null as { id: string; ctxUserId: string | null } | null,
  resolvedCtxUserId: null as string | null,
}));

vi.mock('../handler.js', () => ({
  resolveCallingUser: vi.fn(async () => state.user),
}));

vi.mock('../../ctx/user-provisioning.js', () => ({
  resolveCtxUserId: vi.fn(async () => state.resolvedCtxUserId),
}));

const ctx = vi.hoisted(() => ({
  fetchCtxAccount: vi.fn(),
  linkCtxWallet: vi.fn(),
  updateCtxWallet: vi.fn(),
  unlinkCtxWallet: vi.fn(),
  depositCtxSavings: vi.fn(),
  withdrawCtxSavings: vi.fn(),
}));

vi.mock('../../ctx/account.js', async (importActual) => ({
  ...((await importActual()) as Record<string, unknown>),
  fetchCtxAccount: ctx.fetchCtxAccount,
  linkCtxWallet: ctx.linkCtxWallet,
  updateCtxWallet: ctx.updateCtxWallet,
  unlinkCtxWallet: ctx.unlinkCtxWallet,
  depositCtxSavings: ctx.depositCtxSavings,
  withdrawCtxSavings: ctx.withdrawCtxSavings,
}));

import { CtxAccountRequestError, CtxAccountShapeError } from '../../ctx/account.js';
import { CtxUnavailableError } from '../../ctx/api-fetch.js';
import {
  depositSavingsHandler,
  getAccountHandler,
  linkWalletHandler,
  unlinkWalletHandler,
  updateWalletHandler,
  withdrawSavingsHandler,
} from '../account-handler.js';

const ADDRESS = 'G' + 'A'.repeat(55);

function makeCtx(opts: {
  body?: unknown;
  params?: Record<string, string>;
  clientId?: string;
}): Context {
  const store = new Map<string, unknown>();
  if (opts.clientId !== undefined) store.set('clientId', opts.clientId);
  return {
    req: {
      json: async () => {
        if (opts.body === undefined) throw new Error('no body');
        return opts.body;
      },
      param: (name: string) => opts.params?.[name],
    },
    get: (k: string) => store.get(k),
    json: (responseBody: unknown, status?: number) =>
      new Response(JSON.stringify(responseBody), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

function link(overrides: Partial<WalletLinkView> = {}): WalletLinkView {
  return {
    id: 'w-1',
    chain: 'XLM',
    address: ADDRESS,
    autoPayout: true,
    status: 'active',
    created: '2026-09-23T10:00:00Z',
    removed: null,
    ...overrides,
  };
}

function account(): UserAccountView {
  return {
    id: 'acct-1',
    userId: 'ctx-1',
    wallet: [],
    savings: [],
    savingsPrincipal: [],
    pendingOperations: [],
    linkedWallets: [link()],
    payouts: [],
    created: '2026-09-01T00:00:00Z',
    updated: '2026-09-23T10:00:00Z',
  };
}

beforeEach(() => {
  state.user = { id: 'u-1', ctxUserId: 'ctx-1' };
  state.resolvedCtxUserId = null;
  ctx.fetchCtxAccount.mockReset();
  ctx.linkCtxWallet.mockReset();
  ctx.updateCtxWallet.mockReset();
  ctx.unlinkCtxWallet.mockReset();
});

describe('getAccountHandler', () => {
  it('returns the CTX account acting as the mapped user with the request client id', async () => {
    ctx.fetchCtxAccount.mockResolvedValue(account());
    const res = await getAccountHandler(makeCtx({ clientId: 'loopios' }));
    expect(res.status).toBe(200);
    expect(ctx.fetchCtxAccount).toHaveBeenCalledWith({ ctxUserId: 'ctx-1', clientId: 'loopios' });
    expect(((await res.json()) as UserAccountView).linkedWallets[0]?.address).toBe(ADDRESS);
  });

  it('401s when no user is authenticated', async () => {
    state.user = null;
    const res = await getAccountHandler(makeCtx({}));
    expect(res.status).toBe(401);
    expect(ctx.fetchCtxAccount).not.toHaveBeenCalled();
  });

  it('provisions on demand when the user has no CTX mapping yet', async () => {
    state.user = { id: 'u-1', ctxUserId: null };
    state.resolvedCtxUserId = 'ctx-new';
    ctx.fetchCtxAccount.mockResolvedValue(account());
    const res = await getAccountHandler(makeCtx({}));
    expect(res.status).toBe(200);
    expect(ctx.fetchCtxAccount).toHaveBeenCalledWith({ ctxUserId: 'ctx-new' });
  });

  it('503s while the CTX mapping is still missing after provisioning', async () => {
    state.user = { id: 'u-1', ctxUserId: null };
    const res = await getAccountHandler(makeCtx({}));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('SERVICE_UNAVAILABLE');
  });

  it('503s on a CTX transport failure', async () => {
    ctx.fetchCtxAccount.mockRejectedValue(new CtxUnavailableError('down'));
    const res = await getAccountHandler(makeCtx({}));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('SUPPLIER_UNAVAILABLE');
  });

  it('502s when the CTX payload fails validation', async () => {
    ctx.fetchCtxAccount.mockRejectedValue(new CtxAccountShapeError('bad shape'));
    const res = await getAccountHandler(makeCtx({}));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe('SUPPLIER_ERROR');
  });
});

describe('linkWalletHandler', () => {
  it('rejects an empty address before reaching CTX', async () => {
    const res = await linkWalletHandler(makeCtx({ body: { address: '   ' } }));
    expect(res.status).toBe(400);
    expect(ctx.linkCtxWallet).not.toHaveBeenCalled();
  });

  it('forwards any non-empty address and lets CTX validate the key', async () => {
    ctx.linkCtxWallet.mockRejectedValue(
      new CtxAccountRequestError(400, 'bad request', { address: ['invalid'] }),
    );
    const res = await linkWalletHandler(makeCtx({ body: { address: 'nope' } }));
    expect(ctx.linkCtxWallet).toHaveBeenCalledWith(
      { ctxUserId: 'ctx-1' },
      { chain: 'XLM', address: 'nope' },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe('address: invalid');
  });

  it('defaults the chain to XLM and forwards a trimmed address', async () => {
    ctx.linkCtxWallet.mockResolvedValue(link());
    const res = await linkWalletHandler(makeCtx({ body: { address: `  ${ADDRESS} ` } }));
    expect(res.status).toBe(201);
    expect(ctx.linkCtxWallet).toHaveBeenCalledWith(
      { ctxUserId: 'ctx-1' },
      { chain: 'XLM', address: ADDRESS },
    );
  });

  it('forwards an explicit autoPayout flag', async () => {
    ctx.linkCtxWallet.mockResolvedValue(link({ autoPayout: false }));
    await linkWalletHandler(makeCtx({ body: { address: ADDRESS, autoPayout: false } }));
    expect(ctx.linkCtxWallet).toHaveBeenCalledWith(
      { ctxUserId: 'ctx-1' },
      { chain: 'XLM', address: ADDRESS, autoPayout: false },
    );
  });

  it('maps a CTX field validation failure to a 400 naming the field', async () => {
    ctx.linkCtxWallet.mockRejectedValue(
      new CtxAccountRequestError(400, 'bad request', { address: ['invalid'] }),
    );
    const res = await linkWalletHandler(makeCtx({ body: { address: ADDRESS } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe('address: invalid');
  });

  it('503s on any other CTX rejection', async () => {
    ctx.linkCtxWallet.mockRejectedValue(new CtxAccountRequestError(500, 'server error', null));
    const res = await linkWalletHandler(makeCtx({ body: { address: ADDRESS } }));
    expect(res.status).toBe(503);
  });
});

describe('updateWalletHandler', () => {
  it('requires a boolean autoPayout', async () => {
    const res = await updateWalletHandler(
      makeCtx({ params: { walletId: 'w-1' }, body: { autoPayout: 'yes' } }),
    );
    expect(res.status).toBe(400);
    expect(ctx.updateCtxWallet).not.toHaveBeenCalled();
  });

  it('forwards the toggle to the wallet id', async () => {
    ctx.updateCtxWallet.mockResolvedValue(link({ autoPayout: false }));
    const res = await updateWalletHandler(
      makeCtx({ params: { walletId: 'w-1' }, body: { autoPayout: false } }),
    );
    expect(res.status).toBe(200);
    expect(ctx.updateCtxWallet).toHaveBeenCalledWith({ ctxUserId: 'ctx-1' }, 'w-1', {
      autoPayout: false,
    });
  });

  it('404s when CTX has no such link', async () => {
    ctx.updateCtxWallet.mockRejectedValue(new CtxAccountRequestError(404, 'not found', null));
    const res = await updateWalletHandler(
      makeCtx({ params: { walletId: 'gone' }, body: { autoPayout: false } }),
    );
    expect(res.status).toBe(404);
  });
});

describe('unlinkWalletHandler', () => {
  it('returns the removed link', async () => {
    ctx.unlinkCtxWallet.mockResolvedValue(
      link({ status: 'removed', removed: '2026-09-23T11:00:00Z' }),
    );
    const res = await unlinkWalletHandler(makeCtx({ params: { walletId: 'w-1' } }));
    expect(res.status).toBe(200);
    expect(ctx.unlinkCtxWallet).toHaveBeenCalledWith({ ctxUserId: 'ctx-1' }, 'w-1');
    expect(((await res.json()) as WalletLinkView).status).toBe('removed');
  });

  it('400s on an empty wallet id', async () => {
    const res = await unlinkWalletHandler(makeCtx({ params: { walletId: '' } }));
    expect(res.status).toBe(400);
    expect(ctx.unlinkCtxWallet).not.toHaveBeenCalled();
  });
});

describe('savings handlers', () => {
  const operation = {
    id: 'sop-1',
    type: 'deposit',
    potId: 'pot-1',
    status: 'complete',
    currency: 'XLM.USDC',
    amount: '1.0000000',
    created: '2026-09-23T10:00:00Z',
    finalisedAt: '2026-09-23T10:00:01Z',
    error: null,
  };

  beforeEach(() => {
    state.user = { id: 'u-1', ctxUserId: 'ctx-1' };
    ctx.depositCtxSavings.mockReset();
    ctx.withdrawCtxSavings.mockReset();
  });

  it('400 when the amount is not a positive decimal', async () => {
    const res = await depositSavingsHandler(
      makeCtx({ body: { currency: 'XLM.USDC', amount: '-1' } }),
    );
    expect(res.status).toBe(400);
    expect(ctx.depositCtxSavings).not.toHaveBeenCalled();
  });

  it('deposits acting as the customer and returns 201 with the operation', async () => {
    ctx.depositCtxSavings.mockResolvedValueOnce(operation);
    const res = await depositSavingsHandler(
      makeCtx({ body: { currency: 'xlm.usdc', amount: '1' }, clientId: 'loopios' }),
    );
    expect(res.status).toBe(201);
    expect(ctx.depositCtxSavings).toHaveBeenCalledWith(
      { ctxUserId: 'ctx-1', clientId: 'loopios' },
      { currency: 'XLM.USDC', amount: '1' },
    );
    expect(await res.json()).toEqual(operation);
  });

  it('maps a CTX lock refusal to a 400 with the supplier message', async () => {
    ctx.withdrawCtxSavings.mockRejectedValueOnce(
      new CtxAccountRequestError(
        400,
        'part of this savings balance is still within its lock period',
        null,
      ),
    );
    const res = await withdrawSavingsHandler(
      makeCtx({ body: { currency: 'XLM.USDC', amount: '5' } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.message).toMatch(/lock period/);
  });

  it('503 while the user has no CTX mapping yet', async () => {
    state.user = { id: 'u-1', ctxUserId: null };
    state.resolvedCtxUserId = null;
    const res = await withdrawSavingsHandler(
      makeCtx({ body: { currency: 'XLM.USDC', amount: '1' } }),
    );
    expect(res.status).toBe(503);
  });
});
