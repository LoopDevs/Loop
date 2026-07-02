/**
 * Real-postgres integration tests for the persisted asset-drift
 * state repo (hardening A2/A3). The unit suite emulates this repo
 * with an in-memory map; these tests pin the actual row-lock /
 * insert-race semantics and the DB CHECK constraints the emulation
 * can't exercise.
 *
 * Runs under `vitest.integration.config.ts` (LOOP_E2E_DB=1 + a real
 * `loop_test` postgres) — the same lane as the flywheel walk.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';
import {
  applyDriftState,
  listPersistedDriftStates,
  markPagesDelivered,
  releasePageLease,
} from '../../payments/asset-drift-state-repo.js';

const BASE = {
  state: 'ok' as const,
  failedRowsState: 'none' as const,
  lastDriftStroops: 0n,
  lastThresholdStroops: 1_000n,
  failedBurnStroops: 0n,
  failedInterestMintStroops: 0n,
};

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAllTables();
});

describe('applyDriftState', () => {
  it('first write reports prior=unknown and persists the row', async () => {
    const r = await applyDriftState({
      assetCode: 'GBPLOOP',
      ...BASE,
      state: 'over',
      lastDriftStroops: 123_456n,
      lastCheckedAt: new Date(),
    });
    expect(r.raced).toBe(false);
    expect(r.prior).toEqual({ state: 'unknown', failedRowsState: 'unknown' });

    const rows = await listPersistedDriftStates();
    const row = rows.get('GBPLOOP');
    expect(row?.state).toBe('over');
    expect(row?.lastDriftStroops).toBe(123_456n);
    expect(row?.lastThresholdStroops).toBe(1_000n);
  });

  it('subsequent writes report the prior state (the transition source of truth)', async () => {
    await applyDriftState({
      assetCode: 'GBPLOOP',
      ...BASE,
      state: 'over',
      failedRowsState: 'present',
      failedInterestMintStroops: 100_000n,
      lastCheckedAt: new Date(),
    });
    const r2 = await applyDriftState({
      assetCode: 'GBPLOOP',
      ...BASE,
      lastCheckedAt: new Date(),
    });
    expect(r2.raced).toBe(false);
    expect(r2.prior).toEqual({ state: 'over', failedRowsState: 'present' });

    const row = (await listPersistedDriftStates()).get('GBPLOOP');
    expect(row?.state).toBe('ok');
    expect(row?.failedRowsState).toBe('none');
    expect(row?.failedInterestMintStroops).toBe(0n);
  });

  it('exactly one of two concurrent first-writers owns the unknown→X transition', async () => {
    // Two machines tick the same brand-new asset concurrently. Either
    // they serialise (second sees the first's committed state as
    // prior) or they insert-race (loser gets raced=true). In both
    // schedules exactly ONE caller observes {prior: unknown,
    // raced: false} — the one that owns the first-observation page.
    const [a, b] = await Promise.all([
      applyDriftState({ assetCode: 'USDLOOP', ...BASE, state: 'over', lastCheckedAt: new Date() }),
      applyDriftState({ assetCode: 'USDLOOP', ...BASE, state: 'over', lastCheckedAt: new Date() }),
    ]);
    const owners = [a, b].filter((r) => !r.raced && r.prior.state === 'unknown');
    expect(owners).toHaveLength(1);
  });

  it('keys rows per asset — one asset flipping does not disturb another', async () => {
    await applyDriftState({
      assetCode: 'GBPLOOP',
      ...BASE,
      state: 'over',
      lastCheckedAt: new Date(),
    });
    await applyDriftState({ assetCode: 'EURLOOP', ...BASE, lastCheckedAt: new Date() });

    const rows = await listPersistedDriftStates();
    expect(rows.get('GBPLOOP')?.state).toBe('over');
    expect(rows.get('EURLOOP')?.state).toBe('ok');
  });

  it('refuses a sample computed from older reads than the persisted row (staleness fence)', async () => {
    const t1 = new Date(Date.now() - 10_000);
    const t2 = new Date();
    await applyDriftState({ assetCode: 'GBPLOOP', ...BASE, state: 'over', lastCheckedAt: t2 });

    // A slower machine finishes its (older) reads and tries to write
    // 'ok' — it must not invert the fresher 'over'.
    const stale = await applyDriftState({
      assetCode: 'GBPLOOP',
      ...BASE,
      lastCheckedAt: t1,
    });
    expect(stale.raced).toBe(true);
    expect(stale.duePages).toEqual({});
    expect((await listPersistedDriftStates()).get('GBPLOOP')?.state).toBe('over');
  });
});

describe('page delivery lifecycle (at-least-once)', () => {
  it('claims the due page on transition, blocks re-claims while the lease is fresh, and stops paging after delivery', async () => {
    const t = (offsetMs: number): Date => new Date(Date.now() + offsetMs);

    // ok → over: the writer claims the 'over' page.
    const first = await applyDriftState({
      assetCode: 'GBPLOOP',
      ...BASE,
      state: 'over',
      lastCheckedAt: t(0),
    });
    expect(first.duePages).toEqual({ drift: 'over' });

    // Another tick while the sender holds the lease: still due (not
    // delivered) but NOT re-claimed.
    const during = await applyDriftState({
      assetCode: 'GBPLOOP',
      ...BASE,
      state: 'over',
      lastCheckedAt: t(1_000),
    });
    expect(during.duePages).toEqual({});

    // Delivery recorded → no longer due on subsequent ticks.
    await markPagesDelivered({ assetCode: 'GBPLOOP', drift: 'over' });
    const after = await applyDriftState({
      assetCode: 'GBPLOOP',
      ...BASE,
      state: 'over',
      lastCheckedAt: t(2_000),
    });
    expect(after.duePages).toEqual({});

    // over → ok with the open page delivered → 'recovered' becomes due.
    const recovered = await applyDriftState({
      assetCode: 'GBPLOOP',
      ...BASE,
      lastCheckedAt: t(3_000),
    });
    expect(recovered.duePages).toEqual({ drift: 'recovered' });
  });

  it('a released lease re-opens the claim on the next tick (failed send retry path)', async () => {
    const t = (offsetMs: number): Date => new Date(Date.now() + offsetMs);
    const first = await applyDriftState({
      assetCode: 'GBPLOOP',
      ...BASE,
      state: 'over',
      failedRowsState: 'present',
      failedInterestMintStroops: 100_000n,
      lastCheckedAt: t(0),
    });
    expect(first.duePages).toEqual({ drift: 'over', failedRows: 'present' });

    // Send failed → lease released → next tick re-claims both pages.
    await releasePageLease('GBPLOOP');
    const retry = await applyDriftState({
      assetCode: 'GBPLOOP',
      ...BASE,
      state: 'over',
      failedRowsState: 'present',
      failedInterestMintStroops: 100_000n,
      lastCheckedAt: t(1_000),
    });
    expect(retry.duePages).toEqual({ drift: 'over', failedRows: 'present' });
  });

  it('per-dimension delivery: marking one dimension leaves the other due', async () => {
    const t = (offsetMs: number): Date => new Date(Date.now() + offsetMs);
    await applyDriftState({
      assetCode: 'GBPLOOP',
      ...BASE,
      state: 'over',
      failedRowsState: 'present',
      failedInterestMintStroops: 100_000n,
      lastCheckedAt: t(0),
    });
    // Only the failed-rows page was delivered.
    await markPagesDelivered({ assetCode: 'GBPLOOP', failedRows: 'present' });

    const retry = await applyDriftState({
      assetCode: 'GBPLOOP',
      ...BASE,
      state: 'over',
      failedRowsState: 'present',
      failedInterestMintStroops: 100_000n,
      lastCheckedAt: t(1_000),
    });
    expect(retry.duePages).toEqual({ drift: 'over' });
  });
});

describe('asset_drift_state CHECK constraints', () => {
  /**
   * Drizzle wraps the postgres error ("Failed query: …") and parks
   * the constraint violation in `cause` — assert against the whole
   * chain rather than the wrapper message.
   */
  async function expectConstraintViolation(
    run: Promise<unknown>,
    constraint: string,
  ): Promise<void> {
    let thrown: unknown = null;
    await run.catch((err: unknown) => {
      thrown = err;
    });
    expect(thrown).not.toBeNull();
    const chain: string[] = [];
    let cursor: unknown = thrown;
    while (cursor instanceof Error) {
      chain.push(cursor.message);
      cursor = cursor.cause;
    }
    expect(chain.join(' | ')).toMatch(constraint);
  }

  it('rejects unknown state values at the DB layer', async () => {
    await expectConstraintViolation(
      db.execute(
        sql`INSERT INTO asset_drift_state
          (asset_code, state, failed_rows_state, last_drift_stroops, last_threshold_stroops,
           failed_burn_stroops, failed_interest_mint_stroops, last_checked_at)
          VALUES ('GBPLOOP', 'unknown', 'none', 0, 0, 0, 0, NOW())`,
      ),
      'asset_drift_state_state_known',
    );
  });

  it('rejects negative failed sums at the DB layer', async () => {
    await expectConstraintViolation(
      db.execute(
        sql`INSERT INTO asset_drift_state
          (asset_code, state, failed_rows_state, last_drift_stroops, last_threshold_stroops,
           failed_burn_stroops, failed_interest_mint_stroops, last_checked_at)
          VALUES ('GBPLOOP', 'ok', 'none', 0, 0, -1, 0, NOW())`,
      ),
      'asset_drift_state_failed_sums_non_negative',
    );
  });
});
