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
import { HOME_CURRENCIES } from '@loop/shared';
import { db } from '../db/client.js';
import { resolveLoopAuthenticatedUser } from '../auth/authenticated-user.js';
import { type User } from '../db/users.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'users' });

export interface UserMeView {
  id: string;
  email: string;
  /** ADR 015 — USD / GBP / EUR. Drives order denomination. */
  homeCurrency: string;
}

export function toView(row: User): UserMeView {
  return {
    id: row.id,
    email: row.email,
    homeCurrency: row.homeCurrency,
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
  return c.json<UserMeView>(toView(user));
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
    return c.json<UserMeView>(toView(user));
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
  return c.json<UserMeView>(toView(updated));
}

// DSR handlers (2 functions covering data-subject-rights export +
// delete, A2-1905 + A2-1906) live in `./dsr-handler.ts`. Re-
// exported here so the routes module's existing import block keeps
// working without re-targeting.
export { dsrExportHandler, dsrDeleteHandler } from './dsr-handler.js';
