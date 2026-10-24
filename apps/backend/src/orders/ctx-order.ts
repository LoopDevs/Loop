// CTX gift-card contract helpers — ADR 052
import { z } from 'zod';
import { logger } from '../logger.js';
import { ctxFetch } from '../ctx/api-fetch.js';
import { peekLoopCompany } from '../ctx/startup.js';
import { upstreamUrl } from '../upstream.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import type { LoopOrderPaymentInstructions, LoopOrderPaymentMethod } from '@loop/shared';

const log = logger.child({ area: 'ctx-order' });

const CTX_READ_TIMEOUT_MS = 10_000;
const CTX_LIST_PER_PAGE = 500;

// Returns null for unparseable input — callers treat as "snapshot unavailable", never zero
export function parseMajorToMinor(value: string | undefined): bigint | null {
  if (value === undefined) return null;
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (m === null) return null;
  const sign = m[1] === '-' ? -1n : 1n;
  const units = BigInt(m[2] ?? '0');
  const cents = BigInt((m[3] ?? '').padEnd(2, '0') || '0');
  return sign * (units * 100n + cents);
}

// Operator-only fields appear on operator-scope reads and ws topic, never on act-as create response
export const CtxGiftCardSchema = z
  .object({
    id: z.string().min(1),
    displayStatus: z.string().optional(),
    paymentStatus: z.string().optional(),
    fulfilmentStatus: z.string().optional(),
    paymentId: z.string().optional(),
    paymentMethod: z.string().optional(),
    paymentUrl: z.string().optional(),
    paymentFiatAmount: z.string().optional(),
    paymentFiatCurrency: z.string().optional(),
    cardFiatAmount: z.string().optional(),
    cardFiatCurrency: z.string().optional(),
    paymentCryptoAmount: z.string().optional(),
    paymentCryptoCurrency: z.string().optional(),
    paymentCryptoAddress: z.string().optional(),
    paymentUrls: z.record(z.string(), z.string()).optional(),
    userDiscountBasisPoints: z.number().optional(),
    operatorDiscountBasisPoints: z.number().optional(),
    operatorReference: z.string().optional(),
  })
  .passthrough();

export type CtxGiftCard = z.infer<typeof CtxGiftCardSchema>;

const CtxGiftCardListSchema = z
  .object({
    result: z.array(CtxGiftCardSchema).nullable(),
    pagination: z.object({ page: z.number(), pages: z.number() }).passthrough(),
  })
  .passthrough();

export const CtxPaymentSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().optional(),
    expires: z.string().optional(),
  })
  .passthrough();

export type CtxPayment = z.infer<typeof CtxPaymentSchema>;

// Returns null for unknown strings — schema drift is logged by the caller
export function mapCtxDisplayStatus(
  displayStatus: string,
): 'unpaid' | 'paid' | 'fulfilled' | 'rejected' | 'refunded' | 'expired' | null {
  switch (displayStatus) {
    case 'unpaid':
    case 'paid':
    case 'fulfilled':
    case 'rejected':
    case 'refunded':
    case 'expired':
      return displayStatus;
    default:
      return null;
  }
}

// Operator-scope read (API key, NO act-as) — only view carrying operatorReference / operatorDiscountBasisPoints
export async function fetchCtxCardAsOperator(ctxOrderId: string): Promise<CtxGiftCard> {
  const res = await ctxFetch(upstreamUrl(`/gift-cards/${encodeURIComponent(ctxOrderId)}`), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(CTX_READ_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = scrubUpstreamBody(await res.text().catch(() => ''));
    throw new Error(
      `CTX GET /gift-cards/${ctxOrderId} returned ${res.status}: ${body.slice(0, 200)}`,
    );
  }
  return CtxGiftCardSchema.parse(await res.json());
}

// Operator-scope list (no act-as scopes CTX to Loop's company); walks every page
export async function listCtxCardsAsOperator(
  displayStatuses: readonly string[],
): Promise<CtxGiftCard[]> {
  const cards: CtxGiftCard[] = [];
  for (let page = 1; ; page++) {
    const url = new URL(upstreamUrl('/gift-cards'));
    url.searchParams.set('status', displayStatuses.join(','));
    url.searchParams.set('perPage', String(CTX_LIST_PER_PAGE));
    url.searchParams.set('page', String(page));
    const res = await ctxFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CTX_READ_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = scrubUpstreamBody(await res.text().catch(() => ''));
      throw new Error(`CTX GET /gift-cards list returned ${res.status}: ${body.slice(0, 200)}`);
    }
    const parsed = CtxGiftCardListSchema.parse(await res.json());
    cards.push(...(parsed.result ?? []));
    if (page >= parsed.pagination.pages) break;
  }
  return cards;
}

