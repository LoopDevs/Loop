import type { Context } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { merchantCashbackConfigs } from '../db/schema.js';
import type { User } from '../db/users.js';
import {
  notifyAdminAudit,
  notifyCashbackConfigChanged,
  type CashbackConfigSnapshot,
} from '../discord.js';
import { getMerchants } from '../merchants/sync.js';
import { logger } from '../logger.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';

const log = logger.child({ handler: 'admin-cashback-configs' });

/**
 * Admin — cashback config endpoints (ADR 011). All routes expect
 * `requireAuth` + `requireAdmin` to have run; the admin's User row
 * is on `c.get('user')`.
 */

const UpsertBody = z
  .object({
    wholesalePct: z.coerce.number().min(0).max(100),
    userCashbackPct: z.coerce.number().min(0).max(100),
    loopMarginPct: z.coerce.number().min(0).max(100),
    active: z.boolean().optional(),
    // A2-502: ADR-017 compliance. Every admin write is now required
    // to carry a rationale so the audit trail answers "why" without
    // having to reach for Slack / ops chat. 2..500 chars mirrors the
    // adjustment + refund handlers.
    reason: z.string().min(2).max(500),
  })
  .refine((v) => v.wholesalePct + v.userCashbackPct + v.loopMarginPct <= 100, {
    message: 'wholesale + cashback + margin must be ≤ 100',
  });

export interface CashbackConfigResult {
  merchantId: string;
  wholesalePct: string;
  userCashbackPct: string;
  loopMarginPct: string;
  active: boolean;
  updatedBy: string;
  /** ISO-8601 — when the DB row landed. */
  updatedAt: string;
}

// A2-513: match the shape check used by sibling per-merchant admin
// handlers (merchant-cashback-summary, merchant-top-earners, etc.) —
// catalog-id chars only, capped at 128. Keeps malformed IDs from
// reaching the DB as a parameterised SQL literal with surprising
// width.
const MERCHANT_ID_RE = /^[A-Za-z0-9._-]+$/;
const MERCHANT_ID_MAX = 128;

/** GET /api/admin/merchant-cashback-configs */
export async function listConfigsHandler(c: Context): Promise<Response> {
  try {
    const rows = await db
      .select()
      .from(merchantCashbackConfigs)
      .orderBy(merchantCashbackConfigs.merchantId);
    return c.json({ configs: rows });
  } catch (err) {
    // A2-507: keep the handler-scoped logger binding so the request-id
    // correlates an /admin/cashback-configs load failure with this log
    // line rather than the generic global onError message.
    log.error({ err }, 'admin list-configs query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load cashback configs' }, 500);
  }
}

/**
 * PUT /api/admin/merchant-cashback-configs/:merchantId
 *
 * A2-502: ADR-017 compliant. Actor from `c.get('user')`;
 * `Idempotency-Key` header required (replay safe); `reason` required
 * in the body; response envelope is `{ result, audit }`; Discord
 * fanout fires AFTER commit.
 *
 * Upsert semantics: missing row becomes an INSERT, existing row is
 * UPDATEd and the audit trigger captures the pre-edit values into
 * `merchant_cashback_config_history`.
 */
