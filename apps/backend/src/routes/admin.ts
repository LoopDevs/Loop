// /api/admin/* route mounts — A2-1010, A2-2008, ADR 037, ADR 028, A4-063
import type { Context, Hono } from 'hono';
import { logger } from '../logger.js';
import type { User } from '../db/users.js';
import {
  bulkRowThresholdFor,
  countAdminListRows,
  sanitizeAdminReadQueryString,
} from '../admin/read-audit.js';
import { privateNoStoreResponse } from '../middleware/cache-control.js';
import { requireAuth } from '../auth/handler.js';
import { requireStaff } from '../auth/require-staff.js';
import { notifyAdminBulkRead } from '../discord.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { adminStepUpHandler } from '../admin/step-up-handler.js';
import { mountAdminStaffRoutes } from './admin-staff.js';
import { mountAdminUserRoutes } from './admin-users.js';
import { mountAdminOrderRoutes } from './admin-orders.js';
import { mountAdminOpsRoutes } from './admin-ops.js';

export function mountAdminRoutes(app: Hono): void {
  // A2-1010 — must precede requireAuth so 401/404 envelopes also carry no-store
  app.use('/api/admin/*', privateNoStoreResponse);

  app.use('/api/admin/*', requireAuth);
  app.use('/api/admin/*', requireStaff('support'));

  // A2-2008 / CF-10 — logs to Pino (Fly logflow) for tamper resistance; bulk = .csv OR rowCount >= threshold
  app.use('/api/admin/*', async (c, next) => {
    await next();
    if (c.req.method !== 'GET') return;
    if (c.res.status !== 200) return;
    const actor = (c as unknown as Context).get('user') as User | undefined;
    if (actor === undefined) return;

    const path = c.req.path;
    const query = sanitizeAdminReadQueryString(c.req.url.split('?')[1] ?? '');
    const isCsv = path.endsWith('.csv');

    // Clone response to avoid draining the client stream; fallback to 0 on read failure
    let rowCount = 0;
    if (!isCsv) {
      try {
        const clone = c.res.clone();
        const body = await clone.text();
        rowCount = countAdminListRows(body, clone.headers.get('content-type'));
      } catch {
        rowCount = 0;
      }
    }
    const isBulkList = rowCount >= bulkRowThresholdFor(path);
    const isBulk = isCsv || isBulkList;

    logger.info(
      {
        area: 'admin-read-audit',
        actorUserId: actor.id,
        method: c.req.method,
        path,
        query: query !== undefined ? query.slice(0, 200) : undefined,
        isBulk,
        ...(isBulkList ? { rowCount } : {}),
      },
      'Admin read',
    );

    if (isBulk) {
      notifyAdminBulkRead({
        actorUserId: actor.id,
        endpoint: `${c.req.method} ${path}`,
        ...(query !== undefined ? { queryString: query } : {}),
        ...(isBulkList ? { rowCount } : {}),
      });
    }
  });

  // ADR 037 — must mount first; required for non-initial admins to gain access
  mountAdminStaffRoutes(app);

  // Literal paths registered before /users/:userId to prevent route shadowing
  mountAdminUserRoutes(app);

  mountAdminOrderRoutes(app);

  mountAdminOpsRoutes(app);

  // ADR 028 / A4-063 — mounted under standard admin stack but NOT requireAdminStepUp (chicken-and-egg)
  app.post(
    '/api/admin/step-up',
    rateLimit('POST /api/admin/step-up', 30, 60_000),
    requireStaff('admin'),
    adminStepUpHandler,
  );
}
