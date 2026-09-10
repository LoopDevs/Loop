// /api/admin/* operational mounts — ADR 037
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { requireStaff } from '../auth/require-staff.js';
import { requireAdminStepUp } from '../auth/admin-step-up-middleware.js';
import {
  cashbackConfigsCsvHandler,
  configHistoryHandler,
  listConfigsHandler,
  upsertConfigHandler,
} from '../admin/cashback-configs.js';
import {
  adminMerchantsCatalogCsvHandler,
  adminMerchantStatsHandler,
  adminMerchantsResyncHandler,
} from '../admin/merchants.js';
import { adminDiscordConfigHandler, adminDiscordTestHandler } from '../admin/discord.js';
import { adminLookupHandler } from '../admin/lookup.js';
import { adminAuditTailCsvHandler, adminAuditTailHandler } from '../admin/audit-tail.js';

export function mountAdminOpsRoutes(app: Hono): void {
  app.get(
    '/api/admin/merchant-cashback-configs.csv',
    rateLimit('GET /api/admin/merchant-cashback-configs.csv', 10, 60_000),
    requireStaff('admin'),
    cashbackConfigsCsvHandler,
  );
  app.get(
    '/api/admin/merchant-cashback-configs',
    rateLimit('GET /api/admin/merchant-cashback-configs', 60, 60_000),
    listConfigsHandler,
  );
  app.get(
    '/api/admin/merchant-cashback-configs/:merchantId/history',
    rateLimit('GET /api/admin/merchant-cashback-configs/:merchantId/history', 60, 60_000),
    configHistoryHandler,
  );
  app.put(
    '/api/admin/merchant-cashback-configs/:merchantId',
    rateLimit('PUT /api/admin/merchant-cashback-configs/:merchantId', 10, 60_000),
    requireStaff('admin'),
    // Hardening B1: bound to the `'cashback-config'` scope.
    requireAdminStepUp('cashback-config'),
    upsertConfigHandler,
  );

  app.get(
    '/api/admin/merchants-catalog.csv',
    rateLimit('GET /api/admin/merchants-catalog.csv', 10, 60_000),
    requireStaff('admin'),
    adminMerchantsCatalogCsvHandler,
  );
  app.get(
    '/api/admin/merchant-stats',
    rateLimit('GET /api/admin/merchant-stats', 60, 60_000),
    adminMerchantStatsHandler,
  );
  // Every hit goes upstream to CTX, so the limit is deliberately
  // tighter than any other admin write. Not step-up gated: it creates
  // nothing and is self-correcting.
  app.post(
    '/api/admin/merchants/resync',
    rateLimit('POST /api/admin/merchants/resync', 2, 60_000),
    requireStaff('admin'),
    adminMerchantsResyncHandler,
  );

  // Admin-tier: knowing which alert channels exist, and being able to
  // post into them, is not part of the support remit.
  app.get(
    '/api/admin/discord/config',
    rateLimit('GET /api/admin/discord/config', 60, 60_000),
    requireStaff('admin'),
    adminDiscordConfigHandler,
  );
  // Not step-up gated: it changes no state beyond one outbound message.
  app.post(
    '/api/admin/discord/test',
    rateLimit('POST /api/admin/discord/test', 10, 60_000),
    requireStaff('admin'),
    adminDiscordTestHandler,
  );

  app.get('/api/admin/lookup', rateLimit('GET /api/admin/lookup', 60, 60_000), adminLookupHandler);
  app.get(
    '/api/admin/audit-tail.csv',
    rateLimit('GET /api/admin/audit-tail.csv', 10, 60_000),
    requireStaff('admin'),
    adminAuditTailCsvHandler,
  );
  app.get(
    '/api/admin/audit-tail',
    rateLimit('GET /api/admin/audit-tail', 60, 60_000),
    requireStaff('admin'),
    adminAuditTailHandler,
  );
}
