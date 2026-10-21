import type { Context } from 'hono';
import { z } from 'zod';
import type { SavingsOperationView, UserAccountView, WalletLinkView } from '@loop/shared';
import { logger } from '../logger.js';
import { CtxRateLimitedError, CtxUnavailableError } from '../ctx/api-fetch.js';
import {
  CtxAccountRequestError,
  CtxAccountShapeError,
  depositCtxSavings,
  fetchCtxAccount,
  linkCtxWallet,
  unlinkCtxWallet,
  updateCtxWallet,
  withdrawCtxSavings,
} from '../ctx/account.js';
import { resolveCallingUser } from './handler.js';

const log = logger.child({ handler: 'user-account' });

const LinkWalletBody = z.object({
  chain: z.literal('XLM').default('XLM'),
  address: z.string().trim().min(1, 'address is required').max(256),
  autoPayout: z.boolean().optional(),
});

const UpdateWalletBody = z.object({
  autoPayout: z.boolean(),
});

const WalletIdParam = z.string().min(1).max(128);

const SavingsMoveBody = z.object({
  currency: z.string().trim().min(1, 'currency is required').max(32).toUpperCase(),
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, 'amount must be a positive decimal')
    .refine((value) => Number(value) > 0, 'amount must be greater than zero'),
});

interface ActAs {
  ctxUserId: string;
  clientId?: string;
}

async function resolveActAs(c: Context): Promise<ActAs | Response> {
  let ctxUserId: string;
  try {
    const user = await resolveCallingUser(c);
    if (user === null) {
      return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
    }
    ctxUserId = user.id;
  } catch (err) {
    log.error({ err }, 'Failed to resolve calling user');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to resolve user' }, 500);
  }
  const clientId = c.get('clientId') as string | undefined;
  return clientId === undefined ? { ctxUserId } : { ctxUserId, clientId };
}

function fieldMessage(fields: Record<string, string[]> | null): string | null {
  if (fields === null) return null;
  const [field, issues] = Object.entries(fields)[0] ?? [];
  if (field === undefined || issues === undefined || issues.length === 0) return null;
  return `${field}: ${issues.join(', ')}`;
}

function supplierErrorResponse(c: Context, err: unknown, action: string): Response {
  if (err instanceof CtxAccountRequestError) {
    if (err.status === 400) {
      return c.json(
        { code: 'VALIDATION_ERROR', message: fieldMessage(err.fields) ?? err.message },
        400,
      );
    }
    if (err.status === 404) {
      return c.json({ code: 'NOT_FOUND', message: err.message || 'Not found' }, 404);
    }
    log.error({ status: err.status, message: err.message }, `CTX ${action} rejected`);
    return c.json({ code: 'SUPPLIER_UNAVAILABLE', message: `Unable to ${action} right now` }, 503);
  }
  if (err instanceof CtxAccountShapeError) {
    log.error({ err }, `CTX ${action} returned an unexpected shape`);
    return c.json({ code: 'SUPPLIER_ERROR', message: 'Unexpected supplier response' }, 502);
  }
  const transient = err instanceof CtxUnavailableError || err instanceof CtxRateLimitedError;
  log.error({ err, transient }, `CTX ${action} failed`);
  return c.json({ code: 'SUPPLIER_UNAVAILABLE', message: `Unable to ${action} right now` }, 503);
}

export async function getAccountHandler(c: Context): Promise<Response> {
  const actAs = await resolveActAs(c);
  if (actAs instanceof Response) return actAs;
  try {
    return c.json<UserAccountView>(await fetchCtxAccount(actAs));
  } catch (err) {
    return supplierErrorResponse(c, err, 'load your account');
  }
}

export async function linkWalletHandler(c: Context): Promise<Response> {
  const parsed = LinkWalletBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid body' },
      400,
    );
  }
  const actAs = await resolveActAs(c);
  if (actAs instanceof Response) return actAs;
  try {
    const { chain, address, autoPayout } = parsed.data;
    const link = await linkCtxWallet(actAs, {
      chain,
      address,
      ...(autoPayout !== undefined ? { autoPayout } : {}),
    });
    log.info({ ctxUserId: actAs.ctxUserId, walletId: link.id }, 'wallet linked');
    return c.json<WalletLinkView>(link, 201);
  } catch (err) {
    return supplierErrorResponse(c, err, 'link the wallet');
  }
}

export async function updateWalletHandler(c: Context): Promise<Response> {
  const walletId = WalletIdParam.safeParse(c.req.param('walletId'));
  if (!walletId.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid wallet id' }, 400);
  }
  const parsed = UpdateWalletBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'autoPayout must be a boolean' }, 400);
  }
  const actAs = await resolveActAs(c);
  if (actAs instanceof Response) return actAs;
  try {
    return c.json<WalletLinkView>(await updateCtxWallet(actAs, walletId.data, parsed.data));
  } catch (err) {
    return supplierErrorResponse(c, err, 'update the wallet');
  }
}

export async function depositSavingsHandler(c: Context): Promise<Response> {
  return moveSavings(c, depositCtxSavings, 'deposit into savings');
}

export async function withdrawSavingsHandler(c: Context): Promise<Response> {
  return moveSavings(c, withdrawCtxSavings, 'withdraw from savings');
}

async function moveSavings(
  c: Context,
  move: typeof depositCtxSavings,
  action: string,
): Promise<Response> {
  const parsed = SavingsMoveBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid body' },
      400,
    );
  }
  const actAs = await resolveActAs(c);
  if (actAs instanceof Response) return actAs;
  try {
    const operation = await move(actAs, parsed.data);
    log.info(
      { ctxUserId: actAs.ctxUserId, operationId: operation.id, status: operation.status },
      `savings ${operation.type} requested`,
    );
    return c.json<SavingsOperationView>(operation, 201);
  } catch (err) {
    return supplierErrorResponse(c, err, action);
  }
}

export async function unlinkWalletHandler(c: Context): Promise<Response> {
  const walletId = WalletIdParam.safeParse(c.req.param('walletId'));
  if (!walletId.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid wallet id' }, 400);
  }
  const actAs = await resolveActAs(c);
  if (actAs instanceof Response) return actAs;
  try {
    const link = await unlinkCtxWallet(actAs, walletId.data);
    log.info({ ctxUserId: actAs.ctxUserId, walletId: link.id }, 'wallet unlinked');
    return c.json<WalletLinkView>(link);
  } catch (err) {
    return supplierErrorResponse(c, err, 'unlink the wallet');
  }
}
