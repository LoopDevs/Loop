/**
 * Real-postgres regression test for MNY-04: operator-float
 * reconciliation must attribute movements to a baseline period by the
 * canonical on-chain cursor (`paging_token`, the Horizon TOID the
 * indexer already persists), NOT by wall-clock `observed_at`.
 *
 * WHY THIS EXISTS: `computeMovementTotals` used to bound a baseline's
 * period with `observed_at >= baseline.created_at`. `observed_at` is
 * when the INDEXER saw a row, not its ledger ordering — so under
 * indexer lag or a cursor replay / re-baseline a movement can be
 * observed out of order relative to its paging_token and land in the
 * WRONG window:
 *
 *   - a PRE-baseline movement (already folded into the opening
 *     balance) that the lagging indexer only observed AFTER the
 *     baseline was created gets DOUBLE-COUNTED into the period, and
 *   - a POST-baseline movement observed early (replay / clock skew)
 *     gets DROPPED from the period,
 *
 * either of which makes the reconciled float for the period wrong — a
 * false drift page, or (worse) a real leak masked. The fix attributes
 * each movement by `paging_token::numeric > starting_horizon_cursor::
 * numeric` — the same canonical cursor the indexer persists and the
 * opening balance is snapshotted against.
 *
 * This drives `computeMovementTotals` (the exact query the finding is
 * about) directly against real postgres, seeding movements whose
 * `observed_at` order DIVERGES from their `paging_token` order.
 *
 * PROVEN RED against the observed_at-based attribution: replacing the
 * predicate with the original
 *     observed_at >= (SELECT created_at FROM operator_wallet_baselines
 *                     WHERE account = $acct AND asset = $asset
 *                       AND active = 1 LIMIT 1)
 * makes test 1 read `classifiedMovementDeltaStroops = +2_000_000`
 * (the pre-baseline deposit, wrongly counted) instead of `-3_000_000`,
 * and makes test 2 read `unclassifiedCount = 0` instead of `1`.
 *
 * Runs under `vitest.integration.config.ts` (LOOP_E2E_DB=1 + a real
 * postgres) — the same lane as the migration-0057 sibling.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

import { db } from '../../db/client.js';
import { computeMovementTotals } from '../../payments/operator-float-reconciliation.js';
import { ensureMigrated } from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

// A syntactically-plausible 56-char G-address (a text-column fixture,
// never SDK-validated here).
const ACCT = `G${'X'.repeat(55)}`.slice(0, 56);

// The baseline's canonical anchor: movements with paging_token
// numerically greater than this are IN the period; anything <= it is
// already reflected in the opening balance. A Horizon-TOID-shaped
// decimal string — the fix casts to numeric so it orders correctly for
// real, differing-length TOIDs (which pure lexical text ordering would
// get wrong).
const ANCHOR_CURSOR = '5000';
const OPENING_BALANCE = 10_000_000n;

async function clearOperatorTables(): Promise<void> {
  await db.execute(
    sql.raw(
      `TRUNCATE operator_wallet_baselines, operator_wallet_movements,
        operator_manual_movements, operator_float_reconciliation_runs
        RESTART IDENTITY CASCADE`,
    ),
  );
}

// Seeds the active baseline. `created_at` defaults to NOW() — the
// movements' observed_at straddle that instant, which is what the
// (buggy) wall-clock attribution keyed off and this test proves the
// fix ignores in favour of the cursor.
async function seedActiveBaseline(): Promise<void> {
  await db.execute(sql`
    INSERT INTO operator_wallet_baselines
      (asset, account, opening_balance_stroops, starting_horizon_cursor,
       current_horizon_cursor, active, reason, created_by)
    VALUES ('xlm', ${ACCT}, ${OPENING_BALANCE}, ${ANCHOR_CURSOR}, ${ANCHOR_CURSOR},
            1, 'cursor-attribution regression baseline', 'ops')
  `);
}

/**
 * Inserts an operator_wallet_movement with an explicit paging_token
 * (canonical on-chain order) and observed_at OFFSET from NOW() (indexer
 * wall-clock). `observedOffset` is a postgres interval literal added to
 * NOW(): a negative interval simulates a row the indexer saw BEFORE the
 * baseline was created; a positive one simulates a row seen AFTER it
 * (lag / replay). No bind-Date params — the offset is a text interval.
 */
