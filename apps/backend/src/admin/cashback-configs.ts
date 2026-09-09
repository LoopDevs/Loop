/**
 * Merchant cashback configuration — the admin CRUD behind ADR 011's
 * single "User Cashback %" knob.
 *
 * `GET /api/admin/merchant-cashback-configs`               — list
 * `GET /api/admin/merchant-cashback-configs.csv`           — export
 * `PUT /api/admin/merchant-cashback-configs/:merchantId`   — upsert
 * `GET /api/admin/merchant-cashback-configs/:merchantId/history`
 *
 * This is the only way the rate gets set. `merchant_cashback_configs`
 * is read on the order path (what the customer is promised), on the
 * public catalog (what the marketing surfaces advertise) and by the
 * CTX link builder — but nothing writes it, so without this endpoint
 * every merchant sits on the fallback split from
 * `orders.cashbackDefaults` forever.
 *
 * The write carries the full ADR 017 contract — actor from the staff
 * gate, Idempotency-Key, a required reason, `{ result, audit }`, a
 * post-write Discord line — plus the ADR 028 step-up gate, because it
 * sets the split that FUTURE orders stamp at creation. That is
 * squarely the stolen-bearer threat: nobody notices a rate quietly
 * moved to 0% until the customers do.
 *
 * Every edit writes a history entry BEFORE touching the live row, so
 * a crash between the two leaves a history entry with no change
 * rather than a change with no history. Over-recording is auditable;
 * under-recording is not.
 */
import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import type { MerchantCashbackConfigDoc } from '../db/types.js';
import type { User } from '../db/users.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { csvRow } from './csv-escape.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';

const log = logger.child({ handler: 'admin-cashback-configs' });

// A2-513: catalog-id characters only, capped — the same shape check
// the other per-merchant admin handlers use, so a malformed id never
// reaches the store as a surprisingly wide key.
const MERCHANT_ID_RE = /^[A-Za-z0-9._-]+$/;
const MERCHANT_ID_MAX = 128;

const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 200;

export interface CashbackConfigView {
  merchantId: string;
  userCashbackPct: number;
  active: boolean;
  updatedBy: string;
  updatedAt: string;
}

function toView(row: MerchantCashbackConfigDoc): CashbackConfigView {
  return {
    merchantId: row.merchantId,
    userCashbackPct: row.userCashbackPct,
    active: row.active,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function validateMerchantId(c: Context): Response | string {
  const merchantId = c.req.param('merchantId');
  if (merchantId === undefined || merchantId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId is required' }, 400);
  }
  if (merchantId.length > MERCHANT_ID_MAX || !MERCHANT_ID_RE.test(merchantId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId is malformed' }, 400);
  }
  return merchantId;
}

/** GET /api/admin/merchant-cashback-configs */
export async function listConfigsHandler(c: Context): Promise<Response> {
  try {
    const rows = await db
      .collection('merchant_cashback_configs')
      .findMany({}, { sort: [['merchantId', 'asc']] });
    return c.json({ configs: rows.map(toView) });
  } catch (err) {
    // A2-507: keep the handler-scoped binding so a failed load
    // correlates to this line by request id rather than to the generic
    // global onError message.
    log.error({ err }, 'admin list-configs query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load cashback configs' }, 500);
  }
}

/** GET /api/admin/merchant-cashback-configs.csv */
export async function cashbackConfigsCsvHandler(c: Context): Promise<Response> {
  try {
    const rows = await db
      .collection('merchant_cashback_configs')
      .findMany({}, { sort: [['merchantId', 'asc']] });
    const lines = [
      csvRow(['merchant_id', 'user_cashback_pct', 'active', 'updated_by', 'updated_at']),
    ];
    for (const row of rows) {
      const v = toView(row);
      lines.push(
        csvRow([
          v.merchantId,
          String(v.userCashbackPct),
          v.active ? 'true' : 'false',
          v.updatedBy,
          v.updatedAt,
        ]),
      );
    }
    return new Response(`${lines.join('\n')}\n`, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="merchant-cashback-configs.csv"',
        'cache-control': 'private, no-store',
      },
    });
  } catch (err) {
    log.error({ err }, 'admin cashback-configs CSV export failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to export cashback configs' }, 500);
  }
}

const UpsertBody = z.object({
  /**
   * Percent of face value returned to the user, max two decimals. The
   * upper bound is the fallback guard's: a split above 100% would mean
   * Loop paying the customer more than the card is worth.
   */
  userCashbackPct: z.coerce.number().min(0).max(100),
  active: z.boolean().optional(),
  // A2-502: every admin write carries a rationale, so the audit trail
  // answers "why" without anyone reaching for chat history.
  reason: z.string().min(2).max(500),
});

