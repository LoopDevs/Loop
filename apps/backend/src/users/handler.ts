/**
 * User profile handlers.
 *
 * `GET /api/users/me` — returns the caller's Loop user profile. The
 * primary surface for the client to read `home_currency` (ADR 015)
 * + email.
 *
 * `POST /api/users/me/home-currency` — first-time-only write path.
 * Onboarding UIs call this after OTP verify to set the user's
 * region. Guarded on "no orders yet": once a user places their first
 * order, pricing is pinned to that order's currency and letting the
 * user flip regions would misalign the history.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { HOME_CURRENCIES, type StaffRole } from '@loop/shared';
import { db } from '../db/client.js';
import { resolveLoopAuthenticatedUser } from '../auth/authenticated-user.js';
import { type User } from '../db/users.js';
import { getStaffRole } from '../db/staff-roles.js';
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
}

/**
 * Resolves the caller's effective staff tier the same way
 * `requireStaff` does — a `staff_roles` row wins, and the
 * config-allowlist `isAdmin` shim is the fallback when there is none.
 *
 * A lookup failure degrades to the shim rather than failing the
 * request: `/api/users/me` is the profile endpoint every authenticated
 * client polls, and a staff-role blip must not log the whole fleet out
 * of their own account page.
 */
async function resolveStaffRoleFor(row: User): Promise<StaffRole | null> {
  try {
    const staffRow = await getStaffRole(row.id);
    if (staffRow !== null) return staffRow.role;
  } catch (err) {
    log.warn({ err, userId: row.id }, 'staff_roles lookup failed — falling back to the shim');
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
  };
}

/**
 * A2-550 / A2-551 fix: identity is now resolved only from the
 * cryptographically-verified Loop-signed token. See
 * `apps/backend/src/auth/authenticated-user.ts` for the rationale.
 */
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

/**
 * POST /api/users/me/home-currency — onboarding-time picker.
 * Succeeds when the caller has zero orders; returns 409 otherwise so
 * the client can render a "contact support" path for existing users.
 */
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

  // Early-exit: no-op when the user is already on the requested
  // currency. Lets the client call this endpoint unconditionally
  // from onboarding without first checking `GET /me`.
  if (user.homeCurrency === parsed.data.currency) {
    return c.json<UserMeView>(await toView(user));
  }

  // Order guard — pricing history pins currency at order creation, so
  // home currency is a first-time-only write.
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

// DSR handlers (2 functions covering data-subject-rights export +
// delete, A2-1905 + A2-1906) live in `./dsr-handler.ts`. Re-
// exported here so the routes module's existing import block keeps
// working without re-targeting.
export { dsrExportHandler, dsrDeleteHandler } from './dsr-handler.js';
