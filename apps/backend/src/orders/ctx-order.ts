/**
 * CTX gift-card contract helpers (ADR 052).
 *
 * ctx is the payment processor: Loop creates the gift card acting-as
 * the customer, relays CTX's payment instructions to the client, and
 * mirrors CTX's `displayStatus`. This module owns the Zod schemas for
 * the CTX card + payment JSON, the operator-scope reads, and the
 * per-order economics derivation (user cashback + expected
 * commission) captured from the operator read-back.
 *
 * Amount convention: CTX serialises fiat as major-unit decimal
 * strings ("25.00"); Loop stores minor-unit bigints. All fiat
 * currencies Loop sells in are 2-decimal (see `orders_currency_known`),
 * so the conversion is a fixed ×100.
 */
import { z } from 'zod';
import { logger } from '../logger.js';
import { ctxFetch } from '../ctx/api-fetch.js';
import { upstreamUrl } from '../upstream.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import type { LoopOrderPaymentInstructions } from '@loop/shared';

const log = logger.child({ area: 'ctx-order' });

const CTX_READ_TIMEOUT_MS = 10_000;

/**
 * Parses a CTX major-unit decimal string ("25", "12.34") into
 * 2-decimal minor units. Returns null for anything unparseable —
 * callers treat that as "snapshot unavailable", never as zero.
 */
export function parseMajorToMinor(value: string | undefined): bigint | null {
  if (value === undefined) return null;
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (m === null) return null;
  const sign = m[1] === '-' ? -1n : 1n;
  const units = BigInt(m[2] ?? '0');
  const cents = BigInt((m[3] ?? '').padEnd(2, '0') || '0');
  return sign * (units * 100n + cents);
}

/**
 * The slice of CTX's gift-card JSON Loop consumes. `.passthrough()`
 * everywhere — CTX adds fields freely and only these are load-bearing.
 * The operator-only fields (`operatorReference`, `operatorDiscount`,
 * `userDiscount`) appear on operator-scope reads and on the giftcard
 * ws topic, never on the act-as create response.
 */
export const CtxGiftCardSchema = z
  .object({
    id: z.string().min(1),
    displayStatus: z.string().optional(),
    paymentStatus: z.string().optional(),
    fulfilmentStatus: z.string().optional(),
    paymentId: z.string().optional(),
    paymentFiatAmount: z.string().optional(),
    paymentFiatCurrency: z.string().optional(),
    cardFiatAmount: z.string().optional(),
    cardFiatCurrency: z.string().optional(),
    paymentCryptoAmount: z.string().optional(),
    paymentCryptoCurrency: z.string().optional(),
    paymentCryptoAddress: z.string().optional(),
    paymentUrls: z.record(z.string(), z.string()).optional(),
    userDiscount: z.number().optional(),
    operatorDiscount: z.number().optional(),
    operatorReference: z.string().optional(),
  })
  .passthrough();

export type CtxGiftCard = z.infer<typeof CtxGiftCardSchema>;

/** The slice of CTX's `GET /payments/:id` JSON Loop consumes. */
export const CtxPaymentSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().optional(),
    expires: z.string().optional(),
  })
  .passthrough();

export type CtxPayment = z.infer<typeof CtxPaymentSchema>;

/**
 * Maps a CTX `displayStatus` onto Loop's mirrored order state.
 * Returns null for a value Loop shouldn't act on (unknown strings —
 * schema drift is logged by the caller).
 */
export function mapCtxDisplayStatus(
  displayStatus: string,
): 'unpaid' | 'paid' | 'fulfilled' | 'rejected' | 'refunded' | null {
  switch (displayStatus) {
    case 'unpaid':
    case 'paid':
    case 'fulfilled':
    case 'rejected':
    case 'refunded':
      return displayStatus;
    default:
      return null;
  }
}

/**
 * Operator-scope card read (API key, NO act-as) — the only view that
 * carries `operatorReference` / `operatorDiscount`. Throws on non-ok.
 */
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

