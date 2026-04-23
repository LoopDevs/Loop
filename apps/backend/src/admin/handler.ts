import type { Context } from 'hono';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { merchantCashbackConfigs, merchantCashbackConfigHistory } from '../db/schema.js';
import type { User } from '../db/users.js';
import { notifyCashbackConfigChanged, type CashbackConfigSnapshot } from '../discord.js';
import { getMerchants } from '../merchants/sync.js';
import { logger } from '../logger.js';

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
  })
  .refine((v) => v.wholesalePct + v.userCashbackPct + v.loopMarginPct <= 100, {
    message: 'wholesale + cashback + margin must be ≤ 100',
  });

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
  const body = await c.req.json().catch(() => null);
  const parsed = UpsertBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid body' },
      400,
    );
  }
  const admin = c.get('user') as User;
  // Snapshot the pre-edit row for the Discord audit diff (ADR 018).
  // One extra SELECT per admin edit — the configs table is tiny and
  // the write-audit signal is more valuable than the round-trip cost.
  // Null = first-time create path; the notifier renders it as a
  // distinct "created" embed rather than an update-with-no-diff.
  const previous = await db.query.merchantCashbackConfigs.findFirst({
    where: eq(merchantCashbackConfigs.merchantId, merchantId),
  });
  const previousSnapshot: CashbackConfigSnapshot | null =
    previous === undefined
      ? null
      : {
          wholesalePct: previous.wholesalePct,
          userCashbackPct: previous.userCashbackPct,
          loopMarginPct: previous.loopMarginPct,
          active: previous.active,
        };

  // numeric columns round-trip as strings in postgres-js; cast on
  // the way in to keep the type contract explicit.
  const values = {
    merchantId,
    wholesalePct: parsed.data.wholesalePct.toFixed(2),
    userCashbackPct: parsed.data.userCashbackPct.toFixed(2),
    loopMarginPct: parsed.data.loopMarginPct.toFixed(2),
    active: parsed.data.active ?? true,
    updatedBy: admin.id,
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

  // Fire-and-forget Discord audit AFTER the commit (ADR 018). A
  // webhook failure must never revert a successful config write.
  // Merchant-name resolution follows ADR 021 Rule A: fall back to
  // merchantId so a config-before-catalog edit still renders a
  // usable embed.
  const { merchantsById } = getMerchants();
  const merchantName = merchantsById.get(merchantId)?.name ?? merchantId;
  if (row !== undefined) {
    notifyCashbackConfigChanged({
      merchantId,
      merchantName,
      actorUserId: admin.id,
      previous: previousSnapshot,
      next: {
        wholesalePct: row.wholesalePct,
        userCashbackPct: row.userCashbackPct,
        loopMarginPct: row.loopMarginPct,
        active: row.active,
      },
    });
  }

  return c.json({ config: row }, 200);
}

/** GET /api/admin/merchant-cashback-configs/:merchantId/history */
export async function configHistoryHandler(c: Context): Promise<Response> {
  const merchantId = c.req.param('merchantId');
  if (merchantId === undefined || merchantId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId required' }, 400);
  }
  if (merchantId.length > MERCHANT_ID_MAX || !MERCHANT_ID_RE.test(merchantId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId is malformed' }, 400);
  }
  try {
    const rows = await db
      .select()
      .from(merchantCashbackConfigHistory)
      .where(eq(merchantCashbackConfigHistory.merchantId, merchantId))
      .orderBy(desc(merchantCashbackConfigHistory.changedAt))
      .limit(50);
    return c.json({ history: rows });
  } catch (err) {
    log.error({ err, merchantId }, 'admin config-history query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load config history' }, 500);
  }
}
