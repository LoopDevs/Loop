// caller-scoped DSR handlers — A2-1905, A2-1906
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

// A2-1906 — logged at info-level for operator audit trail (PII-exfiltration vector if session hijacked)
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
      'Content-Disposition': `attachment; filename="loop-data-export-${user.id}.json"`,
    });
  } catch (err) {
    log.error({ err, userId: user.id }, 'DSR export failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to build export' }, 500);
  }
}

// A2-1905 — logged at warn-level for operator audit trail (permanent state change)
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
