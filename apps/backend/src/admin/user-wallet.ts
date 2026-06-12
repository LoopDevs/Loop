/**
 * Per-user wallet card (ADR 037 §4.1 user-360) — provisioning
 * state + provider linkage + on-chain balances, plus the
 * re-provision support action.
 *
 * `GET  /api/admin/users/:userId/wallet`             — wallet state
 * `POST /api/admin/users/:userId/wallet/reprovision` — support action
 *
 * The GET reads the on-chain side through the existing 30s-cached
 * Horizon trustline reader (`getAccountTrustlines`). Unlike
 * `/api/me/wallet` there is deliberately NO last-known-good
 * fallback: support needs the truth, so a Horizon outage surfaces
 * as `onChain: null` and the card renders a retry hint.
 *
 * The reprovision is an idempotent re-drive of work the user's
 * signup already paid for (ADR 037 matrix): reset the sweeper's
 * attempt budget inside the idempotency guard, then re-enqueue the
 * provisioning drive AFTER commit (fire-and-forget, same
 * `enqueueWalletProvisioning` as signup). Runbook:
 * docs/runbooks/wallet-provisioning-stuck.md.
 */
import type { Context } from 'hono';
import { eq, ne, and } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type {
  AdminUserWalletBalance,
  AdminUserWalletResponse,
  AdminWalletReprovisionResult,
  WalletProvisioningState,
} from '@loop/shared';
import { UUID_RE } from '../uuid.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { getUserById, type User } from '../db/users.js';
import { getAccountTrustlines } from '../payments/horizon-trustlines.js';
import { enqueueWalletProvisioning } from '../wallet/provisioning.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';

const log = logger.child({ handler: 'admin-user-wallet' });

export async function adminGetUserWalletHandler(c: Context): Promise<Response> {
  const userId = c.req.param('userId');
  if (userId === undefined || !UUID_RE.test(userId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a uuid' }, 400);
  }

  let user;
  try {
    user = await getUserById(userId);
  } catch (err) {
    log.error({ err, userId }, 'Wallet-state user lookup failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load wallet state' }, 500);
  }
  if (user === null) {
    return c.json({ code: 'USER_NOT_FOUND', message: 'User not found' }, 404);
  }

  const base = {
    userId: user.id,
    provider: user.walletProvider,
    walletId: user.walletId,
    walletAddress: user.walletAddress,
    stellarAddress: user.stellarAddress,
    provisioning: user.walletProvisioning,
    provisioningAttempts: user.walletProvisioningAttempts,
    provisioningLastAttemptAt: user.walletProvisioningLastAttemptAt?.toISOString() ?? null,
  };

  if (user.walletAddress === null) {
    // Nothing on-chain to read yet — distinct from a Horizon outage,
    // so report a definitive "no account" snapshot.
    return c.json<AdminUserWalletResponse>({
      ...base,
      onChain: { accountExists: false, balances: [], asOf: new Date().toISOString() },
    });
  }

  try {
    const snapshot = await getAccountTrustlines(user.walletAddress);
    const balances: AdminUserWalletBalance[] = [...snapshot.trustlines.values()].map((line) => ({
      assetCode: line.code,
      assetIssuer: line.issuer,
      balanceStroops: line.balanceStroops.toString(),
      limitStroops: line.limitStroops.toString(),
    }));
    return c.json<AdminUserWalletResponse>({
      ...base,
      onChain: {
        accountExists: snapshot.accountExists,
        balances,
        asOf: new Date(snapshot.asOfMs).toISOString(),
      },
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), userId },
      'Horizon unavailable for admin wallet card — serving onChain: null',
    );
    return c.json<AdminUserWalletResponse>({ ...base, onChain: null });
  }
}

export async function adminWalletReprovisionHandler(c: Context): Promise<Response> {
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
    return c.json({ code: 'UNAUTHORIZED', message: 'Staff context missing' }, 401);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' }, 400);
  }
  const reason =
    body !== null && typeof body === 'object' ? (body as Record<string, unknown>)['reason'] : null;
  if (typeof reason !== 'string' || reason.length < 2 || reason.length > 500) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'reason must be 2-500 chars' }, 400);
  }

  // Pre-classify outside the guard so the 404 / 409 paths never
  // burn an idempotency snapshot.
  let target;
  try {
    target = await getUserById(userId);
  } catch (err) {
    log.error({ err, userId }, 'Reprovision target lookup failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to resolve target user' }, 500);
  }
  if (target === null) {
    return c.json({ code: 'USER_NOT_FOUND', message: 'User not found' }, 404);
  }
  if (target.walletProvisioning === 'activated') {
    return c.json(
      {
        code: 'WALLET_ALREADY_ACTIVATED',
        message: 'Wallet is fully provisioned — nothing to re-drive',
      },
      409,
    );
  }
  const priorProvisioning = target.walletProvisioning as Exclude<
    WalletProvisioningState,
    'activated'
  >;

  let guardResult: Awaited<ReturnType<typeof withIdempotencyGuard>>;
  try {
    guardResult = await withIdempotencyGuard(
      {
        adminUserId: actor.id,
        key: idempotencyKey,
        method: 'POST',
        path: `/api/admin/users/${userId}/wallet/reprovision`,
      },
      async () => {
        // Reset the sweeper bookkeeping so the row re-enters the
        // provisioning sweep with a fresh budget even if the
        // enqueued drive below fails. Guarded on != 'activated' so
        // a concurrent activation isn't clobbered.
        await db
          .update(users)
          .set({
            walletProvisioningAttempts: 0,
            walletProvisioningLastAttemptAt: null,
            updatedAt: sql`NOW()`,
          })
          .where(and(eq(users.id, userId), ne(users.walletProvisioning, 'activated')));
        const result: AdminWalletReprovisionResult = {
          userId,
          priorProvisioning,
          attempts: 0,
          requeued: true,
        };
        const envelope: AdminAuditEnvelope<AdminWalletReprovisionResult> = buildAuditEnvelope({
          result,
          actor,
          idempotencyKey,
          appliedAt: new Date(),
          replayed: false,
        });
        return { status: 200, body: envelope as unknown as Record<string, unknown> };
      },
    );
  } catch (err) {
    log.error({ err, userId, actorUserId: actor.id }, 'Wallet reprovision failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to re-enqueue provisioning' }, 500);
  }

  if (guardResult.status === 200 && !guardResult.replayed) {
    // Fire-and-forget AFTER commit — same drive as signup; failures
    // are the sweeper's problem (whose budget we just reset).
    enqueueWalletProvisioning(userId);
    notifyAdminAudit({
      actorUserId: actor.id,
      endpoint: `POST /api/admin/users/${userId}/wallet/reprovision`,
      targetUserId: userId,
      reason,
      idempotencyKey,
      replayed: false,
    });
  }

  return c.json(guardResult.body, guardResult.status as 200 | 409 | 500);
}
