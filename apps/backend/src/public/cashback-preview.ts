// public cashback-preview — ADR 011, ADR 015, ADR 020
import type { Context } from 'hono';
import { merchantSlug } from '@loop/shared';
import { db } from '../db/client.js';
import { getMerchants } from '../merchants/sync.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'public-cashback-preview' });

const MERCHANT_ID_RE = /^[A-Za-z0-9._-]+$/;
const MERCHANT_ID_MAX = 128;

// 100k USD cap prevents bigint-smuggling and stays within JS-number precision
const AMOUNT_MINOR_MAX = 10_000_000;

// A2-676 + ADR 019: single source of truth in @loop/shared
export type { PublicCashbackPreview } from '@loop/shared';
import type { PublicCashbackPreview } from '@loop/shared';

function resolveMerchant(
  idOrSlug: string,
): { id: string; name: string; slug: string; currency: string } | null {
  const { merchantsById, merchantsBySlug } = getMerchants();
  const m = merchantsById.get(idOrSlug) ?? merchantsBySlug.get(idOrSlug);
  if (m === undefined) return null;
  return {
    id: m.id,
    name: m.name,
    // Country-aware slug ensures round-trip through by-slug index
    slug: merchantSlug(m),
    currency: m.denominations?.currency ?? 'USD',
  };
}

export function cashbackPctToBps(pct: string): number | null {
  const parsed = Number(pct);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null;
  return Math.round(parsed * 100);
}

export function previewCashbackMinor(amountMinor: bigint, bps: number): bigint {
  if (amountMinor <= 0n) return 0n;
  if (bps <= 0) return 0n;
  return (amountMinor * BigInt(bps)) / 10_000n;
}

export async function publicCashbackPreviewHandler(c: Context): Promise<Response> {
  // A4-094: 4xx envelopes carry short public Cache-Control to stabilize CDN cacheability
  const setShortPublicCache = (): void => {
    c.header('cache-control', 'public, max-age=60');
  };

  const merchantIdRaw = c.req.query('merchantId');
  if (merchantIdRaw === undefined || merchantIdRaw.length === 0) {
    setShortPublicCache();
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId is required' }, 400);
  }
  if (merchantIdRaw.length > MERCHANT_ID_MAX || !MERCHANT_ID_RE.test(merchantIdRaw)) {
    setShortPublicCache();
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId is malformed' }, 400);
  }

  const amountRaw = c.req.query('amountMinor');
  if (amountRaw === undefined || amountRaw.length === 0) {
    setShortPublicCache();
    return c.json({ code: 'VALIDATION_ERROR', message: 'amountMinor is required' }, 400);
  }
  // Rejects scientific notation, hex, and values past JS-number precision
  if (!/^\d+$/.test(amountRaw)) {
    setShortPublicCache();
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'amountMinor must be a non-negative integer' },
      400,
    );
  }
  let amountMinor: bigint;
  try {
    amountMinor = BigInt(amountRaw);
  } catch {
    setShortPublicCache();
    return c.json({ code: 'VALIDATION_ERROR', message: 'amountMinor is malformed' }, 400);
  }
  if (amountMinor <= 0n || amountMinor > BigInt(AMOUNT_MINOR_MAX)) {
    setShortPublicCache();
    return c.json({ code: 'VALIDATION_ERROR', message: 'amountMinor is out of range' }, 400);
  }

  const resolved = resolveMerchant(merchantIdRaw);
  if (resolved === null) {
    setShortPublicCache();
    return c.json({ code: 'NOT_FOUND', message: 'Merchant not found' }, 404);
  }

  let cashbackPct: string | null = null;
  try {
    const config = await db
      .collection('merchant_cashback_configs')
      .findOne({ merchantId: resolved.id, active: true });
    cashbackPct = config !== null ? config.userCashbackPct.toFixed(2) : null;
  } catch (err) {
    // ADR 020: never 500; serve soft empty on ledger failure
    log.warn({ err, merchantId: resolved.id }, 'Cashback config read failed — soft empty');
    c.header('cache-control', 'public, max-age=60');
    return c.json<PublicCashbackPreview>({
      merchantId: resolved.slug,
      merchantName: resolved.name,
      orderAmountMinor: amountMinor.toString(),
      cashbackPct: null,
      cashbackMinor: '0',
      currency: resolved.currency,
    });
  }

  const bps = cashbackPct !== null ? cashbackPctToBps(cashbackPct) : null;
  const cashbackMinor = bps !== null ? previewCashbackMinor(amountMinor, bps) : 0n;

  c.header('cache-control', 'public, max-age=60');
  return c.json<PublicCashbackPreview>({
    merchantId: resolved.slug,
    merchantName: resolved.name,
    orderAmountMinor: amountMinor.toString(),
    cashbackPct,
    cashbackMinor: cashbackMinor.toString(),
    currency: resolved.currency,
  });
}
