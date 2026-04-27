/**
 * `setStellarAddressHandler` — `PUT /api/users/me/stellar-address`
 * (ADR 015).
 *
 * Lifted out of `apps/backend/src/users/handler.ts` so the
 * stellar-wallet-link mutation lives in its own focused module
 * separate from the profile-read (`getMeHandler`) and
 * home-currency setter (`setHomeCurrencyHandler`) in the parent
 * file. The three handlers share the same `resolveCallingUser` /
 * `toView` / `UserMeView` plumbing, which we import back from
 * the parent rather than duplicate.
 *
 * Re-exported from `handler.ts` so existing import paths used by
 * `routes/users.ts` and the test suite resolve unchanged.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { STELLAR_PUBKEY_REGEX } from '@loop/shared';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { type User } from '../db/users.js';
import { logger } from '../logger.js';
import { resolveCallingUser, toView, type UserMeView } from './handler.js';

const log = logger.child({ handler: 'users' });

// Stellar ED25519 public keys: 56 uppercase base32 chars starting
// with 'G'. Shared regex — see `@loop/shared/stellar` for the
// single source of truth across backend + web + env validation.
const SetStellarAddressBody = z.object({
  /** Null explicitly unlinks the address; any string is validated against the pubkey regex. */
  address: z.union([z.string().regex(STELLAR_PUBKEY_REGEX), z.null()]),
});

/**
 * PUT /api/users/me/stellar-address — user opts into on-chain
 * cashback payouts by linking a Stellar address. Re-linking (changing
 * the address) is allowed because the column is a routing hint, not a
 * ledger-pinned value — subsequent payouts just go to the new target.
 * Passing `address: null` unlinks, returning the user to off-chain-
 * only cashback accrual.
 */
export async function setStellarAddressHandler(c: Context): Promise<Response> {
  const parsed = SetStellarAddressBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message:
          parsed.error.issues[0]?.message ?? 'address must be a Stellar public key (G...) or null',
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
  if (user.stellarAddress === parsed.data.address) {
    return c.json<UserMeView>(await toView(user));
  }
  const [updated] = await db
    .update(users)
    .set({ stellarAddress: parsed.data.address, updatedAt: sql`NOW()` })
    .where(eq(users.id, user.id))
    .returning();
  if (updated === undefined) {
    return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);
  }
  return c.json<UserMeView>(await toView(updated));
}