/** Operator-scope payment read — drives the pay-screen expiry + the mirror sweep's expiry check. */
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

/**
 * Builds the client-facing payment instructions from a CTX card (+
 * optional payment read for the expiry). Fail-soft: any missing field
 * lands as null so the pay screen can degrade rather than 500.
 */
export function paymentInstructionsFromCard(
  card: CtxGiftCard,
  payment: CtxPayment | null,
  fallback: { cryptoCurrency: string; amountMinor: bigint; currency: string },
): LoopOrderPaymentInstructions {
  return {
    ctxPaymentId: card.paymentId ?? payment?.id ?? null,
    cryptoCurrency: card.paymentCryptoCurrency ?? fallback.cryptoCurrency,
    cryptoAmount: card.paymentCryptoAmount ?? null,
    address: card.paymentCryptoAddress ?? null,
    paymentUrls: card.paymentUrls ?? {},
    amountMinor: (parseMajorToMinor(card.paymentFiatAmount) ?? fallback.amountMinor).toString(),
    currency: card.paymentFiatCurrency ?? fallback.currency,
    expiresAt: payment?.expires ?? null,
  };
}

/**
 * Loop's operator company on CTX (id + profit share in basis
 * points), resolved once per process from `GET /me` under the API
 * credentials and cached — both change only by a CTX-side system
 * write, at which point a process restart picks them up. A failed
 * resolution is not cached.
 */
const CtxMeCompanySchema = z
  .object({
    company: z
      .object({
        id: z.string().min(1),
        operatorProfitShareBasisPoints: z.number().optional(),
      })
      .passthrough(),
  })
  .passthrough();

interface CtxOperatorCompany {
  id: string;
  profitShareBp: number | null;
}

let cachedCompany: CtxOperatorCompany | null = null;

export function __resetProfitShareCacheForTests(): void {
  cachedCompany = null;
}

async function operatorCompany(): Promise<CtxOperatorCompany | null> {
  if (cachedCompany !== null) return cachedCompany;
  try {
    const res = await ctxFetch(upstreamUrl('/me'), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CTX_READ_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      return null;
    }
    const me = CtxMeCompanySchema.parse(await res.json());
    cachedCompany = {
      id: me.company.id,
      profitShareBp: me.company.operatorProfitShareBasisPoints ?? null,
    };
    return cachedCompany;
  } catch (err) {
    log.warn({ err }, 'CTX /me company read failed');
    return null;
  }
}

export async function operatorProfitShareBp(): Promise<number | null> {
  const company = await operatorCompany();
  return company?.profitShareBp ?? null;
}

/**
 * Loop's own company id in the CTX namespace — the merchant-link
 * bulk endpoint targets it (`targetEntityType: 'company'`).
 */
export async function operatorCompanyId(): Promise<string | null> {
  const company = await operatorCompany();
  return company?.id ?? null;
}

/**
 * Per-order economics from the operator read-back (ADR 052):
 *
 *   userCashbackMinor      = cardFiat × userDiscountBp / 10000
 *   expectedCommissionMinor = cardFiat × (operatorBp − userBp)/10000
 *                              × profitShareBp / 10000
 *
 * Mirrors CTX's accrual (`flow_commission.go`: CardFiatAmount
 * .Split(spread).Split(profitShare), floors at each step). Null when
 * any input is unavailable — the mirror sweep retries via the card
 * re-read; a null is "unknown", never zero.
 */
export function deriveOrderEconomics(
  card: CtxGiftCard,
  profitShareBp: number | null,
): { userCashbackMinor: bigint | null; expectedCommissionMinor: bigint | null } {
  const cardFiatMinor = parseMajorToMinor(card.cardFiatAmount);
  const userBp = card.userDiscount;
  if (cardFiatMinor === null || userBp === undefined) {
    return { userCashbackMinor: null, expectedCommissionMinor: null };
  }
  const userCashbackMinor = (cardFiatMinor * BigInt(Math.round(userBp))) / 10_000n;
  const operatorBp = card.operatorDiscount;
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