export async function upsertConfigHandler(c: Context): Promise<Response> {
  const merchantId = c.req.param('merchantId');
  if (merchantId === undefined || merchantId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId required' }, 400);
  }
  if (merchantId.length > MERCHANT_ID_MAX || !MERCHANT_ID_RE.test(merchantId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId is malformed' }, 400);
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
    // `requireAdmin` should have populated this — fail closed.
    return c.json({ code: 'UNAUTHORIZED', message: 'Admin context missing' }, 401);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = UpsertBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid body' },
      400,
    );
  }

  let guardResult;
  let previousSnapshot: CashbackConfigSnapshot | null = null;
  try {
    guardResult = await withIdempotencyGuard(
      {
        adminUserId: actor.id,
        key: idempotencyKey,
        method: 'PUT',
        path: `/api/admin/merchant-cashback-configs/${merchantId}`,
      },
      async () => {
        // Snapshot the pre-edit row for the Discord audit diff (ADR 018).
        // One extra SELECT per admin edit — the configs table is tiny
        // and the write-audit signal is more valuable than the
        // round-trip cost. Null = first-time create path; the notifier
        // renders it as a distinct "created" embed.
        const previous = await db.query.merchantCashbackConfigs.findFirst({
          where: eq(merchantCashbackConfigs.merchantId, merchantId),
        });
        previousSnapshot =
          previous === undefined
            ? null
            : {
                wholesalePct: previous.wholesalePct,
                userCashbackPct: previous.userCashbackPct,
                loopMarginPct: previous.loopMarginPct,
                active: previous.active,
              };

        // numeric columns round-trip as strings in postgres-js; cast
        // on the way in to keep the type contract explicit.
        const values = {
          merchantId,
          wholesalePct: parsed.data.wholesalePct.toFixed(2),
          userCashbackPct: parsed.data.userCashbackPct.toFixed(2),
          loopMarginPct: parsed.data.loopMarginPct.toFixed(2),
          active: parsed.data.active ?? true,
          updatedBy: actor.id,
        };
        const [row] = await db
          .insert(merchantCashbackConfigs)
          .values(values)
          .onConflictDoUpdate({
            target: merchantCashbackConfigs.merchantId,
            set: {
              wholesalePct: values.wholesalePct,
              userCashbackPct: values.userCashbackPct,
              loopMarginPct: values.loopMarginPct,
              active: values.active,
              updatedBy: values.updatedBy,
              updatedAt: new Date(),
            },
          })
          .returning();
        if (row === undefined) {
          throw new Error('merchant_cashback_configs upsert returned no row');
        }

        const result: CashbackConfigResult = {
          merchantId: row.merchantId,
          wholesalePct: row.wholesalePct,
          userCashbackPct: row.userCashbackPct,
          loopMarginPct: row.loopMarginPct,
          active: row.active,
          updatedBy: row.updatedBy,
          updatedAt: row.updatedAt.toISOString(),
        };
        const envelope: AdminAuditEnvelope<CashbackConfigResult> = buildAuditEnvelope({
          result,
          actor,
          idempotencyKey,
          appliedAt: row.updatedAt,
          replayed: false,
        });
        return { status: 200, body: envelope as unknown as Record<string, unknown> };
      },
    );
  } catch (err) {
    log.error({ err, merchantId, adminUserId: actor.id }, 'Cashback config upsert failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to upsert cashback config' }, 500);
  }

  // Fire-and-forget Discord fanout AFTER commit (ADR 017 #5 / ADR 018).
  // The config-specific notifier renders a diff of the pcts; the
  // generic admin-audit notifier renders the standard one-line write
  // event for the audit channel. Both run on replay too so ops still
  // sees the event.
  const nextResult = (guardResult.body as { result?: CashbackConfigResult }).result;
  const { merchantsById } = getMerchants();
  const merchantName = merchantsById.get(merchantId)?.name ?? merchantId;
  if (nextResult !== undefined && !guardResult.replayed) {
    notifyCashbackConfigChanged({
      merchantId,
      merchantName,
      actorUserId: actor.id,
      previous: previousSnapshot,
      next: {
        wholesalePct: nextResult.wholesalePct,
        userCashbackPct: nextResult.userCashbackPct,
        loopMarginPct: nextResult.loopMarginPct,
        active: nextResult.active,
      },
    });
  }
  notifyAdminAudit({
    actorUserId: actor.id,
    endpoint: `PUT /api/admin/merchant-cashback-configs/${merchantId}`,
    reason: parsed.data.reason,
    idempotencyKey,
    replayed: guardResult.replayed,
  });

  return c.json(guardResult.body, guardResult.status as 200 | 400 | 409 | 500);
}

// `configHistoryHandler` (the read-side audit-log query) lives
// in `./config-history-handler.ts`. Re-exported here so
// `routes/admin-cashback-config.ts` and the test suite keep
// resolving against `'../admin/handler.js'`.
export { configHistoryHandler } from './config-history-handler.js';
