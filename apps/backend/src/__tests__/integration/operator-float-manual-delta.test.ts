/**
 * Real-postgres regression test for OPFLOAT-DATEFRAG: the unlinked-
 * manual-movement delta the operator-float reconciliation folds into
 * the expected balance is bounded by `effective_at >= baseline.
 * created_at`. That bound used to be a RAW `sql` fragment with the JS
 * `Date` interpolated straight in:
 *     sql`${effectiveAt} >= ${baseline.createdAt}`
 * which postgres-js cannot bind at the wire level — it throws
 *   TypeError: The "string" argument must be of type string ...
 *   Received an instance of Date
 * during the Bind step. So the moment an operator anchored a baseline
 * (making it active), `computeUnlinkedManualDelta` — and therefore the
 * WHOLE `runOperatorFloatReconciliationForAsset` e2e path that calls it
 * with `baselineCreatedAt: baseline.createdAt` — errored out. It was
 * masked only because the module fails closed to `needs_baseline`
 * (never reaching this query) until a baseline exists.
 *
 * The fix uses the typed drizzle `gte(effectiveAt, createdAt)` operator
 * (the file/codebase idiom — A2-1610), which routes the Date through
 * the timestamptz column's mode. Same column, same inclusive boundary.
 *
 * This drives `computeUnlinkedManualDelta` (the exact query the finding
 * is about) directly against real postgres, passing a genuine
 * `baseline.created_at` Date read back from an ACTIVE baseline row —
 * the same value shape the reconciliation passes it.
 *
 * PROVEN RED against the raw-`sql`-Date-fragment version: BOTH tests
 * throw `ERR_INVALID_ARG_TYPE` ("Received an instance of Date") at the
 * Bind step instead of resolving — the throw fires regardless of how
 * many rows match, so even the empty-period test is a faithful red.
 *
 * Runs under `vitest.integration.config.ts` (LOOP_E2E_DB=1 + a real
 * postgres) — the same lane as the MNY-04 cursor-attribution sibling.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

import { db } from '../../db/client.js';
import { operatorManualMovements, operatorWalletBaselines } from '../../db/schema.js';
import { computeUnlinkedManualDelta } from '../../payments/operator-float-reconciliation.js';
import { ensureMigrated } from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

// A syntactically-plausible 56-char G-address (a text-column fixture,
// never SDK-validated here).
const ACCT = `G${'X'.repeat(55)}`.slice(0, 56);
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

// Seeds the active baseline (created_at defaults to NOW()) and reads it
// back so `createdAt` is a real JS Date — exactly what
// `runOperatorFloatReconciliationForAsset` hands to
// `computeUnlinkedManualDelta` as `baselineCreatedAt`.
async function seedAndLoadActiveBaseline(): Promise<Date> {
  await db.execute(sql`
    INSERT INTO operator_wallet_baselines
      (asset, account, opening_balance_stroops, starting_horizon_cursor,
       current_horizon_cursor, active, reason, created_by)
    VALUES ('xlm', ${ACCT}, ${OPENING_BALANCE}, ${ANCHOR_CURSOR}, ${ANCHOR_CURSOR},
            1, 'manual-delta regression baseline', 'ops')
  `);
  const [baseline] = await db
    .select({ createdAt: operatorWalletBaselines.createdAt })
    .from(operatorWalletBaselines)
    .where(and(eq(operatorWalletBaselines.account, ACCT), eq(operatorWalletBaselines.active, 1)))
    .limit(1);
  if (baseline === undefined) throw new Error('baseline was not seeded');
  return baseline.createdAt;
}

// Inserts a manual movement via the drizzle builder (which binds the
// `effectiveAt` Date safely through the column mapper — that is the
// point of the fix). Offsets are relative to the baseline instant.
async function seedManual(args: {
  direction: 'in' | 'out';
  amountStroops: bigint;
  effectiveAt: Date;
  linked: boolean;
}): Promise<void> {
  await db.insert(operatorManualMovements).values({
    asset: 'xlm',
    account: ACCT,
    direction: args.direction,
    amountStroops: args.amountStroops,
    // A LINKED manual movement (movement_payment_id set) is already
    // reflected in the classified-movement delta, so it is excluded
    // from the UNLINKED delta (`movement_payment_id IS NULL`).
    movementPaymentId: args.linked ? `op-${args.amountStroops.toString()}` : null,
    effectiveAt: args.effectiveAt,
    reason: 'manual-delta regression movement',
    createdBy: 'ops',
  });
}

describeIf(
  'operator-float reconciliation — unlinked manual delta with an active baseline [OPFLOAT-DATEFRAG]',
  () => {
    beforeAll(async () => {
      await ensureMigrated();
    });

    beforeEach(async () => {
      await clearOperatorTables();
    });

    it('RETURNS (does not throw) with an active baseline present: an empty period is 0n', async () => {
      const createdAt = await seedAndLoadActiveBaseline();

      // No in-period unlinked manual movements. The raw-Date-fragment
      // version still throws here (the Date param binds regardless of
      // matching rows); the fix resolves to 0n.
      await expect(
        computeUnlinkedManualDelta({ account: ACCT, asset: 'xlm', baselineCreatedAt: createdAt }),
      ).resolves.toBe(0n);
    });

    it('computes the correct signed net unlinked delta with the inclusive baseline boundary', async () => {
      const createdAt = await seedAndLoadActiveBaseline();
      const after = (ms: number): Date => new Date(createdAt.getTime() + ms);

      // IN, after baseline, unlinked → +3_000_000
      await seedManual({
        direction: 'in',
        amountStroops: 3_000_000n,
        effectiveAt: after(60 * 60 * 1000),
        linked: false,
      });
      // OUT, after baseline, unlinked → -1_000_000
      await seedManual({
        direction: 'out',
        amountStroops: 1_000_000n,
        effectiveAt: after(2 * 60 * 60 * 1000),
        linked: false,
      });
      // IN, EXACTLY at baseline.created_at, unlinked → +500_000
      // (proves the `>=` boundary stayed inclusive after the fix).
      await seedManual({
        direction: 'in',
        amountStroops: 500_000n,
        effectiveAt: createdAt,
        linked: false,
      });
      // IN, BEFORE baseline (already in the opening balance) → excluded.
      await seedManual({
        direction: 'in',
        amountStroops: 5_000_000n,
        effectiveAt: after(-60 * 60 * 1000),
        linked: false,
      });
      // IN, after baseline, but LINKED to a Horizon movement (already in
      // the classified delta) → excluded from the UNLINKED delta.
      await seedManual({
        direction: 'in',
        amountStroops: 7_000_000n,
        effectiveAt: after(3 * 60 * 60 * 1000),
        linked: true,
      });

      const delta = await computeUnlinkedManualDelta({
        account: ACCT,
        asset: 'xlm',
        baselineCreatedAt: createdAt,
      });

      // +3_000_000 - 1_000_000 + 500_000 = 2_500_000
      // (pre-baseline 5M and the linked 7M are both excluded).
      expect(delta).toBe(2_500_000n);
    });
  },
);
