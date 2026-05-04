/**
 * Admin home-currency change endpoint (ADR 015 deferred §
 * "self-serve home-currency change — currently support-mediated").
 *
 * `POST /api/admin/users/:userId/home-currency` — flips
 * `users.home_currency` after preflight invariants confirm the
 * switch is safe. ADR 017 admin-write contract:
 *   1. Actor from `c.get('user')` (admin middleware), never body.
 *   2. Idempotency-Key required; repeat → snapshot replay.
 *   3. Reason required (2..500 chars), persisted in Discord audit.
 *   4. Reversibility — switching back is another admin write that
 *      runs the same preflight. There is no separate "revert"
 *      primitive and that's deliberate; the audit log is the
 *      reversibility surface.
 *   5. Discord audit fanout AFTER commit, fire-and-forget.
 *
 * Step-up gate (ADR 028): like credit-adjustments and withdrawals,
 * a captured bearer token alone must not be able to retarget which
 * LOOP-asset a user's future cashback lands in. The route is
 * mounted under `requireAdminStepUp()`; the handler is unaware.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { UUID_RE } from '../uuid.js';
import { HOME_CURRENCIES } from '../db/schema.js';
import type { User } from '../db/users.js';
import {
  applyAdminHomeCurrencyChange,
  HomeCurrencyConcurrentChangeError,
  HomeCurrencyHasInFlightPayoutsError,
  HomeCurrencyHasLiveBalanceError,
  HomeCurrencyUnchangedError,
  UserNotFoundError,
} from '../users/home-currency-change.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';

const log = logger.child({ handler: 'admin-home-currency-set' });

const BodySchema = z.object({
  homeCurrency: z.enum(HOME_CURRENCIES),
  reason: z.string().min(2).max(500),
});

export interface HomeCurrencySetResult {
  userId: string;
  priorHomeCurrency: string;
  newHomeCurrency: string;
  updatedAt: string;
}

export async function adminHomeCurrencySetHandler(c: Context): Promise<Response> {
  const userId = c.req.param('userId');
  if (userId === undefined || !UUID_RE.test(userId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a uuid' }, 400);
  }

  const idempotencyKey = c.req.header('idempotency-key');
  if (!validateIdempotencyKey(idempotencyKey)) {
    return c.json(
      {
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: `Idempotency-Key header required (${IDEMPOTENCY_KEY_MIN}-${IDEMPOTENCY_KEY_MAX} chars)`,
      },
      400,
    );
  }

  const actor = c.get('user') as User | undefined;
  if (actor === undefined) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Admin context missing' }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' }, 400);
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: parsed.error.issues[0]?.message ?? 'Invalid body',
      },
      400,
    );
  }

  let guardResult: Awaited<ReturnType<typeof withIdempotencyGuard>>;
  try {
    guardResult = await withIdempotencyGuard(
      {
        adminUserId: actor.id,
        key: idempotencyKey,
        method: 'POST',
        path: `/api/admin/users/${userId}/home-currency`,
      },
      async () => {
        const applied = await applyAdminHomeCurrencyChange({
          userId,
          newHomeCurrency: parsed.data.homeCurrency,
        });
        const result: HomeCurrencySetResult = {
          userId: applied.userId,
          priorHomeCurrency: applied.priorHomeCurrency,
          newHomeCurrency: applied.newHomeCurrency,
          updatedAt: applied.updatedAt.toISOString(),
        };
        const envelope: AdminAuditEnvelope<HomeCurrencySetResult> = buildAuditEnvelope({
          result,
          actor,
          idempotencyKey,
          appliedAt: applied.updatedAt,
          replayed: false,
        });
        return { status: 200, body: envelope as unknown as Record<string, unknown> };
      },
    );
  } catch (err) {
    if (err instanceof UserNotFoundError) {
      return c.json({ code: 'USER_NOT_FOUND', message: 'User not found' }, 404);
    }
    if (err instanceof HomeCurrencyUnchangedError) {
      return c.json(
        {
          code: 'HOME_CURRENCY_UNCHANGED',
          message: `User's home currency is already ${err.currency}`,
        },
        409,
      );
    }
    if (err instanceof HomeCurrencyHasLiveBalanceError) {
      return c.json(
        {
          code: 'HOME_CURRENCY_HAS_LIVE_BALANCE',
          message: `User has a non-zero ${err.currency} credit balance (${err.balanceMinor} minor) — zero it via a credit-adjustment before changing home currency`,
        },
        409,
      );
    }
    if (err instanceof HomeCurrencyHasInFlightPayoutsError) {
      return c.json(
        {
          code: 'HOME_CURRENCY_HAS_IN_FLIGHT_PAYOUTS',
          message: `User has ${err.count} in-flight payout(s) (state pending or submitted) — wait for them to clear before changing home currency`,
        },
        409,
      );
    }
    if (err instanceof HomeCurrencyConcurrentChangeError) {
      return c.json(
        {
          code: 'CONCURRENT_CHANGE',
          message: 'Home currency was changed by a concurrent write — re-read and retry',
        },
        409,
      );
    }
    log.error({ err, userId, adminUserId: actor.id }, 'Home currency change failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to change home currency' }, 500);
  }

  // Discord audit fanout — fire-and-forget AFTER commit per ADR 017 #5.
  // The prior/new home_currency pair lives on the idempotency snapshot
  // (replayable from the ledger) and the structured Pino log; the
  // Discord embed carries the actor + endpoint + reason and the
  // tail-id of the affected user, which is enough for ops to spot a
  // misuse and pivot into the snapshot.
  notifyAdminAudit({
    actorUserId: actor.id,
    endpoint: `POST /api/admin/users/${userId}/home-currency`,
    targetUserId: userId,
    reason: parsed.data.reason,
    idempotencyKey,
    replayed: guardResult.replayed,
  });

  return c.json(guardResult.body, guardResult.status as 200 | 400 | 404 | 409 | 500);
}
