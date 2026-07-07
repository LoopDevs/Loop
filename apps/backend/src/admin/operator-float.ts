import type { Context } from 'hono';
import { z } from 'zod';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  OPERATOR_FLOAT_ASSETS,
  OPERATOR_FLOAT_CLASSIFICATIONS,
  OPERATOR_FLOAT_DIRECTIONS,
  operatorManualMovements,
  operatorWalletBaselines,
  operatorWalletMovements,
  type OperatorFloatAsset,
  type OperatorFloatClassification,
} from '../db/schema.js';
import type { User } from '../db/users.js';
import { notifyAdminAudit } from '../discord.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MAX,
  IDEMPOTENCY_KEY_MIN,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';

const StroopsString = z
  .string()
  .regex(/^[0-9]+$/, 'stroop amount must be a non-negative integer string')
  .transform((v) => BigInt(v));

const PositiveStroopsString = z
  .string()
  .regex(/^[0-9]+$/, 'stroop amount must be a positive integer string')
  .transform((v) => BigInt(v))
  .refine((v) => v > 0n, 'stroop amount must be positive');

const BaselineBody = z.object({
  asset: z.enum(OPERATOR_FLOAT_ASSETS),
  account: z.string().min(10).max(128),
  openingBalanceStroops: StroopsString,
  startingHorizonCursor: z.string().min(1).max(200).optional(),
  reason: z.string().min(2).max(500),
});

const ManualMovementBody = z.object({
  asset: z.enum(OPERATOR_FLOAT_ASSETS),
  account: z.string().min(10).max(128),
  direction: z.enum(OPERATOR_FLOAT_DIRECTIONS),
  amountStroops: PositiveStroopsString,
  movementPaymentId: z.string().min(1).max(200).optional(),
  effectiveAt: z.string().datetime().optional(),
  reason: z.string().min(2).max(500),
});

export interface AdminOperatorFloatMovement {
  paymentId: string;
  txHash: string;
  asset: 'xlm' | 'usdc';
  direction: 'in' | 'out';
  amountStroops: string;
  classification: string;
  fromAddress: string | null;
  toAddress: string | null;
  memoText: string | null;
  observedAt: string;
}

export interface AdminOperatorFloatMovementsResponse {
  movements: AdminOperatorFloatMovement[];
}

export interface AdminOperatorFloatBaselineResult {
  id: string;
  asset: OperatorFloatAsset;
  account: string;
  openingBalanceStroops: string;
  startingHorizonCursor: string | null;
  active: number;
  createdAt: string;
}

export interface AdminOperatorFloatManualMovementResult {
  id: string;
  asset: OperatorFloatAsset;
  account: string;
  direction: 'in' | 'out';
  amountStroops: string;
  movementPaymentId: string | null;
  effectiveAt: string;
  createdAt: string;
}

function idempotencyError(c: Context, idempotencyKey: string | undefined): Response | null {
  if (validateIdempotencyKey(idempotencyKey)) return null;
  return c.json(
    {
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: `Idempotency-Key header required (${IDEMPOTENCY_KEY_MIN}-${IDEMPOTENCY_KEY_MAX} chars)`,
    },
    400,
  );
}

function actorOr401(c: Context): User | Response {
  const actor = c.get('user') as User | undefined;
  if (actor === undefined) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Admin context missing' }, 401);
  }
  return actor;
}

async function parseJson(c: Context): Promise<unknown | Response> {
  try {
    return await c.req.json();
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' }, 400);
  }
}

function clampLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? '50', 10);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(Math.max(parsed, 1), 200);
}

function parseClassification(raw: string | undefined): OperatorFloatClassification {
  if (
    raw !== undefined &&
    (OPERATOR_FLOAT_CLASSIFICATIONS as ReadonlyArray<string>).includes(raw)
  ) {
    return raw as OperatorFloatClassification;
  }
  return 'unclassified';
}

/** GET /api/admin/operator-float/movements?classification=unclassified */
export async function adminOperatorFloatMovementsHandler(c: Context): Promise<Response> {
  const classification = parseClassification(c.req.query('classification'));
  const limit = clampLimit(c.req.query('limit') ?? null);
  const rows = await db
    .select({
      paymentId: operatorWalletMovements.paymentId,
      txHash: operatorWalletMovements.txHash,
      asset: operatorWalletMovements.asset,
      direction: operatorWalletMovements.direction,
      amountStroops: sql<string>`${operatorWalletMovements.amountStroops}::text`,
      classification: operatorWalletMovements.classification,
      fromAddress: operatorWalletMovements.fromAddress,
      toAddress: operatorWalletMovements.toAddress,
      memoText: operatorWalletMovements.memoText,
      observedAt: sql<string>`${operatorWalletMovements.observedAt}::text`,
    })
    .from(operatorWalletMovements)
    .where(eq(operatorWalletMovements.classification, classification))
    .orderBy(desc(operatorWalletMovements.observedAt))
    .limit(limit);

  return c.json<AdminOperatorFloatMovementsResponse>({ movements: rows });
}

