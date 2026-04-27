/**
 * Admin — cashback-config endpoints (ADR 011). All routes expect
 * `requireAuth` + `requireAdmin` to have run; the admin's User row
 * is on `c.get('user')`.
 *
 * The list reader lives directly here. The ADR-017 upsert (with its
 * idempotency-guarded ladder, pre-edit snapshot for the Discord
 * diff, and post-commit audit fanout) lives in
 * `./upsert-config-handler.ts` and is re-exported below so existing
 * import sites keep resolving.
 */
import type { Context } from 'hono';
import { db } from '../db/client.js';
import { merchantCashbackConfigs } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-cashback-configs' });

/** GET /api/admin/merchant-cashback-configs */
export async function listConfigsHandler(c: Context): Promise<Response> {
  try {
    const rows = await db
      .select()
      .from(merchantCashbackConfigs)
      .orderBy(merchantCashbackConfigs.merchantId);
    return c.json({ configs: rows });
  } catch (err) {
    // A2-507: keep the handler-scoped logger binding so the request-id
    // correlates an /admin/cashback-configs load failure with this log
    // line rather than the generic global onError message.
    log.error({ err }, 'admin list-configs query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load cashback configs' }, 500);
  }
}

// `upsertConfigHandler` (the ADR-017 admin write — idempotency-
// guarded ladder, pre-edit snapshot, post-commit audit fanout)
// lives in `./upsert-config-handler.ts`. Re-exported here so
// `routes/admin-cashback-config.ts` and the test suite keep
// resolving against `'../admin/handler.js'`.
export { upsertConfigHandler, type CashbackConfigResult } from './upsert-config-handler.js';

// `configHistoryHandler` (the read-side audit-log query) lives
// in `./config-history-handler.ts`. Re-exported here so
// `routes/admin-cashback-config.ts` and the test suite keep
// resolving against `'../admin/handler.js'`.
export { configHistoryHandler } from './config-history-handler.js';
