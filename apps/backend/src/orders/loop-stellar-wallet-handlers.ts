// Connected-wallet pay passthrough for Stellar orders — ADR 052
import type { Context } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import type { LoopAuthContext } from '../auth/handler.js';
import { ctxFetch } from '../ctx/api-fetch.js';
import { upstreamUrl } from '../upstream.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import type { LoopStellarSubmitResponse, LoopStellarTransactionResponse } from '@loop/shared';

const log = logger.child({ area: 'loop-stellar-wallet' });

const CTX_CALL_TIMEOUT_MS = 20_000;

const STELLAR_ACCOUNT = /^G[A-Z2-7]{55}$/;

const TransactionBody = z.object({
  source: z.string().regex(STELLAR_ACCOUNT, 'source must be a Stellar account id'),
});

const SubmitBody = TransactionBody.extend({
  signedXdr: z.string().min(1, 'signedXdr is required').max(65_536),
});

const CtxTransactionResponse = z.looseObject({
  xdr: z.string().min(1),
  networkPassphrase: z.string().min(1),
});

const CtxSubmitResponse = z.looseObject({ txId: z.string().min(1) });

const CtxErrorBody = z.looseObject({ message: z.string().optional() });

export async function loopStellarTransactionHandler(c: Context): Promise<Response> {
  return relayStellarWalletCall(c, 'transaction', TransactionBody, CtxTransactionResponse);
}

export async function loopStellarSubmitHandler(c: Context): Promise<Response> {
  return relayStellarWalletCall(c, 'submit', SubmitBody, CtxSubmitResponse);
}

type StellarWalletAction = 'transaction' | 'submit';

async function relayStellarWalletCall<
  TBody extends z.ZodTypeAny,
  TResponse extends z.ZodType<LoopStellarTransactionResponse | LoopStellarSubmitResponse>,
>(
  c: Context,
  action: StellarWalletAction,
  bodySchema: TBody,
  responseSchema: TResponse,
): Promise<Response> {
  if (!config.auth.native.enabled) {
    return c.json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
  }
  const auth = c.get('auth') as LoopAuthContext | undefined;
  if (auth === undefined || auth.kind !== 'loop') {
    return c.json({ code: 'UNAUTHORIZED', message: 'Loop-native authentication required' }, 401);
  }
  const id = c.req.param('id');
  if (id === undefined || id.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'id is required' }, 400);
  }

  const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid body' },
      400,
    );
  }

  const row = await db.collection('orders').findOne({ id, userId: auth.userId });
  if (row === null) {
    return c.json({ code: 'NOT_FOUND', message: 'Order not found' }, 404);
  }
  if (row.state !== 'unpaid' || row.ctxPaymentId === null) {
    return c.json(
      { code: 'ORDER_NOT_PAYABLE', message: 'This order is not awaiting payment' },
      409,
    );
  }

  let res: Response;
  try {
    res = await ctxFetch(
      upstreamUrl(`/payments/${encodeURIComponent(row.ctxPaymentId)}/stellar/${action}`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(parsed.data),
        signal: AbortSignal.timeout(CTX_CALL_TIMEOUT_MS),
      },
      { actAs: { userId: auth.userId, clientId: c.get('clientId') as string | undefined } },
    );
  } catch (err) {
    log.error({ orderId: row.id, action, err }, 'CTX stellar wallet call failed');
    return c.json(
      { code: 'SUPPLIER_UNAVAILABLE', message: 'Unable to reach the payment processor' },
      503,
    );
  }

  if (!res.ok) {
    const text = scrubUpstreamBody(await res.text().catch(() => ''));
    if (res.status === 400) {
      const message = ctxErrorMessage(text) ?? 'The payment processor rejected this transaction';
      return c.json({ code: 'WALLET_PAYMENT_REJECTED', message }, 400);
    }
    log.warn(
      { orderId: row.id, action, status: res.status, body: text.slice(0, 300) },
      'CTX stellar wallet call returned an error',
    );
    return c.json(
      { code: 'SUPPLIER_UNAVAILABLE', message: 'Unable to reach the payment processor' },
      503,
    );
  }

  const body = responseSchema.safeParse(await res.json().catch(() => null));
  if (!body.success) {
    log.error({ orderId: row.id, action }, 'CTX stellar wallet response schema drift');
    return c.json(
      { code: 'SUPPLIER_UNAVAILABLE', message: 'Unexpected response from the payment processor' },
      503,
    );
  }
  return c.json(body.data);
}

function ctxErrorMessage(text: string): string | null {
  try {
    const parsed = CtxErrorBody.safeParse(JSON.parse(text));
    if (parsed.success && parsed.data.message !== undefined && parsed.data.message.length > 0) {
      return parsed.data.message;
    }
  } catch {
    /* non-JSON upstream error body */
  }
  return null;
}
