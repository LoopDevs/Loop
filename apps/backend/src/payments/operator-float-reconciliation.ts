/**
 * R3-1 operator wallet conservation check.
 *
 * This reconciles the real XLM/USDC operator/deposit wallet over
 * time. It deliberately fails closed without an operator-created
 * baseline: a current Horizon balance alone is not evidence that user
 * deposits, CTX settlements, refunds, fees, top-ups and sweeps
 * conserved correctly.
 *
 * KNOWN UNMODELED TERMS (money review 2026-07-08) — the expected-
 * balance model counts only Horizon `payment` operations, so these
 * real balance movers are invisible to it and accrue as slow negative
 * XLM delta until a re-baseline:
 *   - transaction FEES on every tx the operator account submits (CTX
 *     settlements, deposit refunds, payouts) — ~100-200 stroops each.
 *     The 1-XLM default `LOOP_OPERATOR_FLOAT_XLM_THRESHOLD_STROOPS`
 *     absorbs ~50k such fees; USDC pays no fee so its threshold stays
 *     exact.
 *   - `create_account` funding (Phase-2 wallet provisioning — gated
 *     off in Phase 1), `account_merge`, path payments, claimable
 *     balances. None are used on this account in Phase 1.
 * OPERATOR POLICY: when the XLM delta approaches the threshold from
 * accumulated fees, create a fresh baseline (balance + cursor snapshot
 * via the audited admin write) rather than raising the threshold —
 * threshold inflation is exactly how a real leak hides.
 *
 * ALERT SEMANTICS: like the ledger-invariant watcher, this pages the
 * monitoring channel on EVERY bad-state run (daily cadence) — that is
 * the at-least-once reminder, not an oversight. A drift result is
 * recomputed once (re-index + re-read) before it is persisted or
 * paged, so a deposit landing between the movement indexing and the
 * balance read does not produce a one-run false page. `needs_baseline`
 * pages too (production readiness pass, 2026-07-10): a deployed watcher
 * with no baseline configured yet is not a healthy "nothing to report"
 * state — it is R3-1 silently doing nothing, and the operator must be
 * prompted to run the baseline setup in `docs/runbooks/operator-float-drift.md`
 * rather than mistaking silence for a passing check.
 *
 * COLD-START CURSOR SAFETY: with NO active baseline, no Horizon read
 * happens at all (`needs_baseline`, below) — the watcher never scans
 * history until an operator anchors it. Once a baseline exists, its
 * `starting_horizon_cursor` / `current_horizon_cursor` are DB-enforced
 * NOT NULL + non-empty (migration 0057) specifically so the indexer's
 * Horizon `cursor` query param is never omitted — an omitted cursor
 * walks the account's ENTIRE payment history from genesis instead of
 * the baseline's chosen anchor, corrupting the very check this module
 * exists to run. Baselines are created via the audited, step-up-gated
 * `POST /api/admin/operator-float/baselines` (operator runbook:
 * `docs/runbooks/operator-float-drift.md` §Setting the baseline).
 *
 * THRESHOLDS: `LOOP_OPERATOR_FLOAT_XLM_THRESHOLD_STROOPS` /
 * `LOOP_OPERATOR_FLOAT_USDC_THRESHOLD_STROOPS` (env.ts) are the only
 * per-asset knobs; both are `parseEnv`-validated non-negative bigints
 * with production-safe defaults (see `thresholdForAsset` below and the
 * KNOWN UNMODELED TERMS note for why XLM's default is wider). A
 * non-numeric or negative override fails boot, not a silent fallback.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
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
import { setMoneyIntegrityBreach } from '../metrics.js';
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
    // P2-g (2026-07-10): fail-closed, mirroring `isMatchingIncomingPayment`
    // (./horizon.ts, AUDIT-2 finding A) and `getAccountBalances`
    // (./horizon-balances.ts, P2-a). The previous clause here was
    // `args.usdcIssuer === null || p.asset_issuer === args.usdcIssuer`,
    // vacuously true when no issuer is configured — an unconfigured
    // LOOP_STELLAR_USDC_ISSUER classified ANY code-"USDC" payment
    // (including an attacker's worthless self-issued asset) as a real
    // USDC movement in the float-reconciliation ledger. No issuer
    // configured now means NO match, never "any issuer" — the payment
    // simply isn't extracted (falls through to `return null` below),
    // same as any other unrecognized asset. This module makes no
    // balance-adjusting writes (classification/audit-trail metadata
    // only — see the file header), so excluding the movement here only
    // affects what `operator_wallet_movements` records and what
    // `expectedBalanceStroops` sums, not any ledger/mirror value.
    args.usdcIssuer !== null &&
    p.asset_issuer === args.usdcIssuer
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

/**
 * The classifier only needs the movement's identity + direction, so it
 * accepts the narrow shape — lets the reclassify sweep feed persisted
 * rows straight back through without fabricating a full extraction.
 */
