/**
 * Reverse lookup — the user-360 entry point (ADR 037).
 *
 * `GET /api/admin/lookup?q=<order id>` resolves an artifact the
 * customer can quote back to the owning user, so support can start
 * from what the customer actually has in front of them rather than
 * asking for an email they may not remember signing up with.
 *
 * Two artifacts resolve today, both to `kind: 'order'`: Loop's own
 * order id (what the app shows them) and the CTX order id (what
 * appears in the supplier's mail and on the card page). Both are exact
 * lookups against an existing unique key, never a scan — a reverse
 * lookup that degraded into a fuzzy search would be a PII-enumeration
 * surface rather than a support tool.
 *
 * A miss is a 404 rather than an empty 200: the caller pasted
 * something that isn't ours, and the UI should say so.
 */
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
    // A uuid is our own order id; anything else that reaches here is
    // tried as a CTX order id. Both are unique keys, so at most one
    // row comes back either way.
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
    // The query itself is an order id, not PII, but it is customer-
    // supplied — keep it out of the log line and correlate by request
    // id like the other admin reads.
    log.error({ err }, 'Admin lookup failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Lookup failed' }, 500);
  }
}
