/**
 * R3-1 operator wallet conservation check.
 *
 * This reconciles the real XLM/USDC operator/deposit wallet over
 * time. It deliberately fails closed without an operator-created
 * baseline: a current Horizon balance alone is not evidence that user
 * deposits, CTX settlements, refunds, fees, top-ups and sweeps
 * conserved correctly.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db, withAdvisoryLock } from '../db/client.js';
import {
  ctxSettlements,
  operatorFloatReconciliationRuns,
  operatorManualMovements,
  operatorWalletBaselines,
  operatorWalletMovements,
  orders,
  paymentWatcherSkips,
  type OperatorFloatAsset,
  type OperatorFloatClassification,
  type OperatorFloatDirection,
  type OperatorFloatRunState,
} from '../db/schema.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import {
  markWorkerStarted,
  markWorkerStopped,
  markWorkerTickFailure,
  markWorkerTickSuccess,
} from '../runtime-health.js';
import { notifyOperatorFloatDrift } from '../discord.js';
import { listAccountPayments, type HorizonPayment } from './horizon.js';
import { getAccountBalances } from './horizon-balances.js';
import { parseStroops } from './stroops.js';

const log = logger.child({ area: 'operator-float-reconciliation' });

export interface ExtractedOperatorMovement {
  paymentId: string;
  txHash: string;
  pagingToken: string;
  account: string;
  asset: OperatorFloatAsset;
  assetCode: 'XLM' | 'USDC';
  assetIssuer: string | null;
  direction: OperatorFloatDirection;
  fromAddress: string | null;
  toAddress: string | null;
  memoText: string | null;
  amountStroops: bigint;
  rawPayment: HorizonPayment;
}

export interface MovementClassification {
  classification: OperatorFloatClassification;
  orderId: string | null;
  refundPaymentId: string | null;
  settlementId: string | null;
  manualMovementId: string | null;
}

export interface OperatorFloatRunSummary {
  asset: OperatorFloatAsset;
  account: string;
  baselineId: string | null;
  expectedBalanceStroops: bigint | null;
  actualBalanceStroops: bigint | null;
  deltaStroops: bigint | null;
  thresholdStroops: bigint;
  unclassifiedCount: number;
  indexedMovementCount: number;
  state: OperatorFloatRunState;
  error: string | null;
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function lockKey(): bigint {
  const digest = createHash('sha256').update('loop:operator-float-reconciliation').digest();
  const raw =
    (BigInt(digest[0]!) << 56n) |
    (BigInt(digest[1]!) << 48n) |
    (BigInt(digest[2]!) << 40n) |
    (BigInt(digest[3]!) << 32n) |
    (BigInt(digest[4]!) << 24n) |
    (BigInt(digest[5]!) << 16n) |
    (BigInt(digest[6]!) << 8n) |
    BigInt(digest[7]!);
  return BigInt.asIntN(64, raw);
}

export function thresholdForAsset(asset: OperatorFloatAsset): bigint {
  return asset === 'xlm'
    ? env.LOOP_OPERATOR_FLOAT_XLM_THRESHOLD_STROOPS
    : env.LOOP_OPERATOR_FLOAT_USDC_THRESHOLD_STROOPS;
}

export function extractOperatorMovement(args: {
  payment: HorizonPayment;
  account: string;
  usdcIssuer: string | null;
}): ExtractedOperatorMovement | null {
  const p = args.payment;
  if (p.type !== 'payment') return null;
  if (p.transaction_successful === false || p.transaction?.successful === false) return null;
  const involvesAccount = p.from === args.account || p.to === args.account;
  if (!involvesAccount) return null;
  if (p.from === args.account && p.to === args.account) return null;
  if (p.amount === undefined) return null;

  let amountStroops: bigint;
  try {
    amountStroops = parseStroops(p.amount);
  } catch {
    return null;
  }
  if (amountStroops <= 0n) return null;

  let asset: OperatorFloatAsset;
  let assetCode: 'XLM' | 'USDC';
  let assetIssuer: string | null;
  if (p.asset_type === 'native') {
    asset = 'xlm';
    assetCode = 'XLM';
    assetIssuer = null;
  } else if (
    (p.asset_type === 'credit_alphanum4' || p.asset_type === 'credit_alphanum12') &&
    p.asset_code === 'USDC' &&
    (args.usdcIssuer === null || p.asset_issuer === args.usdcIssuer)
  ) {
    asset = 'usdc';
    assetCode = 'USDC';
    assetIssuer = p.asset_issuer ?? null;
  } else {
    return null;
  }

  return {
    paymentId: p.id,
    txHash: p.transaction_hash,
    pagingToken: p.paging_token,
    account: args.account,
    asset,
    assetCode,
    assetIssuer,
    direction: p.to === args.account ? 'in' : 'out',
    fromAddress: p.from ?? null,
    toAddress: p.to ?? null,
    memoText: p.transaction?.memo ?? null,
    amountStroops,
    rawPayment: p,
  };
}

export function computeExpectedBalance(args: {
  openingBalanceStroops: bigint;
  classifiedMovementDeltaStroops: bigint;
  unlinkedManualDeltaStroops: bigint;
}): bigint {
  return (
    args.openingBalanceStroops +
    args.classifiedMovementDeltaStroops +
    args.unlinkedManualDeltaStroops
  );
}

export function classifyRun(args: {
  deltaStroops: bigint;
  thresholdStroops: bigint;
  unclassifiedCount: number;
}): OperatorFloatRunState {
  if (args.unclassifiedCount > 0) return 'unclassified';
  return abs(args.deltaStroops) > args.thresholdStroops ? 'drift' : 'ok';
}

export async function classifyMovement(
  movement: ExtractedOperatorMovement,
): Promise<MovementClassification> {
  const [manual] = await db
    .select({ id: operatorManualMovements.id })
    .from(operatorManualMovements)
    .where(eq(operatorManualMovements.movementPaymentId, movement.paymentId))
    .limit(1);
  if (manual !== undefined) {
    return {
      classification: 'manual',
      orderId: null,
      refundPaymentId: null,
      settlementId: null,
      manualMovementId: manual.id,
    };
  }

  if (movement.direction === 'in') {
    const [order] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.paymentReceivedHorizonId, movement.paymentId))
      .limit(1);
    if (order !== undefined) {
      return {
        classification: 'user_deposit',
        orderId: order.id,
        refundPaymentId: null,
        settlementId: null,
        manualMovementId: null,
      };
    }

    const [skip] = await db
      .select({ paymentId: paymentWatcherSkips.paymentId })
      .from(paymentWatcherSkips)
      .where(eq(paymentWatcherSkips.paymentId, movement.paymentId))
      .limit(1);
    if (skip !== undefined) {
      return {
        classification: 'user_deposit',
        orderId: null,
        refundPaymentId: skip.paymentId,
        settlementId: null,
        manualMovementId: null,
      };
    }
  } else {
    const [refund] = await db
      .select({ paymentId: paymentWatcherSkips.paymentId })
      .from(paymentWatcherSkips)
      .where(eq(paymentWatcherSkips.refundTxHash, movement.txHash))
      .limit(1);
    if (refund !== undefined) {
      return {
        classification: 'deposit_refund',
        orderId: null,
        refundPaymentId: refund.paymentId,
        settlementId: null,
        manualMovementId: null,
      };
    }

    const [settlement] = await db
      .select({ id: ctxSettlements.id })
      .from(ctxSettlements)
      .where(eq(ctxSettlements.txHash, movement.txHash))
      .limit(1);
    if (settlement !== undefined) {
      return {
        classification: 'ctx_settlement',
        orderId: null,
        refundPaymentId: null,
        settlementId: settlement.id,
        manualMovementId: null,
      };
    }
  }

  return {
    classification: 'unclassified',
    orderId: null,
    refundPaymentId: null,
    settlementId: null,
    manualMovementId: null,
  };
}

export async function upsertOperatorMovement(
  movement: ExtractedOperatorMovement,
  classification: MovementClassification,
): Promise<void> {
  await db
    .insert(operatorWalletMovements)
    .values({
      paymentId: movement.paymentId,
      txHash: movement.txHash,
      pagingToken: movement.pagingToken,
      account: movement.account,
      asset: movement.asset,
      assetCode: movement.assetCode,
      assetIssuer: movement.assetIssuer,
      direction: movement.direction,
      fromAddress: movement.fromAddress,
      toAddress: movement.toAddress,
      memoText: movement.memoText,
      amountStroops: movement.amountStroops,
      classification: classification.classification,
      orderId: classification.orderId,
      refundPaymentId: classification.refundPaymentId,
      settlementId: classification.settlementId,
      manualMovementId: classification.manualMovementId,
      rawPayment: movement.rawPayment,
    })
    .onConflictDoUpdate({
      target: operatorWalletMovements.paymentId,
      set: {
        classification: classification.classification,
        orderId: classification.orderId,
        refundPaymentId: classification.refundPaymentId,
        settlementId: classification.settlementId,
        manualMovementId: classification.manualMovementId,
        updatedAt: sql`NOW()`,
      },
    });
}

async function loadActiveBaseline(args: {
  account: string;
  asset: OperatorFloatAsset;
}): Promise<typeof operatorWalletBaselines.$inferSelect | null> {
  const [baseline] = await db
    .select()
    .from(operatorWalletBaselines)
    .where(
      and(
        eq(operatorWalletBaselines.account, args.account),
        eq(operatorWalletBaselines.asset, args.asset),
        eq(operatorWalletBaselines.active, 1),
      ),
    )
    .orderBy(desc(operatorWalletBaselines.createdAt))
    .limit(1);
  return baseline ?? null;
}

async function persistRun(args: OperatorFloatRunSummary): Promise<void> {
  await db.insert(operatorFloatReconciliationRuns).values({
    asset: args.asset,
    account: args.account,
    baselineId: args.baselineId,
    expectedBalanceStroops: args.expectedBalanceStroops,
    actualBalanceStroops: args.actualBalanceStroops,
    deltaStroops: args.deltaStroops,
    thresholdStroops: args.thresholdStroops,
    unclassifiedCount: args.unclassifiedCount,
    indexedMovementCount: args.indexedMovementCount,
    state: args.state,
    error: args.error,
  });
}

async function recordNeedsBaseline(args: {
  account: string;
  asset: OperatorFloatAsset;
  thresholdStroops: bigint;
}): Promise<OperatorFloatRunSummary> {
  const summary: OperatorFloatRunSummary = {
    account: args.account,
    asset: args.asset,
    baselineId: null,
    expectedBalanceStroops: null,
    actualBalanceStroops: null,
    deltaStroops: null,
    thresholdStroops: args.thresholdStroops,
    unclassifiedCount: 0,
    indexedMovementCount: 0,
    state: 'needs_baseline',
    error: 'operator float baseline is not configured',
  };
  await persistRun(summary);
  return summary;
}

async function indexNewMovements(args: {
  account: string;
  asset: OperatorFloatAsset;
  usdcIssuer: string | null;
  baselineId: string;
  cursor: string | null;
  maxPages: number;
}): Promise<number> {
  let cursor = args.cursor ?? undefined;
  let indexed = 0;
  let lastPagingToken: string | null = null;
  for (let page = 0; page < args.maxPages; page++) {
    const res = await listAccountPayments({
      account: args.account,
      limit: 200,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    for (const payment of res.records) {
      const movement = extractOperatorMovement({
        payment,
        account: args.account,
        usdcIssuer: args.usdcIssuer,
      });
      if (movement === null || movement.asset !== args.asset) continue;
      const classification = await classifyMovement(movement);
      await upsertOperatorMovement(movement, classification);
      indexed++;
      lastPagingToken = movement.pagingToken;
    }
    if (res.records.length === 0 || res.nextCursor === null) break;
    cursor = res.nextCursor;
  }

  const nextCursor = lastPagingToken ?? cursor ?? null;
  if (nextCursor !== null) {
    await db
      .update(operatorWalletBaselines)
      .set({ currentHorizonCursor: nextCursor, updatedAt: sql`NOW()` })
      .where(eq(operatorWalletBaselines.id, args.baselineId));
  }
  return indexed;
}

async function computeMovementTotals(args: {
  account: string;
  asset: OperatorFloatAsset;
  baselineCreatedAt: Date;
}): Promise<{
  classifiedMovementDeltaStroops: bigint;
  unclassifiedCount: number;
  indexedMovementCount: number;
}> {
  const rows = await db.execute<{
    classified_delta: bigint | null;
    unclassified_count: number;
    movement_count: number;
  }>(sql`
    SELECT
      COALESCE(SUM(
        CASE
          WHEN classification <> 'unclassified' AND direction = 'in' THEN amount_stroops
          WHEN classification <> 'unclassified' AND direction = 'out' THEN -amount_stroops
          ELSE 0
        END
      ), 0)::bigint AS classified_delta,
      COUNT(*) FILTER (WHERE classification = 'unclassified')::int AS unclassified_count,
      COUNT(*)::int AS movement_count
    FROM operator_wallet_movements
    WHERE account = ${args.account}
      AND asset = ${args.asset}
      AND observed_at >= ${args.baselineCreatedAt}
  `);
  const normalized = rows as
    | Array<{
        classified_delta: bigint | null;
        unclassified_count: number;
        movement_count: number;
      }>
    | {
        rows: Array<{
          classified_delta: bigint | null;
          unclassified_count: number;
          movement_count: number;
        }>;
      };
  const first = Array.isArray(normalized) ? normalized[0] : normalized.rows[0];
  return {
    classifiedMovementDeltaStroops: first?.classified_delta ?? 0n,
    unclassifiedCount: first?.unclassified_count ?? 0,
    indexedMovementCount: first?.movement_count ?? 0,
  };
}

async function computeUnlinkedManualDelta(args: {
  account: string;
  asset: OperatorFloatAsset;
  baselineCreatedAt: Date;
}): Promise<bigint> {
  const rows = await db
    .select({
      direction: operatorManualMovements.direction,
      amountStroops: operatorManualMovements.amountStroops,
    })
    .from(operatorManualMovements)
    .where(
      and(
        eq(operatorManualMovements.account, args.account),
        eq(operatorManualMovements.asset, args.asset),
        isNull(operatorManualMovements.movementPaymentId),
        sql`${operatorManualMovements.effectiveAt} >= ${args.baselineCreatedAt}`,
      ),
    );
  return rows.reduce(
    (sum, row) => sum + (row.direction === 'in' ? row.amountStroops : -row.amountStroops),
    0n,
  );
}

async function currentBalance(args: {
  account: string;
  asset: OperatorFloatAsset;
  usdcIssuer: string | null;
}): Promise<bigint> {
  const snapshot = await getAccountBalances(args.account, args.usdcIssuer);
  const value = args.asset === 'xlm' ? snapshot.xlmStroops : snapshot.usdcStroops;
  return value ?? 0n;
}

export async function runOperatorFloatReconciliationForAsset(args: {
  account: string;
  asset: OperatorFloatAsset;
  usdcIssuer: string | null;
  thresholdStroops: bigint;
  maxPages?: number;
}): Promise<OperatorFloatRunSummary> {
  const baseline = await loadActiveBaseline({ account: args.account, asset: args.asset });
  if (baseline === null) {
    return await recordNeedsBaseline({
      account: args.account,
      asset: args.asset,
      thresholdStroops: args.thresholdStroops,
    });
  }

  try {
    const cursor = baseline.currentHorizonCursor ?? baseline.startingHorizonCursor;
    await indexNewMovements({
      account: args.account,
      asset: args.asset,
      usdcIssuer: args.usdcIssuer,
      baselineId: baseline.id,
      cursor,
      maxPages: args.maxPages ?? 5,
    });
    const movementTotals = await computeMovementTotals({
      account: args.account,
      asset: args.asset,
      baselineCreatedAt: baseline.createdAt,
    });
    const manualDelta = await computeUnlinkedManualDelta({
      account: args.account,
      asset: args.asset,
      baselineCreatedAt: baseline.createdAt,
    });
    const expected = computeExpectedBalance({
      openingBalanceStroops: baseline.openingBalanceStroops,
      classifiedMovementDeltaStroops: movementTotals.classifiedMovementDeltaStroops,
      unlinkedManualDeltaStroops: manualDelta,
    });
    const actual = await currentBalance({
      account: args.account,
      asset: args.asset,
      usdcIssuer: args.usdcIssuer,
    });
    const delta = actual - expected;
    const state = classifyRun({
      deltaStroops: delta,
      thresholdStroops: args.thresholdStroops,
      unclassifiedCount: movementTotals.unclassifiedCount,
    });
    const summary: OperatorFloatRunSummary = {
      asset: args.asset,
      account: args.account,
      baselineId: baseline.id,
      expectedBalanceStroops: expected,
      actualBalanceStroops: actual,
      deltaStroops: delta,
      thresholdStroops: args.thresholdStroops,
      unclassifiedCount: movementTotals.unclassifiedCount,
      indexedMovementCount: movementTotals.indexedMovementCount,
      state,
      error: null,
    };
    await persistRun(summary);
    if (state === 'drift' || state === 'unclassified') notifyOperatorFloatDrift(summary);
    return summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const summary: OperatorFloatRunSummary = {
      asset: args.asset,
      account: args.account,
      baselineId: baseline.id,
      expectedBalanceStroops: null,
      actualBalanceStroops: null,
      deltaStroops: null,
      thresholdStroops: args.thresholdStroops,
      unclassifiedCount: 0,
      indexedMovementCount: 0,
      state: 'error',
      error: message.slice(0, 500),
    };
    await persistRun(summary);
    notifyOperatorFloatDrift(summary);
    return summary;
  }
}

export async function runOperatorFloatReconciliationTick(args?: {
  account?: string;
  usdcIssuer?: string | null;
  maxPages?: number;
}): Promise<{ skippedLocked: boolean; runs: OperatorFloatRunSummary[] }> {
  const account = args?.account ?? env.LOOP_STELLAR_DEPOSIT_ADDRESS;
  if (account === undefined) {
    return { skippedLocked: false, runs: [] };
  }
  const locked = await withAdvisoryLock(lockKey(), async () => {
    const usdcIssuer = args?.usdcIssuer ?? env.LOOP_STELLAR_USDC_ISSUER ?? null;
    const runs: OperatorFloatRunSummary[] = [];
    for (const asset of ['xlm', 'usdc'] as const) {
      const perAssetArgs = {
        account,
        asset,
        usdcIssuer,
        thresholdStroops: thresholdForAsset(asset),
        ...(args?.maxPages !== undefined ? { maxPages: args.maxPages } : {}),
      };
      runs.push(await runOperatorFloatReconciliationForAsset(perAssetArgs));
    }
    return runs;
  });
  if (!locked.ran) return { skippedLocked: true, runs: [] };
  return { skippedLocked: false, runs: locked.value };
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startOperatorFloatReconciliationWatcher(args?: { intervalMs?: number }): void {
  if (timer !== null) return;
  const intervalMs =
    args?.intervalMs ?? env.LOOP_OPERATOR_FLOAT_RECONCILIATION_INTERVAL_HOURS * 60 * 60 * 1000;
  markWorkerStarted('operator_float_reconciliation', {
    staleAfterMs: Math.max(intervalMs * 3, 60_000),
  });
  const tick = async (): Promise<void> => {
    try {
      const r = await runOperatorFloatReconciliationTick();
      if (!r.skippedLocked) markWorkerTickSuccess('operator_float_reconciliation');
    } catch (err) {
      markWorkerTickFailure('operator_float_reconciliation', err);
      log.error({ err }, 'Operator-float reconciliation tick failed');
    }
  };
  void tick();
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
}

export function stopOperatorFloatReconciliationWatcher(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
  markWorkerStopped('operator_float_reconciliation');
}