/** PUT /api/admin/merchant-cashback-configs/:merchantId */
export async function upsertConfigHandler(c: Context): Promise<Response> {
  const merchantIdOrResponse = validateMerchantId(c);
  if (merchantIdOrResponse instanceof Response) return merchantIdOrResponse;
  const merchantId = merchantIdOrResponse;

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
  const parsed = UpsertBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid body' },
      400,
    );
  }

  let guardResult: Awaited<ReturnType<typeof withIdempotencyGuard>>;
  try {
    guardResult = await withIdempotencyGuard(
      {
        adminUserId: actor.id,
        key: idempotencyKey,
        method: 'PUT',
        path: `/api/admin/merchant-cashback-configs/${merchantId}`,
      },
      async () => {
        const configs = db.collection('merchant_cashback_configs');
        const prior = await configs.findOne({ merchantId });
        const updatedAt = new Date();
        const active = parsed.data.active ?? prior?.active ?? true;

        // History first — see the module docstring on why this order.
        await db.collection('merchant_cashback_config_history').insertOne({
          id: randomUUID(),
          merchantId,
          priorUserCashbackPct: prior?.userCashbackPct ?? null,
          priorActive: prior?.active ?? null,
          newUserCashbackPct: parsed.data.userCashbackPct,
          newActive: active,
          changedByUserId: actor.id,
          changedByEmail: actor.email,
          reason: parsed.data.reason,
          changedAt: updatedAt,
        });

        const doc: MerchantCashbackConfigDoc = {
          merchantId,
          userCashbackPct: parsed.data.userCashbackPct,
          active,
          updatedBy: actor.email,
          updatedAt,
        };
        await configs.replaceOne({ merchantId }, doc, { upsert: true });

        const envelope: AdminAuditEnvelope<CashbackConfigView> = buildAuditEnvelope({
          result: toView(doc),
          actor,
          idempotencyKey,
          appliedAt: updatedAt,
          replayed: false,
        });
        return { status: 200, body: envelope as unknown as Record<string, unknown> };
      },
    );
  } catch (err) {
    log.error({ err, merchantId, adminUserId: actor.id }, 'Cashback-config upsert failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to save the cashback config' }, 500);
  }

  notifyAdminAudit({
    actorUserId: actor.id,
    endpoint: `PUT /api/admin/merchant-cashback-configs/${merchantId}`,
    reason: `${merchantId} → ${parsed.data.userCashbackPct}%: ${parsed.data.reason}`,
    idempotencyKey,
    replayed: guardResult.replayed,
  });

  return c.json(guardResult.body, guardResult.status as 200 | 400 | 500);
}

export interface CashbackConfigHistoryEntry {
  id: string;
  merchantId: string;
  priorUserCashbackPct: number | null;
  priorActive: boolean | null;
  newUserCashbackPct: number;
  newActive: boolean;
  changedByUserId: string;
  changedByEmail: string;
  reason: string;
  changedAt: string;
}

/**
 * GET /api/admin/merchant-cashback-configs/:merchantId/history
 *
 * Newest first. This is the surface that makes the rate reviewable:
 * the live row only says what the rate IS, and "when did this drop to
 * zero, and who signed off" is the question an incident actually asks.
 */
export async function configHistoryHandler(c: Context): Promise<Response> {
  const merchantIdOrResponse = validateMerchantId(c);
  if (merchantIdOrResponse instanceof Response) return merchantIdOrResponse;
  const merchantId = merchantIdOrResponse;

  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? String(HISTORY_DEFAULT_LIMIT), 10);
  const limit = Math.min(
    Math.max(Number.isNaN(parsedLimit) ? HISTORY_DEFAULT_LIMIT : parsedLimit, 1),
    HISTORY_MAX_LIMIT,
  );

  try {
    const rows = await db
      .collection('merchant_cashback_config_history')
      .findMany({ merchantId }, { sort: [['changedAt', 'desc']], limit });
    return c.json({
      history: rows.map(
        (r): CashbackConfigHistoryEntry => ({
          id: r.id,
          merchantId: r.merchantId,
          priorUserCashbackPct: r.priorUserCashbackPct,
          priorActive: r.priorActive,
          newUserCashbackPct: r.newUserCashbackPct,
          newActive: r.newActive,
          changedByUserId: r.changedByUserId,
          changedByEmail: r.changedByEmail,
          reason: r.reason,
          changedAt: r.changedAt.toISOString(),
        }),
      ),
    });
  } catch (err) {
    log.error({ err, merchantId }, 'Cashback-config history query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load the config history' }, 500);
  }
}
