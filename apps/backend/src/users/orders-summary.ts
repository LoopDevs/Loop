// User orders summary — ADR 010 / 015
import type { Context } from 'hono';
import { db } from '../db/client.js';
import type { User } from '../db/users.js';
import { resolveLoopAuthenticatedUser } from '../auth/authenticated-user.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'user-orders-summary' });

export interface UserOrdersSummary {
  currency: string;
  totalOrders: number;
  fulfilledCount: number;
  pendingCount: number;
  failedCount: number;
  totalSpentMinor: string;
}

// A2-550 / A2-551: requires verified Loop-signed token
async function resolveCallingUser(c: Context): Promise<User | null> {
  return await resolveLoopAuthenticatedUser(c);
}

export async function getUserOrdersSummaryHandler(c: Context): Promise<Response> {
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
    const rows = await db
      .collection('orders')
      .findMany({ userId: user.id, chargeCurrency: user.homeCurrency });
    let fulfilledCount = 0;
    let pendingCount = 0;
    let failedCount = 0;
    let totalSpentMinor = 0;
    for (const order of rows) {
      if (order.state === 'fulfilled') {
        fulfilledCount++;
        totalSpentMinor += order.chargeMinor;
      } else if (order.state === 'unpaid' || order.state === 'paid') {
        pendingCount++;
      } else {
        failedCount++;
      }
    }

    return c.json<UserOrdersSummary>({
      currency: user.homeCurrency,
      totalOrders: rows.length,
      fulfilledCount,
      pendingCount,
      failedCount,
      totalSpentMinor: String(totalSpentMinor),
    });
  } catch (err) {
    log.error({ err }, 'Orders-summary query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load orders summary' }, 500);
  }
}
