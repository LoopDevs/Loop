/**
 * Admin withdrawal endpoint (ADR-024 / A2-901).
 *
 * `POST /api/admin/users/:userId/withdrawals` — debits the user's
 * cashback balance and queues an on-chain LOOP-asset payout.
 * Admin-mediated only (Phase 2a); user-initiated cash-out is
 * deferred to Phase 2b.
 *
 * Two-layer idempotency mirrors the refund handler:
 *
 *   - Admin idempotency key (ADR 017) — actor+key snapshot replay,
 *     covers "support agent double-clicked submit" + retries.
 *   - DB partial unique index on
 *     (type='withdrawal', reference_type='payout', reference_id) from
 *     migration 0022 — catches "two admins both fire a withdrawal
 *     against the same payout id" race. Surfaces as 409
 *     WITHDRAWAL_ALREADY_ISSUED.
 *
 * Response envelope matches the refund handler's shape so the admin
 * UI can share the post-action renderer.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { STELLAR_PUBKEY_REGEX } from '@loop/shared';
import { UUID_RE } from '../uuid.js';
import { HOME_CURRENCIES, type HomeCurrency } from '../db/schema.js';
import { getUserById, type User } from '../db/users.js';
import { payoutAssetFor } from '../credits/payout-asset.js';
import { generatePayoutMemo } from '../credits/payout-builder.js';
import { applyAdminWithdrawal, WithdrawalAlreadyIssuedError } from '../credits/withdrawals.js';
import { InsufficientBalanceError } from '../credits/adjustments.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  lookupIdempotencyKey,
  storeIdempotencyKey,
  validateIdempotencyKey,
} from './idempotency.js';

const log = logger.child({ handler: 'admin-withdrawal' });

/**
 * Body schema. `amountMinor` is unsigned integer-as-string; same
 * 10,000,000 cap as refund/adjustment. `destinationAddress` is the
 * user's Stellar wallet — admin specifies it explicitly because the
 * use case is "manual cash-out request" where the user might not
 * have a stored wallet yet.
 */
const BodySchema = z.object({
  amountMinor: z
    .string()
    .regex(/^\d+$/, 'amountMinor must be a positive integer string')
    .refine((s) => {
      try {
        const n = BigInt(s);
        return n > 0n && n <= 10_000_000n;
      } catch {
        return false;
      }
    }, 'amountMinor must be positive and within 10_000_000 minor units'),
  currency: z.enum(HOME_CURRENCIES),
  destinationAddress: z
    .string()
    .regex(STELLAR_PUBKEY_REGEX, 'destinationAddress must be a Stellar public key (G...)'),
  reason: z.string().min(2).max(500),
});

export interface WithdrawalResponse {
  id: string;
  payoutId: string;
  userId: string;
  currency: string;
  amountMinor: string;
  destinationAddress: string;
  priorBalanceMinor: string;
  newBalanceMinor: string;
  createdAt: string;
}

export async function adminWithdrawalHandler(c: Context): Promise<Response> {
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

  // Target user must exist before we charge their balance — fail
  // fast with 404 rather than letting `applyAdminWithdrawal` write
  // a credit-tx referencing a missing user_id.
  const targetUser = await getUserById(userId);
  if (targetUser === null) {
    return c.json({ code: 'NOT_FOUND', message: 'Target user not found' }, 404);
  }

  // Resolve LOOP asset for the requested currency. ADR-024 follows
  // the same payoutAssetFor mapping as order-cashback (USD→USDLOOP,
  // GBP→GBPLOOP, EUR→EURLOOP). Issuer absent in env → return 503
  // NOT_CONFIGURED so ops sees the misconfiguration loud.
  const asset = payoutAssetFor(parsed.data.currency as HomeCurrency);
  if (asset.issuer === null) {
    return c.json(
      {
        code: 'NOT_CONFIGURED',
        message: `Issuer for ${asset.code} not configured in env`,
      },
      503,
    );
  }

  // Replay path — return stored snapshot verbatim with replayed:true.
  const prior = await lookupIdempotencyKey({
    adminUserId: actor.id,
    key: idempotencyKey,
  });
  if (prior !== null) {
    const priorResult = (prior.body as { result?: WithdrawalResponse }).result;
    notifyAdminAudit({
      actorUserId: actor.id,
      endpoint: `POST /api/admin/users/${userId}/withdrawals`,
      targetUserId: userId,
      ...(priorResult?.amountMinor !== undefined ? { amountMinor: priorResult.amountMinor } : {}),
      ...(priorResult?.currency !== undefined ? { currency: priorResult.currency } : {}),
      reason: parsed.data.reason,
      idempotencyKey,
      replayed: true,
    });
    return c.json(prior.body, prior.status as 200 | 400 | 404 | 409 | 500 | 503);
  }

  // Convert the minor-unit balance amount into Stellar stroops.
  // 1 minor unit = 100,000 stroops (1:1 peg, 7 decimals — same as
  // payout-builder.ts:122 for order-cashback rows).
  const amountMinor = BigInt(parsed.data.amountMinor);
  const amountStroops = amountMinor * 100_000n;

  let applied;
  try {
    applied = await applyAdminWithdrawal({
      userId,
      currency: parsed.data.currency,
      amountMinor,
      intent: {
        assetCode: asset.code,
        assetIssuer: asset.issuer,
        toAddress: parsed.data.destinationAddress,
        amountStroops,
        memoText: generatePayoutMemo(),
      },
      reason: parsed.data.reason,
    });
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      return c.json(
        {
          code: 'INSUFFICIENT_BALANCE',
          message: err.message,
        },
        400,
      );
    }
    if (err instanceof WithdrawalAlreadyIssuedError) {
      return c.json(
        {
          code: 'WITHDRAWAL_ALREADY_ISSUED',
          message: err.message,
        },
        409,
      );
    }
    log.error({ err, userId, adminUserId: actor.id }, 'Withdrawal failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to apply withdrawal' }, 500);
  }

  const result: WithdrawalResponse = {
    id: applied.id,
    payoutId: applied.payoutId,
    userId: applied.userId,
    currency: applied.currency,
    amountMinor: applied.amountMinor.toString(),
    destinationAddress: parsed.data.destinationAddress,
    priorBalanceMinor: applied.priorBalanceMinor.toString(),
    newBalanceMinor: applied.newBalanceMinor.toString(),
    createdAt: applied.createdAt.toISOString(),
  };

  const envelope: AdminAuditEnvelope<WithdrawalResponse> = buildAuditEnvelope({
    result,
    actor,
    idempotencyKey,
    appliedAt: applied.createdAt,
    replayed: false,
  });

  try {
    await storeIdempotencyKey({
      adminUserId: actor.id,
      key: idempotencyKey,
      method: 'POST',
      path: `/api/admin/users/${userId}/withdrawals`,
      status: 200,
      body: envelope as unknown as Record<string, unknown>,
    });
  } catch (err) {
    log.warn(
      { err, adminUserId: actor.id, key: idempotencyKey },
      'Failed to persist idempotency snapshot; retry will replay as new write',
    );
  }

  notifyAdminAudit({
    actorUserId: actor.id,
    endpoint: `POST /api/admin/users/${userId}/withdrawals`,
    targetUserId: userId,
    amountMinor: result.amountMinor,
    currency: result.currency,
    reason: parsed.data.reason,
    idempotencyKey,
    replayed: false,
  });

  return c.json(envelope, 200);
}
