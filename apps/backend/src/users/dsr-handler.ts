/**
 * Caller-scoped DSR (data-subject-rights) handlers
 * (A2-1905 + A2-1906, GDPR articles 17 + 20).
 *
 * Lifted out of `apps/backend/src/users/handler.ts`. Two handlers
 * that back the user-side privacy surfaces — same routes the
 * openapi spec splits into `./openapi/users-dsr-orders.ts`:
 *
 *   - GET  /api/users/me/dsr/export → dsrExportHandler
 *   - POST /api/users/me/dsr/delete → dsrDeleteHandler
 *
 * The `buildDsrExport` and `deleteUserViaAnonymisation` helpers
 * live in their own modules (`./dsr-export.ts` + `./dsr-delete.ts`)
 * — this slice only carries the request-handling layer that wraps
 * them with auth resolution + the standard error / 401 / 404 / 409
 * envelope.
 */
import type { Context } from 'hono';
import { resolveLoopAuthenticatedUser } from '../auth/authenticated-user.js';
import { type User } from '../db/users.js';
import { logger } from '../logger.js';
import { buildDsrExport } from './dsr-export.js';
import { deleteUserViaAnonymisation } from './dsr-delete.js';

const log = logger.child({ handler: 'users' });

async function resolveCallingUser(c: Context): Promise<User | null> {
  return await resolveLoopAuthenticatedUser(c);
}

/**
 * A2-1906 — `GET /api/users/me/dsr/export`. Self-serve data export
 * the privacy policy promises. Returns a JSON envelope of every row
 * Loop holds keyed to the calling user. See `dsr-export.ts` module
 * header for what's included / excluded and the redaction rationale
 * for redeem codes.
 *
 * Auth: standard Loop-native or CTX-proxy bearer (the same path every
 * other `/api/users/me/*` endpoint uses). Rate limit on the route
 * (set in `app.ts`) caps abuse — the export is a non-trivial DB scan.
 *
 * Logged at info-level for the operator audit trail since it's a
 * potential PII-exfiltration vector if a session is hijacked.
 */
export async function dsrExportHandler(c: Context): Promise<Response> {
  let user: User | null;
  try {
    user = await resolveCallingUser(c);
  } catch (err) {
    log.error({ err }, 'Failed to resolve calling user');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to resolve user' }, 500);
  }
  if (user === null) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
  }
  try {
    const exportPayload = await buildDsrExport(user.id);
    if (exportPayload === null) {
      return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);
    }
    log.info({ userId: user.id, area: 'dsr-export' }, 'DSR export issued');
    return c.json(exportPayload, 200, {
      // Make it actually downloadable from the browser without a
      // round-trip through `URL.createObjectURL` — the client can
      // window.open the URL with the bearer in fetch and save the
      // file directly.
      'Content-Disposition': `attachment; filename="loop-data-export-${user.id}.json"`,
    });
  } catch (err) {
    log.error({ err, userId: user.id }, 'DSR export failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to build export' }, 500);
  }
}

/**
 * A2-1905 — `POST /api/users/me/dsr/delete`. The privacy-policy-
 * promised right of erasure, implemented as anonymisation per
 * `dsr-delete.ts` (ledger rows can't be hard-deleted, ADR-009).
 *
 * Returns 200 on success — the caller's session is revoked at this
 * point so the next request will 401. Returns 409 with a typed
 * `code` when there's money / fulfilment in flight.
 *
 * No request body — the caller is the user being deleted; no
 * confirmation token because the front-end is expected to gate this
 * behind a typed-confirmation modal. Server-side this is a single-
 * action POST; the client-side guard is the UX layer.
 *
 * Logged at warn-level for the operator audit trail since this is a
 * permanent state change.
 */
export async function dsrDeleteHandler(c: Context): Promise<Response> {
  let user: User | null;
  try {
    user = await resolveCallingUser(c);
  } catch (err) {
    log.error({ err }, 'Failed to resolve calling user');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to resolve user' }, 500);
  }
  if (user === null) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
  }
  try {
    const result = await deleteUserViaAnonymisation(user.id);
    if (!result.ok) {
      if (result.blockedBy === 'pending_payouts') {
        return c.json(
          {
            code: 'PENDING_PAYOUTS',
            message:
              'Cannot delete account while a cashback payout is pending or submitted — wait for it to settle, or contact support.',
          },
          409,
        );
      }
      return c.json(
        {
          code: 'IN_FLIGHT_ORDERS',
          message:
            'Cannot delete account while an order is mid-fulfilment — wait for it to fulfill or expire, or contact support.',
        },
        409,
      );
    }
    log.warn({ userId: user.id, area: 'dsr-delete' }, 'User account anonymised via DSR delete');
    return c.json({ ok: true });
  } catch (err) {
    log.error({ err, userId: user.id }, 'DSR delete failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to delete account' }, 500);
  }
}
