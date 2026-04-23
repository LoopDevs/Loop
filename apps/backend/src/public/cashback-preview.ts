/**
 * Public cashback-preview endpoint (ADR 011 / 015 / 020).
 *
 * `GET /api/public/cashback-preview?merchantId=<id-or-slug>&amountMinor=<n>`
 * — returns the cashback a user would earn on a would-be order of
 * `amountMinor` at `merchantId`. Unauthenticated, CDN-friendly;
 * drives marketing-site calculators and pre-signup conversion
 * copy ("you'd earn $2.50 cashback on a $100 Amazon gift card").
 *
 * Shape:
 *   {
 *     merchantId: "amazon-us",
 *     merchantName: "Amazon",
 *     orderAmountMinor: "10000",     // echo of the requested amount
 *     cashbackPct: "2.50" | null,     // numeric string or null when no config
 *     cashbackMinor: "250",           // floor(amount × pct / 10000)
 *     currency: "USD",                // merchant's catalog currency
 *   }
 *
 * Cashback math matches `orders/cashback-split.ts`:
 *   cashbackMinor = floor(amountMinor × userCashbackPct × 100 / 10_000)
 * — keeping the same rounding direction as the order-insert path
 * so the preview never promises more than the user will actually
 * earn.
 *
 * Public-first conventions (ADR 020):
 *   - Never 500; malformed params get 400 with a stable error code.
 *   - Unknown merchant id → 404.
 *   - Missing active config → 200 with `cashbackPct: null,
 *     cashbackMinor: "0"` so the caller can still render the
 *     "no active cashback" empty state without a second query.
 *   - `Cache-Control: public, max-age=60` — shorter than
 *     `/api/public/merchants/:id` (300s) because the amount is a
 *     URL param and a stale preview is user-visible.
 *   - No PII, no commercial-terms (wholesale/margin) fields.
 */
import type { Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { merchantSlug } from '@loop/shared';
import { db } from '../db/client.js';
import { merchantCashbackConfigs } from '../db/schema.js';
import { getMerchants } from '../merchants/sync.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'public-cashback-preview' });

const MERCHANT_ID_RE = /^[A-Za-z0-9._-]+$/;
const MERCHANT_ID_MAX = 128;

/**
 * Max amount accepted by `?amountMinor=`. 10 000 000 minor = $100 000,
 * well above realistic gift-card sizes. Rejects accidental overflows /
 * bigint-smuggling attempts while staying safely inside JS-number
 * precision for the multiplication.
 */
const AMOUNT_MINOR_MAX = 10_000_000;

export interface PublicCashbackPreview {
  merchantId: string;
  merchantName: string;
  /** Echo of the caller-supplied amount as bigint-as-string. */
  orderAmountMinor: string;
  /** numeric(5,2) string (e.g. "2.50"). Null when no active config. */
  cashbackPct: string | null;
  /** Computed cashback amount (floor). BigInt as string. `"0"` when no config. */
  cashbackMinor: string;
  /** Merchant's catalog currency — same value the ordering flow charges in. */
  currency: string;
}

function resolveMerchant(idOrSlug: string): { id: string; name: string; currency: string } | null {
  const { merchantsById, merchantsBySlug } = getMerchants();
  const byId = merchantsById.get(idOrSlug);
  if (byId !== undefined) {
    return { id: byId.id, name: byId.name, currency: byId.currency };
  }
  const bySlug = merchantsBySlug.get(idOrSlug);
  if (bySlug !== undefined) {
    return { id: bySlug.id, name: bySlug.name, currency: bySlug.currency };
  }
  return null;
}

/**
 * `pct` is a `numeric(5,2)` string — "2.50", "10.00". Multiplying by
 * 100 turns it into hundredths of a percent (bps compatible with the
 * 10_000 scale used elsewhere): "2.50" → 250 bps.
 *
 * Returns null on malformed input so the caller can shortcut to the
 * "no cashback" response without exploding.
 */
export function cashbackPctToBps(pct: string): number | null {
  const parsed = Number(pct);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null;
  return Math.round(parsed * 100);
}

/**
 * Amount × bps / 10 000, rounded down to the nearest minor unit.
 * BigInt math end-to-end so a $100 000 amount at 2.50% doesn't lose
 * precision. Exported for unit testing the rounding contract.
 */
export function previewCashbackMinor(amountMinor: bigint, bps: number): bigint {
  if (amountMinor <= 0n) return 0n;
  if (bps <= 0) return 0n;
  return (amountMinor * BigInt(bps)) / 10_000n;
}

export async function publicCashbackPreviewHandler(c: Context): Promise<Response> {
  const merchantIdRaw = c.req.query('merchantId');
  if (merchantIdRaw === undefined || merchantIdRaw.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId is required' }, 400);
  }
  if (merchantIdRaw.length > MERCHANT_ID_MAX || !MERCHANT_ID_RE.test(merchantIdRaw)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId is malformed' }, 400);
  }

  const amountRaw = c.req.query('amountMinor');
  if (amountRaw === undefined || amountRaw.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'amountMinor is required' }, 400);
  }
  // Only accept non-negative integer strings so "1e5", "0x10", and
  // bigint-smuggling "99999999999999999999" (past JS-number precision
  // AND the ceiling) all fail validation uniformly.
  if (!/^\d+$/.test(amountRaw)) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'amountMinor must be a non-negative integer' },
      400,
    );
  }
  let amountMinor: bigint;
  try {
    amountMinor = BigInt(amountRaw);
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'amountMinor is malformed' }, 400);
  }
  if (amountMinor <= 0n || amountMinor > BigInt(AMOUNT_MINOR_MAX)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'amountMinor is out of range' }, 400);
  }

  const resolved = resolveMerchant(merchantIdRaw);
  if (resolved === null) {
    return c.json({ code: 'NOT_FOUND', message: 'Merchant not found' }, 404);
  }

  let cashbackPct: string | null = null;
  try {
    const rows = (await db
      .select({ userCashbackPct: merchantCashbackConfigs.userCashbackPct })
      .from(merchantCashbackConfigs)
      .where(
        and(
          eq(merchantCashbackConfigs.merchantId, resolved.id),
          eq(merchantCashbackConfigs.active, true),
        ),
      )
      .limit(1)) as Array<{ userCashbackPct: string }>;
    cashbackPct = rows[0]?.userCashbackPct ?? null;
  } catch (err) {
    // Ledger-side failure → serve a soft "no cashback" response
    // rather than 500 per ADR 020 never-500. Cache short so we
    // don't pin the degraded answer for long.
    log.warn({ err, merchantId: resolved.id }, 'Cashback config read failed — soft empty');
    c.header('cache-control', 'public, max-age=60');
    return c.json<PublicCashbackPreview>({
      merchantId: merchantSlug(resolved.name),
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
    merchantId: merchantSlug(resolved.name),
    merchantName: resolved.name,
    orderAmountMinor: amountMinor.toString(),
    cashbackPct,
    cashbackMinor: cashbackMinor.toString(),
    currency: resolved.currency,
  });
}
