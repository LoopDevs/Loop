// Reverse lookup — user-360 entry point (ADR 037)
import type { Context } from 'hono';
import type { AdminLookupResponse } from '@loop/shared';
import { db } from '../db/client.js';
import { UUID_RE } from '../uuid.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-lookup' });

const MAX_QUERY_LENGTH = 128;

export async function adminLookupHandler(c: Context): Promise<Response> {
  const q = (c.req.query('q') ?? '').trim();
  if (q.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'q is required' }, 400);
  }
  if (q.length > MAX_QUERY_LENGTH) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: `q must be at most ${MAX_QUERY_LENGTH} characters` },
      400,
    );
  }

  try {
    // UUIDs are our order ids; others are CTX order ids. Both are unique keys, so at most one row returns.
    const order = UUID_RE.test(q)
      ? await db.collection('orders').findOne({ id: q })
      : await db.collection('orders').findOne({ ctxOrderId: q });

    if (order === null) {
      return c.json({ code: 'NOT_FOUND', message: 'Nothing matches that order id' }, 404);
    }

    return c.json<AdminLookupResponse>({
      kind: 'order',
      userId: order.userId,
      orderId: order.id,
    });
  } catch (err) {
    // Query is customer-supplied; keep it out of logs and correlate by request id.
    log.error({ err }, 'Admin lookup failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Lookup failed' }, 500);
  }
}
