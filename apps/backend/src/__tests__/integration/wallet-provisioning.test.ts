/**
 * Wallet-provisioning fleet-wide serialization (real postgres).
 *
 * CON-DOUBLE-RUN: both provisioning entry paths — the sweeper tick and
 * the enqueue-driven signup/admin activation — funnel through the SAME
 * `walletProvisioningLockKey()` advisory lock, so a user (and the
 * shared operator sequence number every activation tx consumes) can
 * never be driven by two provisioners at once. The unit suite pins the
 * per-path wiring with a mocked `withAdvisoryLock`; this suite proves
 * the lock itself is genuinely mutually exclusive against a real
 * postgres session — the property the mock can only assume.
 *
 * `LOOP_E2E_DB=1` gate, same harness as the sibling suites. No provider
 * is configured in the integration env, so the sweeper aborts
 * "unconfigured" once it holds the lock — which is fine: this test
 * asserts the LOCK behaviour (skip vs. run), not the on-chain drive.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

import { withAdvisoryLock } from '../../db/client.js';
import { runWalletProvisioningTick, walletProvisioningLockKey } from '../../wallet/provisioning.js';
import { ensureMigrated } from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

describeIf('wallet-provisioning fleet-lock serialization (real postgres)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  it('a sweeper tick SKIPS while the provisioning lock is held on another connection, and RUNS once it is free', async () => {
    // Hold the exact key the sweeper + enqueue paths use, on a
    // dedicated reserved connection (withAdvisoryLock pins one), until
    // we release it.
    let releaseLock!: () => void;
    const lockHeldUntilReleased = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let signalHeld!: () => void;
    const heldReady = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });

    const holder = withAdvisoryLock(walletProvisioningLockKey(), async () => {
      signalHeld();
      await lockHeldUntilReleased;
      return 'holder-done' as const;
    });

    // Wait until the lock is genuinely held in postgres.
    await heldReady;

    // A concurrent sweeper tick must observe the held lock and skip —
    // proving fleet-wide single-flight against real pg_try_advisory_lock.
    const whileHeld = await runWalletProvisioningTick();
    expect(whileHeld.skippedLocked).toBe(true);
    expect(whileHeld.activated).toBe(0);

    // Release the lock; the holder unwinds cleanly.
    releaseLock();
    const holderResult = await holder;
    expect(holderResult).toEqual({ ran: true, value: 'holder-done' });

    // With the lock free, the next tick gets PAST the lock (no longer
    // skippedLocked). Provider is unconfigured in this env, so it aborts
    // unconfigured — which still proves it acquired the lock and ran the
    // body rather than being fenced out.
    const whenFree = await runWalletProvisioningTick();
    expect(whenFree.skippedLocked).toBe(false);
  });

  it('two concurrent holders of the provisioning key are mutually exclusive (only one runs at a time)', async () => {
    // Drive genuine contention on the real advisory lock: two callers
    // race for the same key; a running flag asserts their critical
    // sections never overlap.
    let inCriticalSection = 0;
    let maxConcurrent = 0;
    let ranCount = 0;

    const contender = (): Promise<void> =>
      withAdvisoryLock(walletProvisioningLockKey(), async () => {
        inCriticalSection++;
        maxConcurrent = Math.max(maxConcurrent, inCriticalSection);
        // Hold long enough that a truly-concurrent second acquirer would
        // overlap if the lock were not exclusive.
        await new Promise((r) => setTimeout(r, 100));
        inCriticalSection--;
      }).then((res) => {
        if (res.ran) ranCount++;
      });

    await Promise.all([contender(), contender()]);

    // The lock is exclusive: the two critical sections never overlapped.
    expect(maxConcurrent).toBe(1);
    // At least one acquired; the loser saw ran:false (non-blocking
    // try-lock) — the fleet single-flight posture, not a deadlock.
    expect(ranCount).toBeGreaterThanOrEqual(1);
  });
});
