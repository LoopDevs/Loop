import type { Context } from 'hono';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { merchantCashbackConfigs, merchantCashbackConfigHistory } from '../db/schema.js';
import type { User } from '../db/users.js';

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

/** GET /api/admin/merchant-cashback-configs */
export async function listConfigsHandler(c: Context): Promise<Response> {
  const rows = await db
    .select()
    .from(merchantCashbackConfigs)
    .orderBy(merchantCashbackConfigs.merchantId);
  return c.json({ configs: rows });
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
  const body = await c.req.json().catch(() => null);
  const parsed = UpsertBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid body' },
      400,
    );
  }
  const admin = c.get('user') as User;
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
  return c.json({ config: row }, 200);
}

/** GET /api/admin/merchant-cashback-configs/:merchantId/history */
export async function configHistoryHandler(c: Context): Promise<Response> {
  const merchantId = c.req.param('merchantId');
  if (merchantId === undefined || merchantId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId required' }, 400);
  }
  const rows = await db
    .select()
    .from(merchantCashbackConfigHistory)
    .where(eq(merchantCashbackConfigHistory.merchantId, merchantId))
    .orderBy(desc(merchantCashbackConfigHistory.changedAt))
    .limit(50);
  return c.json({ history: rows });
}
