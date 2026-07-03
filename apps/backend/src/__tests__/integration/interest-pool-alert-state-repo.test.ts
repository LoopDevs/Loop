/**
 * Real-postgres integration tests for the persisted interest-pool
 * alert-state repo (hardening C10a). The unit suite emulates this repo
 * with an in-memory map; these tests pin the actual row-lock / insert
 * semantics, the at-least-once delivery contract, and the `state` /
 * `last_paged_state` CHECK constraints.
 *
 * Runs under `vitest.integration.config.ts` (LOOP_E2E_DB=1 + a real
 * `loop_test` postgres) — the same lane as the flywheel walk.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';
import {
  applyPoolAlertState,
  markPoolPageDelivered,
  releasePoolPageLease,
} from '../../payments/interest-pool-alert-state-repo.js';

const T0 = new Date('2026-07-03T00:00:00Z');
const T1 = new Date('2026-07-03T01:00:00Z');
const T2 = new Date('2026-07-03T02:00:00Z');

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAllTables();
});

describe('applyPoolAlertState', () => {
  it('first low write reports prior=unknown and claims the low page', async () => {
    const r = await applyPoolAlertState({
      assetCode: 'USDLOOP',
      state: 'low',
      daysOfCover: 3,
      poolStroops: 500n,
      checkedAt: T0,
    });
    expect(r.prior).toBe('unknown');
    expect(r.raced).toBe(false);
    expect(r.duePage).toBe('low');
  });

  it('does not re-claim a low already delivered', async () => {
    await applyPoolAlertState({
      assetCode: 'USDLOOP',
      state: 'low',
      daysOfCover: 3,
      poolStroops: 500n,
      checkedAt: T0,
    });
    await markPoolPageDelivered({ assetCode: 'USDLOOP', page: 'low' });

    const again = await applyPoolAlertState({
      assetCode: 'USDLOOP',
      state: 'low',
      daysOfCover: 2,
      poolStroops: 400n,
      checkedAt: T1,
    });
    expect(again.prior).toBe('low');
    expect(again.duePage).toBeUndefined();
  });

  it('claims recovery only after a low was delivered', async () => {
    await applyPoolAlertState({
      assetCode: 'USDLOOP',
      state: 'low',
      daysOfCover: 3,
      poolStroops: 500n,
      checkedAt: T0,
    });
    await markPoolPageDelivered({ assetCode: 'USDLOOP', page: 'low' });

    const recovered = await applyPoolAlertState({
      assetCode: 'USDLOOP',
      state: 'ok',
      daysOfCover: 30,
      poolStroops: 9_000n,
      checkedAt: T1,
    });
    expect(recovered.duePage).toBe('recovered');
    await markPoolPageDelivered({ assetCode: 'USDLOOP', page: 'recovered' });

    // A subsequent ok tick owes nothing.
    const steady = await applyPoolAlertState({
      assetCode: 'USDLOOP',
      state: 'ok',
      daysOfCover: 40,
      poolStroops: 12_000n,
      checkedAt: T2,
    });
    expect(steady.duePage).toBeUndefined();
  });

  it('an ok→low→ok blip whose low was never delivered elides the recovery', async () => {
    // Low claimed but NOT delivered (send failed → lease released).
    const low = await applyPoolAlertState({
      assetCode: 'GBPLOOP',
      state: 'low',
      daysOfCover: 3,
      poolStroops: 500n,
      checkedAt: T0,
    });
    expect(low.duePage).toBe('low');
    await releasePoolPageLease('GBPLOOP');

    // Recovers before the low was ever delivered → nothing to close.
    const recovered = await applyPoolAlertState({
      assetCode: 'GBPLOOP',
      state: 'ok',
      daysOfCover: 30,
      poolStroops: 9_000n,
      checkedAt: T1,
    });
    expect(recovered.duePage).toBeUndefined();
  });

  it('a held lease blocks a second machine from re-claiming the same page', async () => {
    // Machine A claims the low (fresh lease stamped, not yet delivered).
    const a = await applyPoolAlertState({
      assetCode: 'EURLOOP',
      state: 'low',
      daysOfCover: 3,
      poolStroops: 500n,
      checkedAt: T0,
    });
    expect(a.duePage).toBe('low');

    // Machine B ticks immediately after — the lease is fresh, so it
    // does NOT double-claim.
    const b = await applyPoolAlertState({
      assetCode: 'EURLOOP',
      state: 'low',
      daysOfCover: 3,
      poolStroops: 500n,
      checkedAt: T1,
    });
    expect(b.duePage).toBeUndefined();
  });

  it('refuses a stale sample (reads older than the persisted row)', async () => {
    await applyPoolAlertState({
      assetCode: 'USDLOOP',
      state: 'ok',
      daysOfCover: 30,
      poolStroops: 9_000n,
      checkedAt: T1,
    });
    const stale = await applyPoolAlertState({
      assetCode: 'USDLOOP',
      state: 'low',
      daysOfCover: 2,
      poolStroops: 100n,
      checkedAt: T0, // older than the persisted T1
    });
    expect(stale.raced).toBe(true);
    expect(stale.duePage).toBeUndefined();
  });
});
