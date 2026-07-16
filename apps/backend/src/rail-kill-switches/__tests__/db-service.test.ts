/**
 * NS-04 — unit tests for the fail-closed posture + the enforcement
 * helper. No DB: `../../db/client.js` is mocked so the read path can be
 * driven to throw, exercising the `isHalted` catch branch (the
 * money-critical "unreadable switch → treated as HALTED" property that a
 * DB-backed integration test can't easily force).
 *
 * The round-trip / missing-row / real-read behaviour is covered against a
 * real postgres in `__tests__/integration/rail-kill-switches.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// A controllable stand-in for the drizzle query chain. `shouldThrow`
// flips per-test: true → the awaited `.where(...)` rejects (store read
// error); false → resolves to `rows`.
const state: { shouldThrow: boolean; rows: unknown[] } = { shouldThrow: false, rows: [] };

vi.mock('../../db/client.js', () => {
  const chain = {
    from: () => chain,
    where: () =>
      state.shouldThrow
        ? Promise.reject(new Error('rail_kill_switches read failed (simulated DB outage)'))
        : Promise.resolve(state.rows),
  };
  return { db: { select: () => chain } };
});

import { DbKillSwitchService } from '../db-service.js';
import { assertRailNotHalted, RailHaltedError, type KillSwitchService } from '../service.js';
import type { Rail } from '../types.js';

describe('DbKillSwitchService.isHalted — fail-closed posture', () => {
  const svc = new DbKillSwitchService();

  beforeEach(() => {
    state.shouldThrow = false;
    state.rows = [];
  });

  it('FAILS CLOSED: a store read error → isHalted returns true (rail treated as HALTED)', async () => {
    state.shouldThrow = true;
    await expect(svc.isHalted('payout')).resolves.toBe(true);
  });

  it('a missing row reads as NOT halted (the mandated default)', async () => {
    state.rows = [];
    await expect(svc.isHalted('deposit')).resolves.toBe(false);
  });

  it('an explicit halted=true row reads as halted', async () => {
    state.rows = [{ halted: true }];
    await expect(svc.isHalted('refund')).resolves.toBe(true);
  });

  it('an explicit halted=false row reads as NOT halted', async () => {
    state.rows = [{ halted: false }];
    await expect(svc.isHalted('vault')).resolves.toBe(false);
  });
});

describe('assertRailNotHalted', () => {
  function fakeService(halted: boolean): KillSwitchService {
    return {
      isHalted: async () => halted,
      getState: async (rail: Rail) => ({
        rail,
        halted,
        reason: null,
        actorUserId: null,
        updatedAt: new Date(0),
      }),
      listStates: async () => [],
      halt: async () => {
        throw new Error('not used');
      },
      resume: async () => {
        throw new Error('not used');
      },
    };
  }

  it('throws RailHaltedError (carrying the rail) when the rail is halted', async () => {
    await expect(assertRailNotHalted(fakeService(true), 'payout')).rejects.toBeInstanceOf(
      RailHaltedError,
    );
    await expect(assertRailNotHalted(fakeService(true), 'payout')).rejects.toMatchObject({
      rail: 'payout',
    });
  });

  it('resolves (no throw) when the rail is not halted', async () => {
    await expect(assertRailNotHalted(fakeService(false), 'payout')).resolves.toBeUndefined();
  });
});
