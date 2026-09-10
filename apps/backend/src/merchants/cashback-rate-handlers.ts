// public merchant-cashback-rate handlers — ADR 011, ADR 015, ADR 020
import type { Context } from 'hono';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { getMerchants } from './sync.js';

const log = logger.child({ handler: 'merchants' });

export async function merchantsCashbackRatesHandler(c: Context): Promise<Response> {
  // A2-664 / A2-1006 — ADR-020 never-500. Soft-fail to empty map with shorter cache window.
  let rows: Array<{ merchantId: string; userCashbackPct: string }>;
  try {
    const configs = await db.collection('merchant_cashback_configs').findMany({ active: true });
    rows = configs.map((c2) => ({
      merchantId: c2.merchantId,
      userCashbackPct: c2.userCashbackPct.toFixed(2),
    }));
  } catch (err) {
    log.warn({ err }, 'merchant-cashback-rates DB read failed — serving empty');
    c.header('Cache-Control', 'public, max-age=60');
    return c.json({ rates: {} });
  }

  // COR-14 — drop rows for merchants not in live catalog to prevent leaking hidden configs.
  const { merchantsById } = getMerchants();

  const rates: Record<string, string> = {};
  for (const row of rows) {
    if (!merchantsById.has(row.merchantId)) continue;
    rates[row.merchantId] = row.userCashbackPct;
  }

  c.header('Cache-Control', 'public, max-age=300');
  return c.json({ rates });
}

export async function merchantCashbackRateHandler(c: Context): Promise<Response> {
  const id = c.req.param('merchantId') ?? '';
  if (!/^[\w-]+$/.test(id)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid merchant ID' }, 400);
  }

  const { merchantsById } = getMerchants();
  if (!merchantsById.has(id)) {
    return c.json({ code: 'NOT_FOUND', message: 'Merchant not found' }, 404);
  }

  // A2-665 — ADR-020 never-500. DB outage returns null to hide badge instead of 500.
  let row: { userCashbackPct: string } | undefined;
  try {
    const config = await db
      .collection('merchant_cashback_configs')
      .findOne({ merchantId: id, active: true });
    row = config !== null ? { userCashbackPct: config.userCashbackPct.toFixed(2) } : undefined;
  } catch (err) {
    log.warn({ err, merchantId: id }, 'merchant-cashback-rate DB read failed — serving null');
    c.header('Cache-Control', 'public, max-age=60');
    return c.json({ merchantId: id, userCashbackPct: null });
  }

  c.header('Cache-Control', 'public, max-age=300');
  return c.json({
    merchantId: id,
    userCashbackPct: row?.userCashbackPct ?? null,
  });
}
