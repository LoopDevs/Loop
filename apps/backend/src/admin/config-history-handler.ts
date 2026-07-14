/**
 * `configHistoryHandler` — read-side audit-log handler for the
 * per-merchant cashback-config history (ADR 011).
 *
 * Lifted out of `apps/backend/src/admin/handler.ts` so the simple
 * read-side audit-log query lives in its own focused module
 * separate from the much larger `upsertConfigHandler`
 * (ADR-017-shaped write with idempotency-guard machinery) in the
 * parent file. Both handlers happen to share the same
 * `MERCHANT_ID_RE` / `MERCHANT_ID_MAX` validation regex; the
 * constants are small enough to duplicate verbatim here rather
 * than thread them through.
 *
 * Re-exported from `handler.ts` so the existing import path
 * (`'../admin/handler.js'`) used by `routes/admin-cashback-config.ts`
 * and the test suite keeps working unchanged.
 */
import type { Context } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { merchantCashbackConfigHistory } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-cashback-configs' });

// A2-513: match the shape check used by sibling per-merchant admin
// handlers (merchant-cashback-summary, merchant-top-earners, etc.) —
// catalog-id chars only, capped at 128. Keeps malformed IDs from
// reaching the DB as a parameterised SQL literal with surprising
// width.
const MERCHANT_ID_RE = /^[A-Za-z0-9._-]+$/;
const MERCHANT_ID_MAX = 128;

// Page size is a bounded, validated `?limit=` query param. Previously
// the row count was hardcoded to 50 with no caller control — no way to
// page a longer history and, more importantly, an unbounded literal is
// the kind of magic number a later "just bump it" edit turns into a
// full-table pull. `DEFAULT_LIMIT` preserves the prior fixed behaviour
// when the param is absent/invalid; `MAX_LIMIT` mirrors the sibling
// `admin/ledger.ts` ceiling so an admin can page but never request an
// unbounded window.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * GET /api/admin/merchant-cashback-configs/:merchantId/history
 *
 * `?limit=` optional; clamps to [1, MAX_LIMIT], defaults to
 * DEFAULT_LIMIT, and a non-numeric value falls back to the default
 * (never throws, never unbounded).
 */
export async function configHistoryHandler(c: Context): Promise<Response> {
  const merchantId = c.req.param('merchantId');
  if (merchantId === undefined || merchantId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId required' }, 400);
  }
  if (merchantId.length > MERCHANT_ID_MAX || !MERCHANT_ID_RE.test(merchantId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId is malformed' }, 400);
  }
  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? String(DEFAULT_LIMIT), 10);
  const limit = Math.min(
    Math.max(Number.isNaN(parsedLimit) ? DEFAULT_LIMIT : parsedLimit, 1),
    MAX_LIMIT,
  );
  try {
    const rows = await db
      .select()
      .from(merchantCashbackConfigHistory)
      .where(eq(merchantCashbackConfigHistory.merchantId, merchantId))
      .orderBy(desc(merchantCashbackConfigHistory.changedAt))
      .limit(limit);
    return c.json({ history: rows });
  } catch (err) {
    log.error({ err, merchantId }, 'admin config-history query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load config history' }, 500);
  }
}