async function seedMovement(args: {
  paymentId: string;
  pagingToken: string;
  direction: 'in' | 'out';
  amountStroops: bigint;
  classification: 'user_deposit' | 'ctx_settlement' | 'unclassified';
  observedOffset: string;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO operator_wallet_movements
      (payment_id, tx_hash, paging_token, account, asset, asset_code,
       direction, amount_stroops, classification, raw_payment, observed_at)
    VALUES (
      ${args.paymentId}, ${`tx-${args.paymentId}`}, ${args.pagingToken}, ${ACCT},
      'xlm', 'XLM', ${args.direction}, ${args.amountStroops}, ${args.classification},
      '{}'::jsonb, NOW() + ${args.observedOffset}::interval
    )
  `);
}

describeIf(
  'operator-float reconciliation — cursor (not observed_at) period attribution [MNY-04]',
  () => {
    beforeAll(async () => {
      await ensureMigrated();
    });

    beforeEach(async () => {
      await clearOperatorTables();
    });

    it('sums the CLASSIFIED delta by paging_token: a pre-baseline row observed late is excluded; a post-baseline row observed early is included', async () => {
      await seedActiveBaseline();

      // PRE-baseline on-chain (paging_token 4000 <= anchor 5000): already
      // in the opening balance → MUST be excluded. But the indexer only
      // observed it 1h AFTER the baseline was created (lag), so the
      // wall-clock filter `observed_at >= created_at` WRONGLY includes it.
      await seedMovement({
        paymentId: 'op-pre',
        pagingToken: '4000',
        direction: 'in',
        amountStroops: 2_000_000n,
        classification: 'user_deposit',
        observedOffset: '1 hour',
      });
      // POST-baseline on-chain (paging_token 6000 > anchor 5000): a real
      // movement in this period → MUST be included. But it was observed a
      // day BEFORE the baseline's created_at (replay / skew), so the
      // wall-clock filter WRONGLY drops it.
      await seedMovement({
        paymentId: 'op-post',
        pagingToken: '6000',
        direction: 'out',
        amountStroops: 3_000_000n,
        classification: 'ctx_settlement',
        observedOffset: '-1 day',
      });

      const totals = await computeMovementTotals({
        account: ACCT,
        asset: 'xlm',
        startingCursor: ANCHOR_CURSOR,
      });

      // Canonical-cursor attribution: op-pre (4000) excluded, op-post
      // (6000) included → only the -3_000_000 outbound settlement counts.
      // (The observed_at version yields +2_000_000 — op-pre only — which
      // is the red this assertion catches.)
      expect(totals.classifiedMovementDeltaStroops).toBe(-3_000_000n);
      // Exactly one movement is IN the period the reconciliation counts.
      expect(totals.indexedMovementCount).toBe(1);
      expect(totals.unclassifiedCount).toBe(0);

      // And the resulting expected balance the reconciler would report:
      // opening (10_000_000) + classified delta (-3_000_000) = 7_000_000.
      // The observed_at version would report 12_000_000.
      expect(OPENING_BALANCE + totals.classifiedMovementDeltaStroops).toBe(7_000_000n);
    });

    it('counts UNCLASSIFIED movements by paging_token: a post-baseline unclassified row observed early is still in the period', async () => {
      await seedActiveBaseline();

      // POST-baseline (paging_token 6000 > anchor 5000) but observed a day
      // BEFORE the baseline. It is genuinely unexplained flow inside this
      // period and must hold the run in `unclassified` (the state that
      // pages ops). The wall-clock filter (`observed_at >= created_at`)
      // drops it — unclassifiedCount 0 — and the run falsely reads `ok`,
      // masking an unreconciled movement. The cursor keeps it.
      await seedMovement({
        paymentId: 'op-unclass',
        pagingToken: '6000',
        direction: 'in',
        amountStroops: 500_000n,
        classification: 'unclassified',
        observedOffset: '-1 day',
      });

      const totals = await computeMovementTotals({
        account: ACCT,
        asset: 'xlm',
        startingCursor: ANCHOR_CURSOR,
      });

      // Cursor attribution keeps the post-baseline row in the period.
      // (The observed_at version drops it → unclassifiedCount 0,
      // indexedMovementCount 0 — the red these assertions catch.)
      expect(totals.unclassifiedCount).toBe(1);
      expect(totals.indexedMovementCount).toBe(1);
      // Unclassified rows are excluded from the classified SUM either way.
      expect(totals.classifiedMovementDeltaStroops).toBe(0n);
    });
  },
);