export async function fetchCtxPayment(paymentId: string): Promise<CtxPayment | null> {
  try {
    const res = await ctxFetch(upstreamUrl(`/payments/${encodeURIComponent(paymentId)}`), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CTX_READ_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      return null;
    }
    return CtxPaymentSchema.parse(await res.json());
  } catch (err) {
    log.warn({ paymentId, err }, 'CTX payment read failed — payment details unavailable');
    return null;
  }
}

export function cardPaymentMethod(card: CtxGiftCard): LoopOrderPaymentMethod {
  return card.paymentMethod === undefined || card.paymentMethod === 'crypto' ? 'crypto' : 'fiat';
}

// Fail-soft: missing fields land as null so pay screen degrades rather than 500
export function paymentInstructionsFromCard(
  card: CtxGiftCard,
  payment: CtxPayment | null,
  fallback: { cryptoCurrency: string; amountMinor: bigint; currency: string },
): LoopOrderPaymentInstructions {
  const method = cardPaymentMethod(card);
  const currency = card.paymentFiatCurrency ?? fallback.currency;
  const paymentCurrency =
    method === 'fiat' ? currency : (card.paymentCryptoCurrency ?? fallback.cryptoCurrency);
  const fiatPaymentUrls =
    card.paymentUrl !== undefined ? { [paymentCurrency]: card.paymentUrl } : {};
  return {
    ctxPaymentId: card.paymentId ?? payment?.id ?? null,
    method,
    cryptoCurrency: paymentCurrency,
    cryptoAmount: method === 'fiat' ? null : (card.paymentCryptoAmount ?? null),
    address: method === 'fiat' ? null : (card.paymentCryptoAddress ?? null),
    paymentUrls: method === 'fiat' ? fiatPaymentUrls : (card.paymentUrls ?? {}),
    amountMinor: (parseMajorToMinor(card.paymentFiatAmount) ?? fallback.amountMinor).toString(),
    currency,
    expiresAt: payment?.expires ?? null,
  };
}

export async function operatorProfitShareBp(): Promise<number | null> {
  return peekLoopCompany()?.profitShareBasisPoints ?? null;
}

export async function operatorCompanyId(): Promise<string | null> {
  return peekLoopCompany()?.id ?? null;
}

// Mirrors CTX accrual (flow_commission.go: CardFiatAmount.Split(spread).Split(profitShare), floors at each step)
// Null when any input unavailable — mirror sweep retries via card re-read; null is "unknown", never zero
export function deriveOrderEconomics(
  card: CtxGiftCard,
  profitShareBp: number | null,
): { userCashbackMinor: bigint | null; expectedCommissionMinor: bigint | null } {
  const cardFiatMinor = parseMajorToMinor(card.cardFiatAmount);
  const userBp = card.userDiscountBasisPoints;
  if (cardFiatMinor === null || userBp === undefined) {
    return { userCashbackMinor: null, expectedCommissionMinor: null };
  }
  const userCashbackMinor = (cardFiatMinor * BigInt(Math.round(userBp))) / 10_000n;
  const operatorBp = card.operatorDiscountBasisPoints;
  if (operatorBp === undefined || profitShareBp === null) {
    return { userCashbackMinor, expectedCommissionMinor: null };
  }
  const spreadBp = BigInt(Math.round(operatorBp)) - BigInt(Math.round(userBp));
  if (spreadBp <= 0n || profitShareBp <= 0) {
    return { userCashbackMinor, expectedCommissionMinor: 0n };
  }
  const spreadMinor = (cardFiatMinor * spreadBp) / 10_000n;
  const expectedCommissionMinor = (spreadMinor * BigInt(Math.round(profitShareBp))) / 10_000n;
  return { userCashbackMinor, expectedCommissionMinor };
}
