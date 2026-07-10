/**
 * Drizzle schema — reconciliation domain (hardening D2 split).
 * Re-exported through `../schema.ts` (the barrel), so every existing
 * `import { ... } from '../db/schema.js'` call site is unchanged.
 */
import {
  pgTable,
  uuid,
  text,
  bigint,
  boolean,
  timestamp,
  integer,
  index,
  check,
  primaryKey,
  uniqueIndex,
  doublePrecision,
  jsonb,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { orders } from './orders.js';
import { users } from './users.js';
import { paymentWatcherSkips } from './payments.js';

/**
 * Persisted per-asset state of the asset-drift watcher (hardening
 * A2/A3, 2026-07 plan; ADR 015 / 036).
 *
 * The watcher previously kept its ok/over transition state in
 * process memory — lost on every restart and duplicated per Fly
 * machine, so the primary unbacked-mint backstop re-paged after
 * every deploy and each machine paged independently. One row per
 * configured LOOP asset persists:
 *
 *   - `state` — the drift dimension (|drift| vs threshold).
 *   - `failed_rows_state` — the failed money-movement dimension:
 *     `kind IN ('burn','interest_mint')` rows in `state='failed'`
 *     are counted into the drift equation (the tokens / mirror
 *     credits genuinely exist), which makes the equation itself
 *     blind to them; this column keeps that masked term visible
 *     and transition-paged until an operator retries the rows.
 *
 * Transition claims are serialised through `SELECT ... FOR UPDATE`
 * on this row (`payments/asset-drift-state-repo.ts`), so exactly
 * one machine in the fleet wins each ok↔over / none↔present flip
 * and sends the Discord page.
 *
 * Page delivery is AT-LEAST-ONCE, not fire-and-forget: the
 * `last_paged_*` columns record what ops has actually been paged
 * about (written only after a successful Discord send), and
 * `page_attempt_at` is a short lease claimed by whichever machine
 * is attempting the send. A page lost to a Discord outage or a
 * SIGTERM between the state commit and the send is re-attempted on
 * later ticks — the state columns say what IS, the paged columns
 * say what ops KNOWS, and the watcher pages whenever they diverge.
 *
 * `state` deliberately has no 'unknown' member — absence of the row
 * IS the unknown state (pre-first-successful-read).
 */
export const assetDriftState = pgTable(
  'asset_drift_state',
  {
    /** LOOP asset code — one watcher row per configured asset. */
    assetCode: text('asset_code').primaryKey(),
    state: text('state').$type<'ok' | 'over'>().notNull(),
    failedRowsState: text('failed_rows_state').$type<'none' | 'present'>().notNull(),
    lastDriftStroops: bigint('last_drift_stroops', { mode: 'bigint' }).notNull(),
    lastThresholdStroops: bigint('last_threshold_stroops', { mode: 'bigint' }).notNull(),
    failedBurnStroops: bigint('failed_burn_stroops', { mode: 'bigint' }).notNull(),
    failedInterestMintStroops: bigint('failed_interest_mint_stroops', {
      mode: 'bigint',
    }).notNull(),
    /**
     * Drift state ops has successfully been paged about. NULL =
     * never paged (an asset that has only ever been 'ok' needs no
     * page). Written only after `sendWebhook` reports delivery.
     */
    lastPagedState: text('last_paged_state').$type<'ok' | 'over'>(),
    /** Failed-rows state ops has successfully been paged about. */
    lastPagedFailedRowsState: text('last_paged_failed_rows_state').$type<'none' | 'present'>(),
    /**
     * Send-attempt lease: set when a machine claims the due pages
     * for this asset, cleared on delivery/explicit release. A fresh
     * lease stops a concurrently-ticking machine from double-paging;
     * an expired lease (crashed sender) lets any machine re-attempt.
     */
    pageAttemptAt: timestamp('page_attempt_at', { withTimezone: true }),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('asset_drift_state_state_known', sql`${t.state} IN ('ok', 'over')`),
    check('asset_drift_state_failed_rows_known', sql`${t.failedRowsState} IN ('none', 'present')`),
    check(
      'asset_drift_state_paged_state_known',
      sql`${t.lastPagedState} IS NULL OR ${t.lastPagedState} IN ('ok', 'over')`,
    ),
    check(
      'asset_drift_state_paged_failed_rows_known',
      sql`${t.lastPagedFailedRowsState} IS NULL OR ${t.lastPagedFailedRowsState} IN ('none', 'present')`,
    ),
    // The failed sums are magnitudes, never negative — a negative
    // write is an aggregation bug, fail at the DB layer.
    check(
      'asset_drift_state_failed_sums_non_negative',
      sql`${t.failedBurnStroops} >= 0 AND ${t.failedInterestMintStroops} >= 0`,
    ),
  ],
);

/**
 * Persistence for the interest-pool low-cover watcher's per-asset
 * alert state (hardening C10a; ADR 031). Same shape/rationale as
 * `asset_drift_state` (A3): the low↔ok transition dedup lived in a
 * process-memory Set inside the notifiers — lost on restart, and
 * (worse) per-machine, so the machine that computed "recovered" was
 * usually NOT the one that had paged "low", and its empty Set silently
 * dropped the recovery close. This makes the state durable + fleet-
 * consistent, and page delivery at-least-once (last_paged_state moves
 * only after the webhook confirms).
 */
export const interestPoolAlertState = pgTable(
  'interest_pool_alert_state',
  {
    /** LOOP asset code — one row per configured asset. */
    assetCode: text('asset_code').primaryKey(),
    /** Cover state as of the last tick. */
    state: text('state').$type<'ok' | 'low'>().notNull(),
    /**
     * Cover state ops has successfully been paged about. NULL = never
     * paged. Written only after `sendWebhook` reports delivery, so a
     * send lost to a Discord outage / SIGTERM stays due.
     */
    lastPagedState: text('last_paged_state').$type<'ok' | 'low'>(),
    /** Last computed days-of-cover, for the admin surface / debugging. */
    lastDaysOfCover: doublePrecision('last_days_of_cover').notNull(),
    lastPoolStroops: bigint('last_pool_stroops', { mode: 'bigint' }).notNull(),
    /** Send-attempt lease — see `asset_drift_state.page_attempt_at`. */
    pageAttemptAt: timestamp('page_attempt_at', { withTimezone: true }),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('interest_pool_alert_state_state_known', sql`${t.state} IN ('ok', 'low')`),
    check(
      'interest_pool_alert_state_paged_state_known',
      sql`${t.lastPagedState} IS NULL OR ${t.lastPagedState} IN ('ok', 'low')`,
    ),
  ],
);

/**
 * Persistence for the fire-once watchdog alerts (S4-8 follow-up,
 * money-review 2026-07-09; same ADR-038 D2 at-least-once shape as
 * `interest_pool_alert_state`, minus the per-asset dimension).
 *
 * The cursor-age watchdog (`payments/cursor-watchdog.ts`) and the
 * stuck-payout watchdog (`payments/stuck-payout-watchdog.ts`) each
 * page Discord once per incident and re-arm when the condition
 * clears. That fired-state previously lived in a per-process boolean
 * — with the S4-8 advisory-lock single-flight, a machine whose
 * boolean latched `true` during incident 1 (and which never held the
 * lock during the recovery window) could win the lock during a
 * FUTURE, distinct incident and silently skip paging: worst case
 * zero pages for a live money incident. One row per watchdog makes
 * the fired-state durable + fleet-consistent:
 *
 *   - `alert_active` is set `true` only AFTER `sendWebhook` confirms
 *     delivery, so a failed send stays unfired and the next tick
 *     (any machine) retries — at-least-once, never silently lost.
 *   - A healthy tick resets it to `false` (re-arm), so the next
 *     distinct incident pages fresh regardless of which machine wins
 *     the lock.
 *
 * Reads/writes happen only under each watchdog's fleet-wide
 * transaction-scoped advisory lock, so no row lock (`FOR UPDATE`) is
 * needed — the advisory lock already serialises the read→send→write
 * sequence.
 */
export const watchdogAlertState = pgTable('watchdog_alert_state', {
  /** Stable watchdog identifier, e.g. 'cursor-watchdog'. */
  watchdogName: text('watchdog_name').primaryKey(),
  /** True while ops has been (confirmed-delivery) paged about an open incident. */
  alertActive: boolean('alert_active').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Durable record of operator→CTX settlement payments (hardening A4,
 * 2026-07 plan; ADR 010 principal switch).
 *
 * `payCtxOrder` forwards user-paid value to CTX from the operator
 * wallet — real money leaving Loop's custody — yet no table recorded
 * that it happened: idempotency rested entirely on a bounded Horizon
 * memo scan over the shared deposit+operator account, and the only
 * durable evidence Loop ever paid CTX was the chain itself. A prior
 * payment scrolling past the scan window on a busy account meant a
 * retry would double-pay.
 *
 * One row per order (unique). `tx_hash` is persisted BEFORE the
 * network submit (the CF-18 pattern via `onSigned`) so a crash or
 * lost response after the tx lands is recoverable via the
 * authoritative hash lookup — no history-window dependence.
 */
export const ctxSettlements = pgTable(
  'ctx_settlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    /** CTX destination address from the SEP-7 URI, pinned at first attempt. */
    destination: text('destination').notNull(),
    /** Per-order memo CTX matches inbound payments by. */
    memoText: text('memo_text').notNull(),
    /** Native XLM amount in stroops, pinned at first attempt. */
    amountStroops: bigint('amount_stroops', { mode: 'bigint' }).notNull(),
    /** Deterministic hash of the signed tx — set before the network submit. */
    txHash: text('tx_hash'),
    /** Set once an authoritative Horizon lookup confirms the tx landed. */
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ctx_settlements_order_unique').on(t.orderId),
    check('ctx_settlements_amount_positive', sql`${t.amountStroops} > 0`),
  ],
);

export const OPERATOR_FLOAT_ASSETS = ['xlm', 'usdc'] as const;
export type OperatorFloatAsset = (typeof OPERATOR_FLOAT_ASSETS)[number];

export const OPERATOR_FLOAT_DIRECTIONS = ['in', 'out'] as const;
export type OperatorFloatDirection = (typeof OPERATOR_FLOAT_DIRECTIONS)[number];

export const OPERATOR_FLOAT_CLASSIFICATIONS = [
  'user_deposit',
  'ctx_settlement',
  'deposit_refund',
  'manual',
  'unclassified',
] as const;
export type OperatorFloatClassification = (typeof OPERATOR_FLOAT_CLASSIFICATIONS)[number];

export const OPERATOR_FLOAT_RUN_STATES = [
  'ok',
  'drift',
  'unclassified',
  'needs_baseline',
  'error',
] as const;
export type OperatorFloatRunState = (typeof OPERATOR_FLOAT_RUN_STATES)[number];

/**
 * Opening point for the operator/deposit wallet conservation check
 * (R3-1). Ops chooses one active baseline per (account, asset):
 * balance at that point plus indexed, classified Horizon movements
 * should equal the current Horizon balance within the configured
 * threshold. Absence of an active baseline is a fail-closed
 * `needs_baseline` state, not healthy.
 *
 * `starting_horizon_cursor` / `current_horizon_cursor` are NOT NULL
 * (migration 0057, production-readiness pass): the reconciler's
 * indexer omits Horizon's `cursor` query param entirely when a
 * baseline resolves to a null cursor, which walks the account's
 * ENTIRE payment history from genesis instead of starting at the
 * baseline's anchor point — an unbounded cold-start re-scan, and a
 * double-count of everything before the baseline's opening balance.
 * The baseline-create handler (`admin/operator-float.ts`) has
 * required a non-empty `startingHorizonCursor` since the 2026-07-08
 * money review, but that was Zod-only — a "convention" tier check any
 * future non-API writer (a script, a raw-SQL backfill) could bypass.
 * This promotes it to the DB tier, matching the same
 * convention→DB-constraint pattern used throughout the 2026-07
 * hardening pass (see `docs/invariants.md`).
 */
export const operatorWalletBaselines = pgTable(
  'operator_wallet_baselines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    asset: text('asset').notNull().$type<OperatorFloatAsset>(),
    account: text('account').notNull(),
    openingBalanceStroops: bigint('opening_balance_stroops', { mode: 'bigint' }).notNull(),
    startingHorizonCursor: text('starting_horizon_cursor').notNull(),
    currentHorizonCursor: text('current_horizon_cursor').notNull(),
    active: integer('active').notNull().default(1),
    reason: text('reason').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('operator_wallet_baselines_account_asset_active').on(t.account, t.asset, t.active),
    // Migration 0054: at most one ACTIVE baseline per (account, asset)
    // — a concurrent double-create fails loudly instead of leaving two
    // actives for loadActiveBaseline to tiebreak by created_at.
    uniqueIndex('operator_wallet_baselines_one_active')
      .on(t.account, t.asset)
      .where(sql`${t.active} = 1`),
    check('operator_wallet_baselines_asset_known', sql`${t.asset} IN ('xlm', 'usdc')`),
    check('operator_wallet_baselines_opening_non_negative', sql`${t.openingBalanceStroops} >= 0`),
    check('operator_wallet_baselines_active_bool', sql`${t.active} IN (0, 1)`),
    check('operator_wallet_baselines_reason_len', sql`length(${t.reason}) BETWEEN 2 AND 500`),
    check(
      'operator_wallet_baselines_created_by_len',
      sql`length(${t.createdBy}) BETWEEN 1 AND 200`,
    ),
    // Migration 0057: cold-start cursor safety — see the table docstring.
    check(
      'operator_wallet_baselines_starting_cursor_len',
      sql`length(${t.startingHorizonCursor}) >= 1`,
    ),
    check(
      'operator_wallet_baselines_current_cursor_len',
      sql`length(${t.currentHorizonCursor}) >= 1`,
    ),
  ],
);

export const operatorManualMovements = pgTable(
  'operator_manual_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    asset: text('asset').notNull().$type<OperatorFloatAsset>(),
    account: text('account').notNull(),
    direction: text('direction').notNull().$type<OperatorFloatDirection>(),
    amountStroops: bigint('amount_stroops', { mode: 'bigint' }).notNull(),
    /** Optional Horizon operation id this manual explanation classifies. */
    movementPaymentId: text('movement_payment_id'),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull().defaultNow(),
    reason: text('reason').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('operator_manual_movements_account_asset_effective').on(
      t.account,
      t.asset,
      t.effectiveAt,
    ),
    index('operator_manual_movements_payment').on(t.movementPaymentId),
    check('operator_manual_movements_asset_known', sql`${t.asset} IN ('xlm', 'usdc')`),
    check('operator_manual_movements_direction_known', sql`${t.direction} IN ('in', 'out')`),
    check('operator_manual_movements_amount_positive', sql`${t.amountStroops} > 0`),
    check('operator_manual_movements_reason_len', sql`length(${t.reason}) BETWEEN 2 AND 500`),
    check(
      'operator_manual_movements_created_by_len',
      sql`length(${t.createdBy}) BETWEEN 1 AND 200`,
    ),
  ],
);

