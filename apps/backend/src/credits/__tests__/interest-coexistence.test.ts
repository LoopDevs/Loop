import { describe, it, expect, vi } from 'vitest';

/**
 * ADR 031 / ADR 036 Phase D — two interest writers must never
 * coexist. With `LOOP_INTEREST_ONCHAIN_ENABLED=true` the on-chain
 * interest-mint worker owns the `type='interest'` ledger writes; the
 * legacy off-chain-only scheduler must refuse to start (boot-fail)
 * even if a future `index.ts` re-wire mistakenly calls it.
 *
 * Lives in its own file because the env mock must be in place before
 * the scheduler module resolves — the sibling scheduler test file
 * exercises the legacy path under the real (flag-off) env.
 */

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('../../env.js', () => ({
  env: {
    LOOP_INTEREST_ONCHAIN_ENABLED: true,
  },
}));

vi.mock('../accrue-interest.js', () => ({
  accrueOnePeriod: vi.fn(async () => ({
    users: 0,
    credited: 0,
    skippedZero: 0,
    skippedAlreadyAccrued: 0,
    totalsMinor: {},
  })),
}));

import { startInterestScheduler } from '../interest-scheduler.js';

describe('legacy-coexistence boot guard', () => {
  it('startInterestScheduler throws while LOOP_INTEREST_ONCHAIN_ENABLED=true', () => {
    expect(() =>
      startInterestScheduler({
        period: { apyBasisPoints: 300, periodsPerYear: 365 },
        intervalMs: 60_000,
      }),
    ).toThrowError(/two interest writers must never coexist/);
  });
});
