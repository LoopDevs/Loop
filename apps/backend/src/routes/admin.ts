/**
 * `/api/admin/*` route mounts.
 *
 * The admin surface bundles four things together because their mount
 * ORDER is the contract:
 *
 * 1. **Cache-Control: private, no-store** mounts FIRST so the header
 *    lands on every response, including the 401 / 404 envelopes
 *    emitted by `requireAuth` / `requireStaff`. A2-1010 — every
 *    handler under this namespace returns operator-visible data
 *    (user drills, order history, audit events, CSV exports). A CDN
 *    keyed on URL alone — not Authorization — must not cache one of
 *    these. Registered BEFORE `requireAuth` so a 401 also carries
 *    no-store; otherwise a misbehaving CDN caching 401 envelopes
 *    leaks "this URL is admin-only" cross-user.
 * 2. **`requireAuth`** mounts SECOND so the actor identity is attached
 *    before the staff gate checks it. Order matters: an unauth'd
 *    request should get a 401 (clearer envelope) rather than a 404.
 * 3. **`requireStaff('support')`** mounts THIRD as the namespace
 *    blanket — it resolves the caller's role (a `staff_roles` row,
 *    falling back to the `users.isAdmin` allowlist shim), 404s
 *    non-staff, and sets `user` + `staffRole` on the context for
 *    everything downstream. Tiering is then declared PER MOUNT:
 *    admin-only surfaces carry an explicit `requireStaff('admin')`
 *    next to their rateLimit; support-visible reads ride the blanket
 *    alone.
 * 4. **Admin read audit middleware** (A2-2008) mounts FOURTH — after
 *    the gates so the actor identity is available, and before the
 *    handler so the request body is unbuffered. Every admin GET emits
 *    a Pino access-log line tagged `admin-read-audit`; bulk reads
 *    (CSV downloads, large list pages) additionally fire a Discord
 *    ping. Single-row drills stay log-only — pinging every drill would
 *    flood the channel and dilute the signal on real exfil patterns.
 *
 * A note on what is NOT here. This module was ~80 endpoints before the
 * ADR 052 rails retirement and the Postgres-to-document-store move;
 * the treasury / payouts / credits / vault / emissions families went
 * with the tables they read. What returns is the surface that
 * administers Loop itself, rebuilt against `db/`.
 */
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

/** Mounts all `/api/admin/*` routes on the supplied Hono app. */
export function mountAdminRoutes(app: Hono): void {
  // A2-1010 — see the module docstring for why this is first.
  app.use('/api/admin/*', privateNoStoreResponse);

  app.use('/api/admin/*', requireAuth);
  app.use('/api/admin/*', requireStaff('support'));

  // A2-2008 / CF-10: admin read audit. Every admin GET emits a Pino
  // access-log line so the line-item read trail survives off the host
  // (Fly logflow ships logs externally — harder to tamper with than a
  // stored row). Bulk reads additionally fire a Discord ping so a
  // human sees the export-in-progress signal alongside the write
  // stream. A read counts as "bulk" when EITHER:
  //   - the path is a `.csv` export (any size), OR
  //   - CF-10: a JSON list response returns at least its effective
  //     bulk-row threshold (`bulkRowThresholdFor` — the global
  //     default, or a lower per-path override for an endpoint whose
  //     own row cap sits below it). The original A2-2008 tripwire only
  //     wired the `.csv` path, leaving cursor-walking JSON list pulls
  //     unmonitored; a near-max page is the fingerprint of an exfil
  //     walk.
  app.use('/api/admin/*', async (c, next) => {
    await next();
    if (c.req.method !== 'GET') return;
    if (c.res.status !== 200) return;
    const actor = (c as unknown as Context).get('user') as User | undefined;
    if (actor === undefined) return;

    const path = c.req.path;
    const query = sanitizeAdminReadQueryString(c.req.url.split('?')[1] ?? '');
    const isCsv = path.endsWith('.csv');

    // Count list rows in non-CSV JSON responses. Clone the response so
    // reading the body doesn't drain the stream the client is waiting
    // on. Body-read failures fall back to rowCount=0 (never throws) so
    // the audit pass can't break the response path.
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

  // ADR 037 — staff role management (admin-tier; step-up-gated
  // writes). The one surface that must exist before any other, since
  // it is how everybody except the first admin gets their access.
  mountAdminStaffRoutes(app);

  // ADR 028 / A4-063: step-up token endpoint. Mounted under the
  // standard admin middleware stack so only authenticated staff can
  // mint step-up tokens — but NOT under `requireAdminStepUp` itself
  // (chicken-and-egg: the admin can't hold a step-up token before they
  // hit this endpoint to get one). Admin-tier: step-up only gates
  // admin-only writes, so support has no business minting one — and
  // must not learn the endpoint exists (404).
  app.post(
    '/api/admin/step-up',
    rateLimit('POST /api/admin/step-up', 30, 60_000),
    requireStaff('admin'),
    adminStepUpHandler,
  );
}
