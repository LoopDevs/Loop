import { z } from 'zod';
import type {
  LinkWalletRequest,
  PayoutView,
  SavingsOperationView,
  UpdateWalletRequest,
  UserAccountView,
  WalletLinkView,
} from '@loop/shared';
import { upstreamUrl } from '../upstream.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import { ctxFetch } from './api-fetch.js';
import { ctxActAsHeaders } from './user-provisioning.js';

const FETCH_TIMEOUT_MS = 15_000;

const CtxBalanceSchema = z.object({ currency: z.string(), amount: z.string() }).passthrough();

const CtxSavingsPositionSchema = z
  .object({
    currency: z.string(),
    provider: z.string(),
    principal: z.string(),
    value: z.string(),
    earnt: z.string(),
  })
  .passthrough();

const CtxSavingsOperationSchema = z
  .object({
    id: z.string(),
    type: z.enum(['deposit', 'withdraw']),
    status: z.enum(['pending', 'processing', 'complete', 'failed']),
    currency: z.string(),
    amount: z.string(),
    created: z.string(),
    finalisedAt: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export const CtxWalletLinkSchema = z
  .object({
    id: z.string(),
    chain: z.literal('XLM'),
    address: z.string(),
    autoPayout: z.boolean(),
    status: z.enum(['active', 'removed']),
    created: z.string(),
    removed: z.string().optional(),
  })
  .passthrough();

const CtxPayoutSchema = z
  .object({
    id: z.string(),
    status: z.enum(['pending', 'complete', 'failed']),
    chain: z.literal('XLM'),
    address: z.string(),
    currency: z.string(),
    amount: z.string(),
    giftCardId: z.string().optional(),
    txHash: z.string().optional(),
    transferId: z.string().optional(),
    error: z.string().optional(),
    created: z.string(),
    finalised: z.string().optional(),
  })
  .passthrough();

export const CtxAccountSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    wallet: z.array(CtxBalanceSchema),
    savings: z.array(CtxSavingsPositionSchema),
    savingsPrincipal: z.array(CtxBalanceSchema),
    pendingOperations: z.array(CtxSavingsOperationSchema),
    linkedWallets: z.array(CtxWalletLinkSchema),
    payouts: z.array(CtxPayoutSchema),
    created: z.string(),
    updated: z.string(),
  })
  .passthrough();

const CtxValidationErrorSchema = z
  .object({ error: z.string(), fields: z.record(z.string(), z.array(z.string())).optional() })
  .passthrough();

export class CtxAccountRequestError extends Error {
  readonly status: number;
  readonly fields: Record<string, string[]> | null;
  constructor(status: number, message: string, fields: Record<string, string[]> | null) {
    super(message);
    this.name = 'CtxAccountRequestError';
    this.status = status;
    this.fields = fields;
  }
}

export class CtxAccountShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CtxAccountShapeError';
  }
}

function walletLinkToView(link: z.infer<typeof CtxWalletLinkSchema>): WalletLinkView {
  return {
    id: link.id,
    chain: link.chain,
    address: link.address,
    autoPayout: link.autoPayout,
    status: link.status,
    created: link.created,
    removed: link.removed ?? null,
  };
}

function payoutToView(payout: z.infer<typeof CtxPayoutSchema>): PayoutView {
  return {
    id: payout.id,
    status: payout.status,
    chain: payout.chain,
    address: payout.address,
    currency: payout.currency,
    amount: payout.amount,
    giftCardId: payout.giftCardId ?? null,
    txHash: payout.txHash ?? null,
    transferId: payout.transferId ?? null,
    error: payout.error ?? null,
    created: payout.created,
    finalised: payout.finalised ?? null,
  };
}

function savingsOperationToView(
  op: z.infer<typeof CtxSavingsOperationSchema>,
): SavingsOperationView {
  return {
    id: op.id,
    type: op.type,
    status: op.status,
    currency: op.currency,
    amount: op.amount,
    created: op.created,
    finalisedAt: op.finalisedAt ?? null,
    error: op.error ?? null,
  };
}

export function accountToView(account: z.infer<typeof CtxAccountSchema>): UserAccountView {
  return {
    id: account.id,
    userId: account.userId,
    wallet: account.wallet.map((b) => ({ currency: b.currency, amount: b.amount })),
    savings: account.savings.map((s) => ({
      currency: s.currency,
      provider: s.provider,
      principal: s.principal,
      value: s.value,
      earnt: s.earnt,
    })),
    savingsPrincipal: account.savingsPrincipal.map((b) => ({
      currency: b.currency,
      amount: b.amount,
    })),
    pendingOperations: account.pendingOperations.map(savingsOperationToView),
    linkedWallets: account.linkedWallets.map(walletLinkToView),
    payouts: account.payouts.map(payoutToView),
    created: account.created,
    updated: account.updated,
  };
}

interface ActAs {
  ctxUserId: string;
  clientId?: string;
}

async function ctxAccountRequest<T>(
  actAs: ActAs,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
): Promise<T> {
  const headers = ctxActAsHeaders(actAs.ctxUserId, actAs.clientId);
  if (headers === null)
    throw new CtxAccountRequestError(503, 'Supplier credentials unavailable', null);
  const res = await ctxFetch(upstreamUrl(path), {
    method,
    headers: {
      ...headers,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const raw = await res.text().catch(() => '');
  if (!res.ok) {
    let fields: Record<string, string[]> | null = null;
    let message = `CTX ${method} ${path} returned ${res.status}`;
    try {
      const parsed = CtxValidationErrorSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        message = parsed.data.error;
        fields = parsed.data.fields ?? null;
      }
    } catch {
      /* non-JSON error body */
    }
    throw new CtxAccountRequestError(res.status, message, fields);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new CtxAccountShapeError(
      `CTX ${method} ${path} returned non-JSON: ${scrubUpstreamBody(raw).slice(0, 200)}`,
    );
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new CtxAccountShapeError(
      `CTX ${method} ${path} response shape invalid: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function userPath(ctxUserId: string, suffix: string): string {
  return `/users/${encodeURIComponent(ctxUserId)}${suffix}`;
}

export async function fetchCtxAccount(actAs: ActAs): Promise<UserAccountView> {
  const account = await ctxAccountRequest(
    actAs,
    'GET',
    userPath(actAs.ctxUserId, '/account'),
    CtxAccountSchema,
  );
  return accountToView(account);
}

export async function linkCtxWallet(
  actAs: ActAs,
  body: LinkWalletRequest,
): Promise<WalletLinkView> {
  const link = await ctxAccountRequest(
    actAs,
    'POST',
    userPath(actAs.ctxUserId, '/wallets'),
    CtxWalletLinkSchema,
    body,
  );
  return walletLinkToView(link);
}

export async function updateCtxWallet(
  actAs: ActAs,
  walletId: string,
  body: UpdateWalletRequest,
): Promise<WalletLinkView> {
  const link = await ctxAccountRequest(
    actAs,
    'PUT',
    userPath(actAs.ctxUserId, `/wallets/${encodeURIComponent(walletId)}`),
    CtxWalletLinkSchema,
    body,
  );
  return walletLinkToView(link);
}

export async function unlinkCtxWallet(actAs: ActAs, walletId: string): Promise<WalletLinkView> {
  const link = await ctxAccountRequest(
    actAs,
    'DELETE',
    userPath(actAs.ctxUserId, `/wallets/${encodeURIComponent(walletId)}`),
    CtxWalletLinkSchema,
  );
  return walletLinkToView(link);
}