/** POST /api/admin/operator-float/baselines */
export async function adminOperatorFloatBaselineCreateHandler(c: Context): Promise<Response> {
  const idempotencyKey = c.req.header('idempotency-key');
  const idemError = idempotencyError(c, idempotencyKey);
  if (idemError !== null) return idemError;
  const key = idempotencyKey as string;
  const actor = actorOr401(c);
  if (actor instanceof Response) return actor;

  const body = await parseJson(c);
  if (body instanceof Response) return body;
  const parsed = BaselineBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid body' },
      400,
    );
  }

  const path = '/api/admin/operator-float/baselines';
  const guardResult = await withIdempotencyGuard(
    {
      adminUserId: actor.id,
      key,
      method: 'POST',
      path,
    },
    async () => {
      const inserted = await db.transaction(async (tx) => {
        await tx
          .update(operatorWalletBaselines)
          .set({ active: 0, updatedAt: sql`NOW()` })
          .where(
            sql`${operatorWalletBaselines.account} = ${parsed.data.account}
              AND ${operatorWalletBaselines.asset} = ${parsed.data.asset}
              AND ${operatorWalletBaselines.active} = 1`,
          );

        const [row] = await tx
          .insert(operatorWalletBaselines)
          .values({
            asset: parsed.data.asset,
            account: parsed.data.account,
            openingBalanceStroops: parsed.data.openingBalanceStroops,
            startingHorizonCursor: parsed.data.startingHorizonCursor ?? null,
            currentHorizonCursor: parsed.data.startingHorizonCursor ?? null,
            reason: parsed.data.reason,
            createdBy: actor.id,
          })
          .returning();
        if (row === undefined) throw new Error('operator float baseline insert returned no row');
        return row;
      });

      const result: AdminOperatorFloatBaselineResult = {
        id: inserted.id,
        asset: inserted.asset,
        account: inserted.account,
        openingBalanceStroops: inserted.openingBalanceStroops.toString(),
        startingHorizonCursor: inserted.startingHorizonCursor,
        active: inserted.active,
        createdAt: inserted.createdAt.toISOString(),
      };
      const envelope: AdminAuditEnvelope<AdminOperatorFloatBaselineResult> = buildAuditEnvelope({
        result,
        actor,
        idempotencyKey: key,
        appliedAt: inserted.createdAt,
        replayed: false,
      });
      return { status: 200, body: envelope as unknown as Record<string, unknown> };
    },
  );

  notifyAdminAudit({
    actorUserId: actor.id,
    endpoint: 'POST /api/admin/operator-float/baselines',
    reason: parsed.data.reason,
    idempotencyKey: key,
    replayed: guardResult.replayed,
  });

  return c.json(guardResult.body, guardResult.status as 200 | 400 | 500);
}

/** POST /api/admin/operator-float/manual-movements */
export async function adminOperatorFloatManualMovementCreateHandler(c: Context): Promise<Response> {
  const idempotencyKey = c.req.header('idempotency-key');
  const idemError = idempotencyError(c, idempotencyKey);
  if (idemError !== null) return idemError;
  const key = idempotencyKey as string;
  const actor = actorOr401(c);
  if (actor instanceof Response) return actor;

  const body = await parseJson(c);
  if (body instanceof Response) return body;
  const parsed = ManualMovementBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid body' },
      400,
    );
  }

  const path = '/api/admin/operator-float/manual-movements';
  const guardResult = await withIdempotencyGuard(
    {
      adminUserId: actor.id,
      key,
      method: 'POST',
      path,
    },
    async () => {
      const inserted = await db.transaction(async (tx) => {
        const effectiveAt =
          parsed.data.effectiveAt !== undefined ? new Date(parsed.data.effectiveAt) : new Date();
        const [row] = await tx
          .insert(operatorManualMovements)
          .values({
            asset: parsed.data.asset,
            account: parsed.data.account,
            direction: parsed.data.direction,
            amountStroops: parsed.data.amountStroops,
            movementPaymentId: parsed.data.movementPaymentId ?? null,
            effectiveAt,
            reason: parsed.data.reason,
            createdBy: actor.id,
          })
          .returning();
        if (row === undefined) {
          throw new Error('operator float manual movement insert returned no row');
        }
        if (row.movementPaymentId !== null) {
          await tx
            .update(operatorWalletMovements)
            .set({
              classification: 'manual',
              manualMovementId: row.id,
              updatedAt: sql`NOW()`,
            })
            .where(eq(operatorWalletMovements.paymentId, row.movementPaymentId));
        }
        return row;
      });

      const result: AdminOperatorFloatManualMovementResult = {
        id: inserted.id,
        asset: inserted.asset,
        account: inserted.account,
        direction: inserted.direction,
        amountStroops: inserted.amountStroops.toString(),
        movementPaymentId: inserted.movementPaymentId,
        effectiveAt: inserted.effectiveAt.toISOString(),
        createdAt: inserted.createdAt.toISOString(),
      };
      const envelope: AdminAuditEnvelope<AdminOperatorFloatManualMovementResult> =
        buildAuditEnvelope({
          result,
          actor,
          idempotencyKey: key,
          appliedAt: inserted.createdAt,
          replayed: false,
        });
      return { status: 200, body: envelope as unknown as Record<string, unknown> };
    },
  );

  notifyAdminAudit({
    actorUserId: actor.id,
    endpoint: 'POST /api/admin/operator-float/manual-movements',
    reason: parsed.data.reason,
    idempotencyKey: key,
    replayed: guardResult.replayed,
  });

  return c.json(guardResult.body, guardResult.status as 200 | 400 | 500);
}