export const operatorWalletMovements = pgTable(
  'operator_wallet_movements',
  {
    /** Horizon payment operation id. */
    paymentId: text('payment_id').primaryKey(),
    txHash: text('tx_hash').notNull(),
    pagingToken: text('paging_token').notNull(),
    account: text('account').notNull(),
    asset: text('asset').notNull().$type<OperatorFloatAsset>(),
    assetCode: text('asset_code').notNull(),
    assetIssuer: text('asset_issuer'),
    direction: text('direction').notNull().$type<OperatorFloatDirection>(),
    fromAddress: text('from_address'),
    toAddress: text('to_address'),
    memoText: text('memo_text'),
    amountStroops: bigint('amount_stroops', { mode: 'bigint' }).notNull(),
    classification: text('classification')
      .notNull()
      .default('unclassified')
      .$type<OperatorFloatClassification>(),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    // Related payment_watcher_skips row — DUAL meaning by direction:
    // for an OUTBOUND deposit_refund movement it is the skip row whose
    // deposit this refund returns; for an INBOUND user_deposit matched
    // only via a skip row (orphan/late deposit) it is that skip row
    // itself. Read it as "the watcher-skip row that explains this
    // movement", not "the refund's payment id".
    refundPaymentId: text('refund_payment_id').references(() => paymentWatcherSkips.paymentId, {
      onDelete: 'set null',
    }),
    settlementId: uuid('settlement_id').references(() => ctxSettlements.id, {
      onDelete: 'set null',
    }),
    manualMovementId: uuid('manual_movement_id').references(() => operatorManualMovements.id, {
      onDelete: 'set null',
    }),
    rawPayment: jsonb('raw_payment').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('operator_wallet_movements_paging_unique').on(t.pagingToken),
    index('operator_wallet_movements_account_asset_observed').on(t.account, t.asset, t.observedAt),
    index('operator_wallet_movements_classification').on(t.classification, t.observedAt),
    index('operator_wallet_movements_tx_hash').on(t.txHash),
    check('operator_wallet_movements_asset_known', sql`${t.asset} IN ('xlm', 'usdc')`),
    check('operator_wallet_movements_direction_known', sql`${t.direction} IN ('in', 'out')`),
    check('operator_wallet_movements_amount_positive', sql`${t.amountStroops} > 0`),
    check(
      'operator_wallet_movements_classification_known',
      sql`${t.classification} IN ('user_deposit', 'ctx_settlement', 'deposit_refund', 'manual', 'unclassified')`,
    ),
  ],
);