export type ClassifiableMovement = Pick<
  ExtractedOperatorMovement,
  'paymentId' | 'txHash' | 'direction'
>;

export async function classifyMovement(
  movement: ClassifiableMovement,
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
      // A cursor replay must only ever UPGRADE an unclassified row —
      // an existing attribution (manual link, user_deposit, …) is
      // final and a stale re-classify computed before that attribution
      // committed must not transiently clobber it.
      setWhere: sql`${operatorWalletMovements.classification} = 'unclassified'`,
    });
}

/**
 * Re-run classification over rows stuck `unclassified` (money review
 * 2026-07-08, F3/F4). Classification used to be compute-once at index
 * time, so a deposit indexed BEFORE the payment watcher stamped
 * `orders.payment_received_horizon_id` (watcher lag), or a manual
 * explanation that raced the indexer, froze `unclassified` forever —
 * masking the ok/drift signal and paging every run until an operator
 * misrecorded a genuine deposit as `manual`. Each tick this heals any
 * row whose linkage has since appeared. The UPDATE is guarded on
 * `classification = 'unclassified'` so it can never clobber a
 * concurrent manual-movement link.
 */
export async function reclassifyUnclassifiedMovements(args: {
  account: string;
  asset: OperatorFloatAsset;
  limit?: number;
}): Promise<number> {
  const rows = await db
    .select({
      paymentId: operatorWalletMovements.paymentId,
      txHash: operatorWalletMovements.txHash,
      direction: operatorWalletMovements.direction,
    })
    .from(operatorWalletMovements)
    .where(
      and(
        eq(operatorWalletMovements.account, args.account),
        eq(operatorWalletMovements.asset, args.asset),
        eq(operatorWalletMovements.classification, 'unclassified'),
      ),
    )
    .orderBy(operatorWalletMovements.observedAt)
    .limit(args.limit ?? 500);

  let healed = 0;
  for (const row of rows) {
    const classification = await classifyMovement(row);
    if (classification.classification === 'unclassified') continue;
    await db
      .update(operatorWalletMovements)
      .set({
        classification: classification.classification,
        orderId: classification.orderId,
        refundPaymentId: classification.refundPaymentId,
        settlementId: classification.settlementId,
        manualMovementId: classification.manualMovementId,
        updatedAt: sql`NOW()`,
      })
      .where(
        and(
          eq(operatorWalletMovements.paymentId, row.paymentId),
          eq(operatorWalletMovements.classification, 'unclassified'),
        ),
      );
    healed++;
  }
  if (healed > 0) {
    log.info({ account: args.account, asset: args.asset, healed }, 'Reclassified stuck movements');
  }
  return healed;
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
  // Production readiness (2026-07-10): `needs_baseline` used to persist
  // quietly — a deployed, LOOP_WORKERS_ENABLED watcher with no baseline
  // configured yet ran forever without ever prompting an operator to
  // set one up, so "no Discord page" could be misread as "R3-1 is
  // healthy" when it was actually never checking anything. Page it
  // the same at-least-once way as drift/unclassified (see the module
  // docstring's ALERT SEMANTICS).
  notifyOperatorFloatDrift(summary);
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

// Exported for the DB-backed MNY-04 regression test (integration
// suite) — the cursor-vs-observed_at attribution is the exact SQL the
// finding is about, so the test drives this query directly against
// real postgres with movements whose observed_at diverges from their
// paging_token order.
export async function computeMovementTotals(args: {
  account: string;
  asset: OperatorFloatAsset;
  startingCursor: string;
}): Promise<{
  classifiedMovementDeltaStroops: bigint;
  unclassifiedCount: number;
  indexedMovementCount: number;
}> {
  // MNY-04: attribute movements to this baseline's period by the
  // CANONICAL on-chain cursor (`paging_token`, the Horizon TOID the
  // indexer already persists), NOT by wall-clock `observed_at`.
  // `observed_at` is when the indexer SAW the row, not its ledger
  // ordering — under indexer lag or a cursor replay/re-baseline a
  // movement can be observed out of order and land in the wrong
  // reconciliation window (a pre-baseline flow already folded into the
  // opening balance gets double-counted; a post-baseline flow observed
  // early gets dropped), so the reconciled float for the period is off.
  // The baseline's `starting_horizon_cursor` is snapshotted from the
  // SAME Horizon moment as `opening_balance_stroops`, so the period is
  // exactly the movements strictly after that anchor. Horizon
  // paging_tokens are TOIDs (decimal strings, monotonic but NOT
  // lexically ordered across differing lengths) — compare as `numeric`.
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
      AND paging_token::numeric > ${args.startingCursor}::numeric
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

// Exported for the DB-backed regression test (integration suite) —
// the `effective_at >= baselineCreatedAt` bound is the exact query the
// OPFLOAT-DATEFRAG finding is about, so the test drives it directly
// against real postgres with an active baseline present.
export async function computeUnlinkedManualDelta(args: {
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
        // A2-1610: must use the typed `gte()` operator, not a raw sql
        // template with the `Date` interpolated — postgres-js can't
        // bind a `Date` instance at the wire level ("The \"string\"
        // argument must be of type string ... Received an instance of
        // Date"), so the raw fragment threw and errored the whole
        // reconciliation the moment an active baseline existed.
        // `gte()` lets drizzle's column mapper convert the Date through
        // the timestamptz column's mode. Same boundary, same column.
        gte(operatorManualMovements.effectiveAt, args.baselineCreatedAt),
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

/** The active baseline was replaced by an operator write mid-run. */
class BaselineChangedMidRunError extends Error {
  constructor() {
    super('active operator-float baseline changed mid-run');
    this.name = 'BaselineChangedMidRunError';
  }
}

export async function runOperatorFloatReconciliationForAsset(
  args: {
    account: string;
    asset: OperatorFloatAsset;
    usdcIssuer: string | null;
    thresholdStroops: bigint;
    maxPages?: number;
  },
  attempt = 0,
): Promise<OperatorFloatRunSummary> {
  const baseline = await loadActiveBaseline({ account: args.account, asset: args.asset });
  if (baseline === null) {
    return await recordNeedsBaseline({
      account: args.account,
      asset: args.asset,
      thresholdStroops: args.thresholdStroops,
    });
  }

  try {
    const computePass = async (): Promise<OperatorFloatRunSummary> => {
      // Re-load the cursor each pass — the first pass advances it on
      // the baseline row. Pin the baseline IDENTITY: if an operator
      // re-baselined mid-run, mixing the old opening balance with the
      // new row's cursor would produce a garbage run record, so start
      // the whole per-asset run over against the new baseline instead.
      const fresh = await loadActiveBaseline({ account: args.account, asset: args.asset });
      if (fresh === null || fresh.id !== baseline.id) {
        throw new BaselineChangedMidRunError();
      }
      // Both columns are DB-enforced NOT NULL + non-empty (migration
      // 0057) — this `??` is belt-and-suspenders, not load-bearing;
      // `indexNewMovements` never receives a null/undefined cursor for
      // an active baseline, so it can never omit Horizon's `cursor`
      // param and fall back to a full-history genesis scan.
      const cursor = fresh.currentHorizonCursor ?? fresh.startingHorizonCursor;
      await indexNewMovements({
        account: args.account,
        asset: args.asset,
        usdcIssuer: args.usdcIssuer,
        baselineId: baseline.id,
        cursor,
        maxPages: args.maxPages ?? 5,
      });
      // F3/F4: heal rows that indexed before their linkage existed
      // (watcher lag, manual-explanation race) before summing.
      await reclassifyUnclassifiedMovements({ account: args.account, asset: args.asset });
      const movementTotals = await computeMovementTotals({
        account: args.account,
        asset: args.asset,
        // MNY-04: canonical cursor anchor, not `baseline.createdAt`
        // wall-clock — see computeMovementTotals.
        startingCursor: baseline.startingHorizonCursor,
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
      return {
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
    };

    let summary = await computePass();
    if (summary.state === 'drift') {
      // A deposit landing between the movement indexing and the balance
      // read shows up in `actual` but not yet in `expected`. Re-index +
      // recompute once before persisting or paging so that window can't
      // produce a one-run false drift page (money review 2026-07-08).
      summary = await computePass();
    }
    await persistRun(summary);
    if (summary.state === 'drift' || summary.state === 'unclassified') {
      notifyOperatorFloatDrift(summary);
    }
    return summary;
  } catch (err) {
    if (err instanceof BaselineChangedMidRunError && attempt === 0) {
      // One clean restart against the new active baseline; a second
      // change inside a single tick falls through to the error record.
      return await runOperatorFloatReconciliationForAsset(args, 1);
    }
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
      // A lost advisory lock is a HEALTHY tick — another machine owns
      // the sweep this round. Marking it success keeps the losing
      // machine's worker-staleness monitor quiet on a 2-machine fleet.
      const r = await runOperatorFloatReconciliationTick();
      // NS-02 / FT-07: a tick that actually reconciled (won the lock and
      // produced per-asset runs) records the STANDING breach state on
      // the money-integrity gauge — markWorkerTickSuccess proves only
      // that the tick ran. Any non-`ok` run (drift / unclassified /
      // needs_baseline / error — the same states that page Discord) is
      // a standing R3-1 breach that must be visible on /metrics even
      // after its at-least-once page has fired. A lock-skip or an
      // unconfigured account (runs === []) leaves the last value as-is.
      if (!r.skippedLocked && r.runs.length > 0) {
        setMoneyIntegrityBreach(
          'operator_float',
          r.runs.some((run) => run.state !== 'ok'),
        );
      }
      markWorkerTickSuccess('operator_float_reconciliation');
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
