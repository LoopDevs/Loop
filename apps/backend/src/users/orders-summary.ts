// User orders summary — ADR 010 / 015
import type { Context } from 'hono';
import { fiatForHeldStable } from '@loop/shared';
import { db } from '../db/client.js';
import type { User } from '../db/users.js';
import { resolveLoopAuthenticatedUser } from '../auth/authenticated-user.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'user-orders-summary' });

export interface UserOrdersSummary {
  currency: string | null;
  totalOrders: number;
  fulfilledCount: number;
  pendingCount: number;
  failedCount: number;
  totalSpentMinor: string;
}

async function summaryCurrency(user: User): Promise<string | null> {
  const fiat = fiatForHeldStable(user.stableCurrency);
  if (fiat !== null) return fiat;
  const latest = await db
    .collection('orders')
    .findOne({ userId: user.id }, { sort: [['createdAt', 'desc']] });
  return latest?.chargeCurrency ?? null;
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
    const currency = await summaryCurrency(user);
    const rows =
      currency === null
        ? []
        : await db.collection('orders').findMany({ userId: user.id, chargeCurrency: currency });
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
      currency,
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