export const operatorFloatReconciliationRuns = pgTable(
  'operator_float_reconciliation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    asset: text('asset').notNull().$type<OperatorFloatAsset>(),
    account: text('account').notNull(),
    baselineId: uuid('baseline_id').references(() => operatorWalletBaselines.id, {
      onDelete: 'set null',
    }),
    expectedBalanceStroops: bigint('expected_balance_stroops', { mode: 'bigint' }),
    actualBalanceStroops: bigint('actual_balance_stroops', { mode: 'bigint' }),
    deltaStroops: bigint('delta_stroops', { mode: 'bigint' }),
    thresholdStroops: bigint('threshold_stroops', { mode: 'bigint' }).notNull(),
    unclassifiedCount: integer('unclassified_count').notNull().default(0),
    indexedMovementCount: integer('indexed_movement_count').notNull().default(0),
    state: text('state').notNull().$type<OperatorFloatRunState>(),
    error: text('error'),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('operator_float_runs_account_asset_checked').on(t.account, t.asset, t.checkedAt),
    check('operator_float_runs_asset_known', sql`${t.asset} IN ('xlm', 'usdc')`),
    check(
      'operator_float_runs_state_known',
      sql`${t.state} IN ('ok', 'drift', 'unclassified', 'needs_baseline', 'error')`,
    ),
    check('operator_float_runs_threshold_non_negative', sql`${t.thresholdStroops} >= 0`),
    check('operator_float_runs_unclassified_non_negative', sql`${t.unclassifiedCount} >= 0`),
  ],
);

export const userFavoriteMerchants = pgTable(
  'user_favorite_merchants',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    merchantId: text('merchant_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.merchantId], name: 'user_favorite_merchants_pkey' }),
    // `.desc().nullsFirst()` mirrors the migration's `created_at DESC`
    // exactly (Postgres DESC defaults to NULLS FIRST; drizzle's bare
    // `.desc()` would emit NULLS LAST). The index serves newest-first
    // favourites pagination; schema.ts ↔ migration parity is enforced
    // by `check:migration-parity`.
    index('user_favorite_merchants_user_created').on(t.userId, t.createdAt.desc().nullsFirst()),
    check('user_favorite_merchants_merchant_id_nonempty', sql`length(${t.merchantId}) >= 1`),
  ],
);
