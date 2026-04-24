/**
 * Admin manual merchant-catalog resync (ADR 011).
 *
 * `POST /api/admin/merchants/resync` — forces an immediate sweep of
 * the upstream CTX catalog so ops can apply a merchant change (new
 * store, denomination tweak, disabled flag flip) within seconds
 * instead of waiting for the 6h scheduled refresh. The in-memory
 * merchant cache is atomically swapped once the new snapshot is
 * fully built.
 *
 * Rate-limited tightly (2/min) because every hit goes to CTX —
 * this is a manual override, not a polled surface. Two admins
 * clicking the button simultaneously coalesce into a single
 * upstream sweep via the existing mutex inside `refreshMerchants`;
 * one sees `triggered: true`, the other `triggered: false` with
 * the same post-sync `loadedAt`.
 *
 * 502 on upstream failure, not 500 — it's a CTX problem, not a
 * backend bug. The cached snapshot is retained (not zeroed) on
 * failure so the `/api/merchants` surface keeps serving prior data.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { forceRefreshMerchants, getMerchants } from '../merchants/sync.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import type { User } from '../db/users.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';

const log = logger.child({ handler: 'admin-merchants-resync' });

export interface AdminMerchantResyncResponse {
  /** Post-sync merchant count — snapshot-total, not delta vs. pre-sync. */
  merchantCount: number;
  /** ISO-8601 timestamp of the currently-loaded snapshot. */
  loadedAt: string;
  /** Whether THIS call advanced the store. `false` means another sweep was already in flight and this call coalesced. */
  triggered: boolean;
}

const BodySchema = z.object({
  // A2-509: ADR-017 admin write. `reason` captures WHY ops forced a
  // resync so the audit feed answers the question later without
  // having to reach for Slack.
  reason: z.string().min(2).max(500),
});

export async function adminMerchantsResyncHandler(c: Context): Promise<Response> {
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

  let guardResult;
  try {
    guardResult = await withIdempotencyGuard(
      {
        adminUserId: actor.id,
        key: idempotencyKey,
        method: 'POST',
        path: '/api/admin/merchants/resync',
      },
      async () => {
        const outcome = await forceRefreshMerchants();
        const store = getMerchants();
        const result: AdminMerchantResyncResponse = {
          merchantCount: store.merchants.length,
          loadedAt: new Date(store.loadedAt).toISOString(),
          triggered: outcome.triggered,
        };
        const envelope: AdminAuditEnvelope<AdminMerchantResyncResponse> = buildAuditEnvelope({
          result,
          actor,
          idempotencyKey,
          appliedAt: new Date(store.loadedAt),
          replayed: false,
        });
        return { status: 200, body: envelope as unknown as Record<string, unknown> };
      },
    );
  } catch (err) {
    log.error({ err }, 'Admin merchant-catalog resync failed');
    return c.json(
      {
        code: 'UPSTREAM_ERROR',
        message: 'Failed to refresh merchant catalog from upstream',
      },
      502,
    );
  }

  notifyAdminAudit({
    actorUserId: actor.id,
    endpoint: 'POST /api/admin/merchants/resync',
    reason: parsed.data.reason,
    idempotencyKey,
    replayed: guardResult.replayed,
  });

  return c.json(guardResult.body, guardResult.status as 200 | 400 | 500);
}
