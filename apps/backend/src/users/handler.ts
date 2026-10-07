// User profile handlers — ADR 015, ADR 037, A2-550, A2-551, A2-1905, A2-1906
import type { Context } from 'hono';
import { z } from 'zod';
import {
  CASHBACK_DESTINATIONS,
  HOME_CURRENCIES,
  type CashbackDestination,
  type StaffRole,
} from '@loop/shared';
import { db } from '../db/client.js';
import { resolveLoopAuthenticatedUser } from '../auth/authenticated-user.js';
import { type User } from '../db/users.js';
import { getStaffRole } from '../db/staff-roles.js';
import {
  CtxUserRolesError,
  updateCtxCashbackDestination,
  updateCtxStableCurrency,
} from '../ctx/user-roles.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'users' });

export interface UserMeView {
  id: string;
  email: string;
  /** ADR 015 — USD / GBP / EUR. Drives order denomination. */
  homeCurrency: string;
  /**
   * ADR 037 — the caller's staff tier, or null for an ordinary user.
   * This is what the web admin shell gates its navigation on: without
   * it every session renders as non-staff and `/admin` is unreachable
   * even for someone the backend would let through.
   */
  staffRole: StaffRole | null;
  /**
   * Deprecated read-compat shim (ADR 037): true iff `staffRole` is
   * `'admin'`. New gating should key off `staffRole`; this stays until
   * the last client fallback retires.
   */
  isAdmin: boolean;
  /** Where credited cashback lands at CTX: the account balance or the savings pot. */
  cashbackDestination: CashbackDestination;
}

// Lookup failure degrades to shim: profile endpoint is polled by all clients, staff-role blip must not log out fleet
async function resolveStaffRoleFor(row: User): Promise<StaffRole | null> {
  try {
    const staffRow = await getStaffRole(row.id);
    if (staffRow !== null) return staffRow.role;
  } catch (err) {
    log.warn(
      { err, userId: row.id },
      'staff_roles lookup failed — falling back to the CTX-role mirror',
    );
  }
  return row.isAdmin ? 'admin' : null;
}

export async function toView(row: User): Promise<UserMeView> {
  const staffRole = await resolveStaffRoleFor(row);
  return {
    id: row.id,
    email: row.email,
    homeCurrency: row.homeCurrency,
    staffRole,
    isAdmin: staffRole === 'admin',
    cashbackDestination: row.cashbackDestination ?? 'account',
  };
}

// A2-550 / A2-551: identity resolved only from cryptographically-verified Loop-signed token
export async function resolveCallingUser(c: Context): Promise<User | null> {
  return await resolveLoopAuthenticatedUser(c);
}

export async function getMeHandler(c: Context): Promise<Response> {
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
  return c.json<UserMeView>(await toView(user));
}

const SetHomeCurrencyBody = z.object({
  currency: z.enum(HOME_CURRENCIES),
});

// 409 on existing orders: pricing history pins currency at order creation
export async function setHomeCurrencyHandler(c: Context): Promise<Response> {
  const parsed = SetHomeCurrencyBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: 'currency must be USD, GBP, or EUR',
      },
      400,
    );
  }
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

  // No-op if already on requested currency: allows unconditional onboarding calls without prior GET /me
  if (user.homeCurrency === parsed.data.currency) {
    return c.json<UserMeView>(await toView(user));
  }

  const hasOrder = await db.collection('orders').findOne({ userId: user.id });
  if (hasOrder !== null) {
    return c.json(
      {
        code: 'HOME_CURRENCY_LOCKED',
        message: 'Home currency cannot be changed after placing an order',
      },
      409,
    );
  }

  if (user.ctxUserId !== null) {
    try {
      await updateCtxStableCurrency(user.ctxUserId, parsed.data.currency);
    } catch (err) {
      if (err instanceof CtxUserRolesError && err.status === 400) {
        return c.json({ code: 'VALIDATION_ERROR', message: 'Currency not supported' }, 400);
      }
      log.error({ err, userId: user.id }, 'CTX stableCurrency update failed');
      return c.json(
        { code: 'SUPPLIER_UNAVAILABLE', message: 'Unable to change home currency right now' },
        503,
      );
    }
  }

  const updated = await db
    .collection('users')
    .updateOne(
      { id: user.id },
      { $set: { homeCurrency: parsed.data.currency, updatedAt: new Date() } },
    );
  if (updated === null) {
    return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);
  }
  return c.json<UserMeView>(await toView(updated));
}

const SetCashbackDestinationBody = z.object({
  destination: z.enum(CASHBACK_DESTINATIONS),
});

// CTX owns the routing of credited cashback, so the setting is written there first and only mirrored locally once accepted.
export async function setCashbackDestinationHandler(c: Context): Promise<Response> {
  const parsed = SetCashbackDestinationBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'destination must be account or savings' },
      400,
    );
  }
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
  const destination = parsed.data.destination;
  if ((user.cashbackDestination ?? 'account') === destination) {
    return c.json<UserMeView>(await toView(user));
  }
  if (user.ctxUserId === null) {
    return c.json(
      {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Your account is still being set up with our supplier — please retry shortly',
      },
      503,
    );
  }
  try {
    await updateCtxCashbackDestination(user.ctxUserId, destination);
  } catch (err) {
    if (err instanceof CtxUserRolesError && err.status === 400) {
      return c.json({ code: 'VALIDATION_ERROR', message: 'Destination not supported' }, 400);
    }
    log.error({ err, userId: user.id }, 'CTX cashbackDestination update failed');
    return c.json(
      { code: 'SUPPLIER_UNAVAILABLE', message: 'Unable to change where cashback goes right now' },
      503,
    );
  }
  const updated = await db
    .collection('users')
    .updateOne(
      { id: user.id },
      { $set: { cashbackDestination: destination, updatedAt: new Date() } },
    );
  if (updated === null) {
    return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);
  }
  return c.json<UserMeView>(await toView(updated));
}

// Re-exported from ./dsr-handler.ts to preserve existing routes module import block
export { dsrExportHandler, dsrDeleteHandler } from './dsr-handler.js';
