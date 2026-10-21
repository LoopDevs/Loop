// Admin stable-currency override — ADR 015, ADR 017; CTX owns the stable, so it is written there first
import type { Context } from 'hono';
import { z } from 'zod';
import { UUID_RE } from '../uuid.js';
import { cacheCtxUser, getUserById, type User } from '../db/users.js';
import { CtxUserRolesError, updateCtxStableCurrency } from '../ctx/user-roles.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';

const log = logger.child({ handler: 'admin-stable-currency-set' });

const BodySchema = z.object({
  stableCurrency: z
    .string()
    .trim()
    .min(1)
    .transform((value) => value.toUpperCase()),
  reason: z.string().min(2).max(500),
});

export interface StableCurrencySetResult {
  userId: string;
  priorStableCurrency: string;
  newStableCurrency: string;
  updatedAt: string;
}

class StableCurrencyUnchangedError extends Error {
  constructor() {
    super('User is already on that stable currency');
    this.name = 'StableCurrencyUnchangedError';
  }
}

export async function adminStableCurrencySetHandler(c: Context): Promise<Response> {
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
      { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid body' },
      400,
    );
  }

  const target = await getUserById(userId);
  if (target === null) {
    return c.json({ code: 'USER_NOT_FOUND', message: 'User not found' }, 404);
  }

  let guardResult: Awaited<ReturnType<typeof withIdempotencyGuard>>;
  try {
    guardResult = await withIdempotencyGuard(
      {
        adminUserId: actor.id,
        key: idempotencyKey,
        method: 'POST',
        path: `/api/admin/users/${userId}/stable-currency`,
      },
      async () => {
        if (target.stableCurrency === parsed.data.stableCurrency) {
          throw new StableCurrencyUnchangedError();
        }
        const ctxUser = await updateCtxStableCurrency(userId, parsed.data.stableCurrency);
        const { user: updated } = await cacheCtxUser(ctxUser);
        const updatedAt = updated.updatedAt;

        const result: StableCurrencySetResult = {
          userId,
          priorStableCurrency: target.stableCurrency,
          newStableCurrency: updated.stableCurrency,
          updatedAt: updatedAt.toISOString(),
        };
        const envelope: AdminAuditEnvelope<StableCurrencySetResult> = buildAuditEnvelope({
          result,
          actor,
          idempotencyKey,
          appliedAt: updatedAt,
          replayed: false,
        });
        return { status: 200, body: envelope as unknown as Record<string, unknown> };
      },
    );
  } catch (err) {
    if (err instanceof StableCurrencyUnchangedError) {
      return c.json(
        {
          code: 'STABLE_CURRENCY_UNCHANGED',
          message: 'User is already on that stable currency',
        },
        409,
      );
    }
    if (err instanceof CtxUserRolesError && err.status === 400) {
      return c.json({ code: 'STABLE_CURRENCY_REJECTED', message: err.message }, 409);
    }
    log.error({ err, userId, adminUserId: actor.id }, 'Admin stable-currency change failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to change stable currency' }, 500);
  }

  notifyAdminAudit({
    actorUserId: actor.id,
    endpoint: `POST /api/admin/users/${userId}/stable-currency`,
    targetUserId: userId,
    reason: `${target.stableCurrency} → ${parsed.data.stableCurrency}: ${parsed.data.reason}`,
    idempotencyKey,
    replayed: guardResult.replayed,
  });

  return c.json(guardResult.body, guardResult.status as 200 | 400 | 404 | 409 | 500);
}
