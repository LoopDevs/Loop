import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stable, single handle (not a fresh object per `.child()` call) so
// tests can assert on `log.error`/`log.warn` calls — notably the S4-1
// follow-up shard-failure-isolation test below, which asserts a
// rejecting shard is logged rather than silently swallowed.
const { logMock } = vi.hoisted(() => ({
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../logger.js', () => ({
  logger: {
    child: () => logMock,
  },
}));

const { repoMocks } = vi.hoisted(() => ({
  repoMocks: {
    listClaimablePayouts: vi.fn<
      (opts: { limit?: number; staleSeconds: number; maxAttempts: number }) => Promise<unknown[]>
    >(async () => []),
    markPayoutSubmitted: vi.fn<(id: string) => Promise<unknown>>(async (id: string) => ({ id })),
    markPayoutConfirmed: vi.fn<(args: { id: string; txHash: string }) => Promise<unknown>>(
      async (args: { id: string; txHash: string }) => ({
        id: args.id,
        txHash: args.txHash,
      }),
    ),
    markPayoutFailed: vi.fn<(args: { id: string; reason: string }) => Promise<unknown>>(
      async (args: { id: string; reason: string }) => ({ id: args.id, reason: args.reason }),
    ),
    reclaimSubmittedPayout: vi.fn<
      (args: { id: string; expectedAttempts: number }) => Promise<unknown>
    >(async (args: { id: string; expectedAttempts: number }) => ({
      id: args.id,
      attempts: args.expectedAttempts + 1,
    })),
    // CF-18: hash stamp on a `submitted` row before the network submit.
    // Default returns a row (success); tests that exercise the
    // persist-failure path override it to null.
    recordPayoutTxHash: vi.fn<(args: { id: string; txHash: string }) => Promise<unknown>>(
      async (args: { id: string; txHash: string }) => ({ id: args.id, txHash: args.txHash }),
    ),
    // CF2-07: re-fetch of the row on an ambiguous (transient_horizon)
    // retry-exhaustion failure. Default: no fresh hash persisted (the
    // common case — most attempts fail before `onSigned` even runs),
    // so the new check is a no-op and behaviour matches pre-CF2-07.
    getPayoutForAdmin: vi.fn<(id: string) => Promise<{ id: string; txHash: string | null } | null>>(
      async (id: string) => ({ id, txHash: null }),
    ),
  },
}));
// Hardening A8: the tick runs under a fleet-wide advisory leader lock.
// Default mock runs fn inline (single-machine happy path); a per-test
// override simulates losing the lock to another machine.
const { advisoryLockState } = vi.hoisted(() => ({
  advisoryLockState: { acquired: true },
}));
vi.mock('../../db/client.js', () => ({
  withAdvisoryLock: async <T>(_key: bigint, fn: () => Promise<T>) =>
    advisoryLockState.acquired ? { ran: true, value: await fn() } : { ran: false },
}));

vi.mock('../../credits/pending-payouts.js', () => ({
  listClaimablePayouts: (opts: { limit?: number; staleSeconds: number; maxAttempts: number }) =>
    repoMocks.listClaimablePayouts(opts),
  markPayoutSubmitted: (id: string) => repoMocks.markPayoutSubmitted(id),
  markPayoutConfirmed: (args: { id: string; txHash: string }) =>
    repoMocks.markPayoutConfirmed(args),
  markPayoutFailed: (args: { id: string; reason: string }) => repoMocks.markPayoutFailed(args),
  reclaimSubmittedPayout: (args: { id: string; expectedAttempts: number }) =>
    repoMocks.reclaimSubmittedPayout(args),
  recordPayoutTxHash: (args: { id: string; txHash: string }) => repoMocks.recordPayoutTxHash(args),
}));
vi.mock('../../credits/pending-payouts-admin.js', () => ({
  getPayoutForAdmin: (id: string) => repoMocks.getPayoutForAdmin(id),
}));

const { horizonMock } = vi.hoisted(() => ({
  horizonMock: {
    findOutboundPaymentByMemo: vi.fn<
      (
        args: unknown,
      ) => Promise<{ txHash: string; amount: string; assetCode: string | null } | null>
    >(async () => null),
    // CF-18: authoritative point lookup by tx hash. Default "never
    // landed" (null) so rows without a persisted hash fall through to
    // the memo scan exactly as before.
    getOutboundPaymentByTxHash: vi.fn<(hash: string) => Promise<{ landed: boolean } | null>>(
      async () => null,
    ),
  },
}));
vi.mock('../horizon.js', () => ({
  findOutboundPaymentByMemo: (args: unknown) => horizonMock.findOutboundPaymentByMemo(args),
  getOutboundPaymentByTxHash: (hash: string) => horizonMock.getOutboundPaymentByTxHash(hash),
}));

// Trustline pre-check (A4-062 follow-up — Phase-2 trustline-probe).
// Default: every destination has the matching trustline. Tests that
// exercise the missing-trustline path override the implementation.
const { trustlinesMock } = vi.hoisted(() => ({
  trustlinesMock: {
    getAccountTrustlines: vi.fn<
      (account: string) => Promise<{
        account: string;
        accountExists: boolean;
        trustlines: Map<string, { code: string; issuer: string }>;
        asOfMs: number;
      }>
    >(async (account: string) => ({
      account,
      accountExists: true,
      // The mock "always trusts everything" — runPayoutTick reads
      // the row's `${assetCode}::${assetIssuer}` key, so giving it
      // a Map with that exact key short-circuits the missing-
      // trustline branch on every default test path. Tests that
      // need to assert against the missing-trustline branch
      // override `mockImplementationOnce` to return an empty Map.
      trustlines: new Map([
        ['USDLOOP::GISSUER', { code: 'USDLOOP', issuer: 'GISSUER' }],
        ['GBPLOOP::GISSUER', { code: 'GBPLOOP', issuer: 'GISSUER' }],
        ['EURLOOP::GISSUER', { code: 'EURLOOP', issuer: 'GISSUER' }],
      ]),
      asOfMs: Date.now(),
    })),
  },
}));
vi.mock('../horizon-trustlines.js', () => ({
  getAccountTrustlines: (account: string) => trustlinesMock.getAccountTrustlines(account),
}));

const { sdkMock, PayoutSubmitErrorMock } = vi.hoisted(() => {
  class PayoutSubmitErrorMock extends Error {
    readonly kind: string;
    constructor(kind: string, msg: string) {
      super(msg);
      this.kind = kind;
    }
  }
  return {
    PayoutSubmitErrorMock,
    sdkMock: {
      // CF-18: the real submitPayout fires `onSigned(hash)` before the
      // network submit. Mirror that here so the worker's persist step
      // (recordPayoutTxHash) is exercised on the default happy path.
      submitPayout: vi.fn<
        (args: { onSigned?: (h: string) => Promise<void> | void }) => Promise<{
          txHash: string;
          ledger: number | null;
        }>
      >(async (args) => {
        await args.onSigned?.('tx-hash');
        return { txHash: 'tx-hash', ledger: 1 };
      }),
    },
  };
});
vi.mock('../payout-submit.js', () => ({
  submitPayout: (args: { onSigned?: (h: string) => Promise<void> | void }) =>
    sdkMock.submitPayout(args),
  PayoutSubmitError: PayoutSubmitErrorMock,
}));

const { discordMock } = vi.hoisted(() => ({
  discordMock: {
    notifyPayoutFailed: vi.fn<(args: unknown) => void>(() => undefined),
    notifyPayoutAwaitingTrustline: vi.fn<(args: unknown) => void>(() => undefined),
  },
}));
vi.mock('../../discord.js', () => ({
  notifyPayoutFailed: (args: unknown) => discordMock.notifyPayoutFailed(args),
  notifyPayoutAwaitingTrustline: (args: unknown) => discordMock.notifyPayoutAwaitingTrustline(args),
}));

import { Keypair } from '@stellar/stellar-sdk';

// CF-21: the auto-compensation seam. Fully mocked (no importActual) so
// the test doesn't drag in `env.js` / the real DB client. The worker
// imports these exact mocked error classes, so its `instanceof` checks
// resolve against the same identities the tests construct — same
// pattern as `PayoutSubmitErrorMock` above.
const { compensationMock, AlreadyCompensatedErrorMock, PayoutNotCompensableErrorMock } = vi.hoisted(
  () => {
    class AlreadyCompensatedErrorMock extends Error {
      constructor(public readonly payoutId: string) {
        super(`Payout ${payoutId} has already been compensated`);
        this.name = 'AlreadyCompensatedError';
      }
    }
    class PayoutNotCompensableErrorMock extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'PayoutNotCompensableError';
      }
    }
    return {
      AlreadyCompensatedErrorMock,
      PayoutNotCompensableErrorMock,
      compensationMock: {
        applyAdminPayoutCompensation: vi.fn<(args: unknown) => Promise<unknown>>(async () => ({
          id: 'comp-1',
          payoutId: 'p-1',
          userId: 'u-1',
          currency: 'GBP',
          amountMinor: 500n,
          priorBalanceMinor: 0n,
          newBalanceMinor: 500n,
          createdAt: new Date(),
        })),
      },
    };
  },
);
vi.mock('../../credits/payout-compensation.js', () => ({
  applyAdminPayoutCompensation: (args: unknown) =>
    compensationMock.applyAdminPayoutCompensation(args),
  AlreadyCompensatedError: AlreadyCompensatedErrorMock,
  PayoutNotCompensableError: PayoutNotCompensableErrorMock,
}));

// CF-15: the kill-switch seam. Default: nothing killed.
const { killMock } = vi.hoisted(() => ({ killMock: { isKilled: vi.fn((_s: string) => false) } }));
vi.mock('../../kill-switches.js', () => ({
  isKilled: (subsystem: string) => killMock.isKilled(subsystem),
}));

const { lifecycleMocks } = vi.hoisted(() => ({
  lifecycleMocks: {
    markWorkerStarted: vi.fn(),
    markWorkerStopped: vi.fn(),
    markWorkerTickFailure: vi.fn(),
    markWorkerTickSuccess: vi.fn(),
    runStuckPayoutWatchdog: vi.fn(async () => undefined),
  },
}));
vi.mock('../../runtime-health.js', () => ({
  markWorkerStarted: (...args: unknown[]) => lifecycleMocks.markWorkerStarted(...args),
  markWorkerStopped: (...args: unknown[]) => lifecycleMocks.markWorkerStopped(...args),
  markWorkerTickFailure: (...args: unknown[]) => lifecycleMocks.markWorkerTickFailure(...args),
  markWorkerTickSuccess: (...args: unknown[]) => lifecycleMocks.markWorkerTickSuccess(...args),
}));
vi.mock('../stuck-payout-watchdog.js', () => ({
  STUCK_PAYOUT_WATCHDOG_INTERVAL_MS: 60_000,
  runStuckPayoutWatchdog: () => lifecycleMocks.runStuckPayoutWatchdog(),
}));

import {
  runPayoutTick,
  startPayoutWorker,
  stopPayoutWorker,
  __resetPayoutWorkerForTests,
} from '../payout-worker.js';

const BASE_ARGS = {
  operatorSecret: 'SXXX',
  // A4-104: explicit operator pubkey for the Horizon idempotency
  // pre-check. Distinct from `assetIssuer` (`GISSUER` in
  // `makeRow`) so a regression on the lookup-account fix would
  // immediately surface as the prior-payment scan querying the
  // wrong account.
  operatorAccount: 'GOPERATOR',
  horizonUrl: 'https://horizon.example',
  networkPassphrase: 'PUBLIC_NETWORK',
  maxAttempts: 5,
};

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p-1',
    userId: 'u-1',
    orderId: 'o-1',
    assetCode: 'GBPLOOP',
    assetIssuer: 'GISSUER',
    toAddress: 'GDESTINATION',
    amountStroops: 50_000_000n,
    memoText: 'order-abc',
    state: 'pending',
    attempts: 0,
    // CF-18: rows start with no persisted hash. The authoritative
    // hash-lookup pre-check only fires when this is non-null (a re-pick
    // of a row whose prior attempt recorded its hash).
    txHash: null,
    ...overrides,
  };
}

beforeEach(() => {
  __resetPayoutWorkerForTests();
  logMock.info.mockClear();
  logMock.warn.mockClear();
  logMock.error.mockClear();
  logMock.debug.mockClear();
  advisoryLockState.acquired = true;
  repoMocks.listClaimablePayouts.mockReset();
  repoMocks.markPayoutSubmitted.mockReset();
  repoMocks.markPayoutConfirmed.mockReset();
  repoMocks.markPayoutFailed.mockReset();
  repoMocks.reclaimSubmittedPayout.mockReset();
  repoMocks.recordPayoutTxHash.mockReset();
  repoMocks.getPayoutForAdmin.mockReset();
  repoMocks.getPayoutForAdmin.mockImplementation(async (id: string) => ({ id, txHash: null }));
  horizonMock.findOutboundPaymentByMemo.mockReset();
  horizonMock.getOutboundPaymentByTxHash.mockReset();
  sdkMock.submitPayout.mockReset();
  // Sensible defaults.
  repoMocks.listClaimablePayouts.mockResolvedValue([]);
  repoMocks.markPayoutSubmitted.mockImplementation(async (id: string) => ({ id }));
  repoMocks.reclaimSubmittedPayout.mockImplementation(
    async (args: { id: string; expectedAttempts: number }) => ({
      id: args.id,
      attempts: args.expectedAttempts + 1,
    }),
  );
  repoMocks.markPayoutConfirmed.mockImplementation(
    async (args: { id: string; txHash: string }) => ({ id: args.id, txHash: args.txHash }),
  );
  repoMocks.markPayoutFailed.mockImplementation(async (args: { id: string; reason: string }) => ({
    id: args.id,
    reason: args.reason,
  }));
  repoMocks.recordPayoutTxHash.mockImplementation(async (args: { id: string; txHash: string }) => ({
    id: args.id,
    txHash: args.txHash,
  }));
  horizonMock.findOutboundPaymentByMemo.mockResolvedValue(null);
  horizonMock.getOutboundPaymentByTxHash.mockResolvedValue(null);
  sdkMock.submitPayout.mockImplementation(
    async (args: { onSigned?: (h: string) => Promise<void> | void }) => {
      await args.onSigned?.('tx-hash');
      return { txHash: 'tx-hash', ledger: 1 };
    },
  );
  discordMock.notifyPayoutFailed.mockClear();
  discordMock.notifyPayoutAwaitingTrustline.mockClear();
  compensationMock.applyAdminPayoutCompensation.mockReset();
  compensationMock.applyAdminPayoutCompensation.mockResolvedValue({
    id: 'comp-1',
    payoutId: 'p-1',
    userId: 'u-1',
    currency: 'GBP',
    amountMinor: 500n,
    priorBalanceMinor: 0n,
    newBalanceMinor: 500n,
    createdAt: new Date(),
  });
  killMock.isKilled.mockReset();
  killMock.isKilled.mockReturnValue(false);
  lifecycleMocks.markWorkerStarted.mockReset();
  lifecycleMocks.markWorkerStopped.mockReset();
  lifecycleMocks.markWorkerTickFailure.mockReset();
  lifecycleMocks.markWorkerTickSuccess.mockReset();
  lifecycleMocks.runStuckPayoutWatchdog.mockReset();
  lifecycleMocks.runStuckPayoutWatchdog.mockResolvedValue(undefined);
});

describe('runPayoutTick (A8 leader lock)', () => {
  it('runs an empty tick without claiming rows when another machine holds the leader lock', async () => {
    advisoryLockState.acquired = false;
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.picked).toBe(0);
    expect(r.confirmed).toBe(0);
    // The claim query is never even issued — the loser doesn't touch
    // the queue.
    expect(repoMocks.listClaimablePayouts).not.toHaveBeenCalled();
  });

  it('releases the lock + returns empty when the tick body exceeds the lease deadline (P1 fix)', async () => {
    // A hung Horizon: the claim (or a submit) never resolves. The lease
    // must fire so the leader lock is released and the fleet is not
    // stalled. Emulate the hang at the claim query.
    vi.useFakeTimers();
    try {
      let releaseHang: () => void = () => {};
      repoMocks.listClaimablePayouts.mockReturnValue(
        new Promise((resolve) => {
          // never resolves until we release, simulating a hung tick
          releaseHang = () => resolve([]);
        }),
      );
      const tickPromise = runPayoutTick(BASE_ARGS);
      // Advance past the 90s lease — the Promise.race timeout wins.
      await vi.advanceTimersByTimeAsync(90_001);
      const r = await tickPromise;
      expect(r.picked).toBe(0); // empty tick returned, not a hang
      releaseHang();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('payout worker lifecycle', () => {
  async function flushWorkerTick(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const START_ARGS = {
    ...BASE_ARGS,
    intervalMs: 60_000,
    limit: 2,
    watchdogStaleSeconds: 120,
  };

  it('starts once, runs immediate payout/watchdog ticks, records health, and stops', async () => {
    startPayoutWorker(START_ARGS);
    startPayoutWorker(START_ARGS);

    await flushWorkerTick();

    expect(lifecycleMocks.markWorkerStarted).toHaveBeenCalledOnce();
    expect(repoMocks.listClaimablePayouts).toHaveBeenCalledWith({
      limit: 2,
      staleSeconds: 120,
      maxAttempts: START_ARGS.maxAttempts,
    });
    expect(lifecycleMocks.runStuckPayoutWatchdog).toHaveBeenCalledOnce();
    expect(lifecycleMocks.markWorkerTickSuccess).toHaveBeenCalledOnce();

    stopPayoutWorker();
    stopPayoutWorker();

    expect(lifecycleMocks.markWorkerStopped).toHaveBeenCalledOnce();
  });

  it('marks payout tick failures without killing the interval loop', async () => {
    const err = new Error('claim failed');
    repoMocks.listClaimablePayouts.mockRejectedValue(err);

    startPayoutWorker(START_ARGS);
    await flushWorkerTick();

    expect(lifecycleMocks.markWorkerTickFailure).toHaveBeenCalledWith('payout_worker', err);
    expect(lifecycleMocks.markWorkerTickSuccess).not.toHaveBeenCalled();

    stopPayoutWorker();
  });

  it('swallows stuck-payout watchdog failures separately from payout tick success', async () => {
    lifecycleMocks.runStuckPayoutWatchdog.mockRejectedValue(new Error('watchdog failed'));

    startPayoutWorker(START_ARGS);
    await flushWorkerTick();

    expect(lifecycleMocks.runStuckPayoutWatchdog).toHaveBeenCalledOnce();
    expect(lifecycleMocks.markWorkerTickSuccess).toHaveBeenCalledOnce();
    expect(lifecycleMocks.markWorkerTickFailure).not.toHaveBeenCalled();

    stopPayoutWorker();
  });

  it('test reset clears active payout and watchdog timers without emitting stop health', async () => {
    startPayoutWorker(START_ARGS);
    await flushWorkerTick();
    lifecycleMocks.markWorkerStopped.mockClear();

    __resetPayoutWorkerForTests();

    expect(lifecycleMocks.markWorkerStopped).not.toHaveBeenCalled();

    startPayoutWorker(START_ARGS);
    await flushWorkerTick();
    expect(lifecycleMocks.markWorkerStarted).toHaveBeenCalledTimes(2);

    stopPayoutWorker();
  });
});

describe('runPayoutTick', () => {
  it('no pending rows → zero counts, no calls', async () => {
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.picked).toBe(0);
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
  });

  // ───────────────────────── trustline pre-check ─────────────────────────
  // (Phase-2 trustline-probe; ADR-015/016 §"trustline-probe before
  // payout submit"). Default is "trustline exists" via the hoisted
  // mock; these tests override `mockImplementationOnce` to flip
  // through the missing-trustline + Horizon-degraded branches.

  it('missing trustline → retriedLater, no submit, no claim, ops notified', async () => {
    trustlinesMock.getAccountTrustlines.mockImplementationOnce(async () => ({
      account: 'GDESTINATION',
      accountExists: true,
      trustlines: new Map(), // ← no trustlines at all
      asOfMs: Date.now(),
    }));
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.confirmed).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.retriedLater).toBe(1);
    expect(repoMocks.markPayoutSubmitted).not.toHaveBeenCalled();
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
    expect(discordMock.notifyPayoutAwaitingTrustline).toHaveBeenCalledTimes(1);
    expect(discordMock.notifyPayoutAwaitingTrustline).toHaveBeenCalledWith(
      expect.objectContaining({
        payoutId: 'p-1',
        userId: 'u-1',
        account: 'GDESTINATION',
        assetCode: 'GBPLOOP',
        accountExists: true,
      }),
    );
  });

  it('trustline read failure → retriedLater (fail-closed) without submitting', async () => {
    trustlinesMock.getAccountTrustlines.mockRejectedValueOnce(new Error('horizon 503'));
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.retriedLater).toBe(1);
    expect(repoMocks.markPayoutSubmitted).not.toHaveBeenCalled();
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
  });

  it('trustline exists but for a different issuer → still missing, no submit', async () => {
    // The row is for GBPLOOP::GISSUER but the destination only
    // trusts GBPLOOP::GDIFFERENT_ISSUER. Per CSP-shaped logic the
    // (code, issuer) pair must match exactly — partial matches
    // would let an attacker substitute their own issuer.
    trustlinesMock.getAccountTrustlines.mockImplementationOnce(async () => ({
      account: 'GDESTINATION',
      accountExists: true,
      trustlines: new Map([['GBPLOOP::GDIFFERENT', { code: 'GBPLOOP', issuer: 'GDIFFERENT' }]]),
      asOfMs: Date.now(),
    }));
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.retriedLater).toBe(1);
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
  });

  it('happy path: pre-check null → submit → confirm', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.confirmed).toBe(1);
    expect(horizonMock.findOutboundPaymentByMemo).toHaveBeenCalledTimes(1);
    expect(repoMocks.markPayoutSubmitted).toHaveBeenCalledWith('p-1');
    expect(sdkMock.submitPayout).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({ to: 'GDESTINATION', assetCode: 'GBPLOOP' }),
      }),
    );
    expect(repoMocks.markPayoutConfirmed).toHaveBeenCalledWith({ id: 'p-1', txHash: 'tx-hash' });
  });

  it('A4-104: pre-check scans the operator account, NOT the asset issuer', async () => {
    // A treasury topology that splits issuer (cold) from operator
    // (hot) is intended to be supported. The earlier code reused
    // `row.assetIssuer` for the lookup account; this test pins the
    // fix so a regression to that behaviour is caught here.
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    await runPayoutTick(BASE_ARGS);
    expect(horizonMock.findOutboundPaymentByMemo).toHaveBeenCalledWith(
      expect.objectContaining({
        account: 'GOPERATOR',
        to: 'GDESTINATION',
        memo: 'order-abc',
      }),
    );
    expect(horizonMock.findOutboundPaymentByMemo).not.toHaveBeenCalledWith(
      expect.objectContaining({ account: 'GISSUER' }),
    );
  });

  it('idempotency pre-check finds prior submit → converges to confirmed without re-submitting', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    horizonMock.findOutboundPaymentByMemo.mockResolvedValue({
      txHash: 'prior-tx',
      amount: '5.0000000',
      assetCode: 'GBPLOOP',
    });
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.skippedAlreadyLanded).toBe(1);
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
    expect(repoMocks.markPayoutConfirmed).toHaveBeenCalledWith({
      id: 'p-1',
      txHash: 'prior-tx',
    });
  });

  it('pre-check race (markConfirmed returns null) counts as skippedRace', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    horizonMock.findOutboundPaymentByMemo.mockResolvedValue({
      txHash: 'prior-tx',
      amount: '5.0000000',
      assetCode: 'GBPLOOP',
    });
    repoMocks.markPayoutConfirmed.mockResolvedValue(null);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.skippedRace).toBe(1);
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
  });

  it('markSubmitted race (another worker claimed it) counts as skippedRace, no submit', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    repoMocks.markPayoutSubmitted.mockResolvedValue(null);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.skippedRace).toBe(1);
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
  });

  it('pre-check failure fails closed and does not submit a payout', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    horizonMock.findOutboundPaymentByMemo.mockRejectedValue(new Error('horizon down'));
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.retriedLater).toBe(1);
    expect(repoMocks.markPayoutSubmitted).not.toHaveBeenCalled();
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
  });

  // ─────────────────────────── CF-18 ───────────────────────────
  // Authoritative tx-hash idempotency + hash persistence before submit.

  it('CF-18: pre-check matches the memo scan with amount+asset pinned (P2-1)', async () => {
    // The memo scan must be called with the row's expected amount +
    // asset so a memo collision can't converge the wrong payment.
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    await runPayoutTick(BASE_ARGS);
    expect(horizonMock.findOutboundPaymentByMemo).toHaveBeenCalledWith(
      expect.objectContaining({
        account: 'GOPERATOR',
        to: 'GDESTINATION',
        memo: 'order-abc',
        expectedAmountStroops: 50_000_000n,
        expectedAssetCode: 'GBPLOOP',
      }),
    );
  });

  it('CF-18: re-pick with a persisted hash that landed → converges via authoritative lookup, no scan, no submit', async () => {
    // A watchdog re-pick of a row whose prior attempt recorded its hash
    // (onSigned → recordPayoutTxHash). The authoritative point lookup
    // proves the tx landed regardless of how many inbound deposits have
    // scrolled the memo-scan window — the core CF-18 fix.
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ state: 'submitted', attempts: 1, txHash: 'persisted-landed-hash' }),
    ]);
    horizonMock.getOutboundPaymentByTxHash.mockResolvedValue({ landed: true });
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.skippedAlreadyLanded).toBe(1);
    expect(horizonMock.getOutboundPaymentByTxHash).toHaveBeenCalledWith('persisted-landed-hash');
    // The window-bound memo scan is NOT consulted — no window dependency.
    expect(horizonMock.findOutboundPaymentByMemo).not.toHaveBeenCalled();
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
    expect(repoMocks.markPayoutConfirmed).toHaveBeenCalledWith({
      id: 'p-1',
      txHash: 'persisted-landed-hash',
    });
  });

  it('CF-18: re-pick with a persisted hash that FAILED on chain → falls through to re-submit', async () => {
    // A persisted hash for a tx that landed but failed (e.g. tx_bad_seq
    // sealed as a failed tx) moved no value, so re-submission is safe.
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ state: 'submitted', attempts: 1, txHash: 'persisted-failed-hash' }),
    ]);
    horizonMock.getOutboundPaymentByTxHash.mockResolvedValue({ landed: false });
    // Memo scan also finds nothing (the prior failed tx isn't a match).
    horizonMock.findOutboundPaymentByMemo.mockResolvedValue(null);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.confirmed).toBe(1);
    expect(horizonMock.getOutboundPaymentByTxHash).toHaveBeenCalledWith('persisted-failed-hash');
    expect(sdkMock.submitPayout).toHaveBeenCalledTimes(1);
  });

  it('CF-18: re-pick with a persisted hash that never landed (404 → null) → re-submits', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ state: 'submitted', attempts: 1, txHash: 'persisted-never-landed' }),
    ]);
    horizonMock.getOutboundPaymentByTxHash.mockResolvedValue(null);
    horizonMock.findOutboundPaymentByMemo.mockResolvedValue(null);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.confirmed).toBe(1);
    expect(sdkMock.submitPayout).toHaveBeenCalledTimes(1);
  });

  it('CF-18: authoritative lookup throwing fails closed (no submit)', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ state: 'submitted', attempts: 1, txHash: 'persisted-hash' }),
    ]);
    horizonMock.getOutboundPaymentByTxHash.mockRejectedValue(new Error('horizon 503'));
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.retriedLater).toBe(1);
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
  });

  it('CF-18: the deterministic hash is persisted (recordPayoutTxHash) BEFORE submit returns', async () => {
    // The happy-path submitPayout mock fires onSigned('tx-hash'); the
    // worker must persist it via recordPayoutTxHash so a crash after the
    // tx lands is recoverable on the next re-pick.
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.confirmed).toBe(1);
    expect(repoMocks.recordPayoutTxHash).toHaveBeenCalledWith({ id: 'p-1', txHash: 'tx-hash' });
  });

  it('CF-18: a hash-persist failure aborts the submit (fail-closed)', async () => {
    // recordPayoutTxHash returning null means the row moved out from
    // under us between claim and stamp. onSigned throws → submitPayout
    // surfaces it as terminal_other → the row is not double-submitted.
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    repoMocks.recordPayoutTxHash.mockResolvedValue(null);
    // Use the REAL submitPayout contract: onSigned throws inside it →
    // it would throw PayoutSubmitError('terminal_other'). Simulate that
    // by having the mock invoke onSigned and surface its throw.
    sdkMock.submitPayout.mockImplementation(
      async (args: { onSigned?: (h: string) => Promise<void> | void }) => {
        await args.onSigned?.('tx-hash'); // throws → propagates
        return { txHash: 'tx-hash', ledger: 1 };
      },
    );
    const r = await runPayoutTick(BASE_ARGS);
    // The throw is an unclassified error → handleSubmitError → failed
    // (no second submit; markPayoutConfirmed never called).
    expect(r.confirmed).toBe(0);
    expect(repoMocks.markPayoutConfirmed).not.toHaveBeenCalled();
  });

  it('transient_horizon under the attempts cap → retriedLater, no markFailed', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow({ attempts: 1 })]);
    sdkMock.submitPayout.mockRejectedValue(new PayoutSubmitErrorMock('transient_horizon', 'blip'));
    const r = await runPayoutTick({ ...BASE_ARGS, maxAttempts: 5 });
    expect(r.retriedLater).toBe(1);
    expect(r.failed).toBe(0);
    expect(repoMocks.markPayoutFailed).not.toHaveBeenCalled();
  });

  it('transient_rebuild at the attempts cap → markFailed', async () => {
    // attempts=4 → after markSubmitted bumps, used=5. At cap → fail.
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow({ attempts: 4 })]);
    sdkMock.submitPayout.mockRejectedValue(
      new PayoutSubmitErrorMock('transient_rebuild', 'tx_bad_seq'),
    );
    const r = await runPayoutTick({ ...BASE_ARGS, maxAttempts: 5 });
    expect(r.failed).toBe(1);
    expect(repoMocks.markPayoutFailed).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-1' }));
  });

  // CF2-07 (2026-06-30 cold audit): `transient_horizon` at retry-exhaustion
  // is ambiguous — we don't know if the tx actually landed. Auto-
  // compensating without re-checking would re-credit a user who was
  // already paid. These pin the new authoritative re-check.
  describe('CF2-07: transient_horizon at retry-exhaustion re-checks before compensating', () => {
    it('landed=true → converges to confirmed instead of failing/compensating', async () => {
      repoMocks.listClaimablePayouts.mockResolvedValue([
        makeRow({ attempts: 4, kind: 'emission', assetCode: 'GBPLOOP' }),
      ]);
      sdkMock.submitPayout.mockRejectedValue(
        new PayoutSubmitErrorMock('transient_horizon', 'ambiguous timeout'),
      );
      // A fresh row-fetch reveals onSigned persisted a hash during THIS
      // ambiguous attempt, and Horizon confirms it actually landed.
      repoMocks.getPayoutForAdmin.mockResolvedValue({ id: 'p-1', txHash: 'tx-landed-after-all' });
      horizonMock.getOutboundPaymentByTxHash.mockImplementation(async (hash: string) =>
        hash === 'tx-landed-after-all' ? { landed: true } : null,
      );
      const r = await runPayoutTick({ ...BASE_ARGS, maxAttempts: 5 });
      // convergeConfirmed's outcome label for "idempotency check proved a
      // prior submit had already landed" is skippedAlreadyLanded, not
      // confirmed (that label is reserved for a fresh submit succeeding
      // in the same tick) — the important thing is it's NOT failed.
      expect(r.skippedAlreadyLanded).toBe(1);
      expect(r.failed).toBe(0);
      expect(repoMocks.markPayoutFailed).not.toHaveBeenCalled();
      expect(compensationMock.applyAdminPayoutCompensation).not.toHaveBeenCalled();
      expect(repoMocks.markPayoutConfirmed).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'p-1', txHash: 'tx-landed-after-all' }),
      );
    });

    it('landed=false → proceeds with the existing fail + auto-compensate path', async () => {
      repoMocks.listClaimablePayouts.mockResolvedValue([
        makeRow({ attempts: 4, kind: 'emission', assetCode: 'GBPLOOP' }),
      ]);
      sdkMock.submitPayout.mockRejectedValue(
        new PayoutSubmitErrorMock('transient_horizon', 'ambiguous timeout'),
      );
      repoMocks.getPayoutForAdmin.mockResolvedValue({ id: 'p-1', txHash: 'tx-never-landed' });
      horizonMock.getOutboundPaymentByTxHash.mockResolvedValue(null);
      const r = await runPayoutTick({ ...BASE_ARGS, maxAttempts: 5 });
      expect(r.failed).toBe(1);
      expect(repoMocks.markPayoutFailed).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'p-1' }),
      );
      expect(compensationMock.applyAdminPayoutCompensation).toHaveBeenCalled();
    });

    it('no fresh hash persisted → skips the check gracefully, proceeds to fail + compensate', async () => {
      repoMocks.listClaimablePayouts.mockResolvedValue([
        makeRow({ attempts: 4, kind: 'emission', assetCode: 'GBPLOOP' }),
      ]);
      sdkMock.submitPayout.mockRejectedValue(
        new PayoutSubmitErrorMock('transient_horizon', 'ambiguous timeout'),
      );
      repoMocks.getPayoutForAdmin.mockResolvedValue({ id: 'p-1', txHash: null });
      const r = await runPayoutTick({ ...BASE_ARGS, maxAttempts: 5 });
      expect(r.failed).toBe(1);
      expect(horizonMock.getOutboundPaymentByTxHash).not.toHaveBeenCalled();
      expect(compensationMock.applyAdminPayoutCompensation).toHaveBeenCalled();
    });

    it('the authoritative check itself failing → falls through to the existing fail path (no throw out of the tick)', async () => {
      repoMocks.listClaimablePayouts.mockResolvedValue([
        makeRow({ attempts: 4, kind: 'emission', assetCode: 'GBPLOOP' }),
      ]);
      sdkMock.submitPayout.mockRejectedValue(
        new PayoutSubmitErrorMock('transient_horizon', 'ambiguous timeout'),
      );
      repoMocks.getPayoutForAdmin.mockResolvedValue({ id: 'p-1', txHash: 'tx-check-degraded' });
      horizonMock.getOutboundPaymentByTxHash.mockRejectedValue(new Error('Horizon 503'));
      const r = await runPayoutTick({ ...BASE_ARGS, maxAttempts: 5 });
      expect(r.failed).toBe(1);
      expect(compensationMock.applyAdminPayoutCompensation).toHaveBeenCalled();
    });

    it('transient_rebuild (not ambiguous) at retry-exhaustion does NOT trigger the re-check at all', async () => {
      repoMocks.listClaimablePayouts.mockResolvedValue([
        makeRow({ attempts: 4, kind: 'emission', assetCode: 'GBPLOOP' }),
      ]);
      sdkMock.submitPayout.mockRejectedValue(
        new PayoutSubmitErrorMock('transient_rebuild', 'tx_bad_seq'),
      );
      const r = await runPayoutTick({ ...BASE_ARGS, maxAttempts: 5 });
      expect(r.failed).toBe(1);
      // getPayoutForAdmin is only called by the transient_horizon-specific
      // re-check — transient_rebuild has no landing ambiguity, so it must
      // never fire here.
      expect(repoMocks.getPayoutForAdmin).not.toHaveBeenCalled();
    });
  });

  it('terminal_no_trust immediately marks failed regardless of attempts', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow({ attempts: 0 })]);
    sdkMock.submitPayout.mockRejectedValue(
      new PayoutSubmitErrorMock('terminal_no_trust', 'op_no_trust'),
    );
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.failed).toBe(1);
    expect(repoMocks.markPayoutFailed).toHaveBeenCalled();
  });

  it('unclassified throw falls through to markFailed', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    sdkMock.submitPayout.mockRejectedValue(new Error('socket hang up'));
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.failed).toBe(1);
    expect(repoMocks.markPayoutFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'socket hang up' }),
    );
  });

  it('fires the Discord alert on terminal failure with the classified kind', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow({ attempts: 0 })]);
    sdkMock.submitPayout.mockRejectedValue(
      new PayoutSubmitErrorMock('terminal_no_trust', 'op_no_trust'),
    );
    await runPayoutTick(BASE_ARGS);
    expect(discordMock.notifyPayoutFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        payoutId: 'p-1',
        kind: 'terminal_no_trust',
        reason: 'op_no_trust',
        attempts: 1,
      }),
    );
  });

  it('fires the Discord alert for unclassified throws with kind=unclassified', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    sdkMock.submitPayout.mockRejectedValue(new Error('socket hang up'));
    await runPayoutTick(BASE_ARGS);
    expect(discordMock.notifyPayoutFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'unclassified',
        reason: 'socket hang up',
      }),
    );
  });

  it('does not fire the Discord alert on transient-retry outcomes', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow({ attempts: 1 })]);
    sdkMock.submitPayout.mockRejectedValue(new PayoutSubmitErrorMock('transient_horizon', 'blip'));
    await runPayoutTick({ ...BASE_ARGS, maxAttempts: 5 });
    expect(discordMock.notifyPayoutFailed).not.toHaveBeenCalled();
  });

  it('pre-check throw leaves the row untouched for a later retry', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    horizonMock.findOutboundPaymentByMemo.mockRejectedValue(new Error('Horizon 502'));
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.retriedLater).toBe(1);
    expect(repoMocks.markPayoutSubmitted).not.toHaveBeenCalled();
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
  });

  it('confirm race after submit counts as skippedRace (payment did land)', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    repoMocks.markPayoutConfirmed.mockResolvedValue(null);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.skippedRace).toBe(1);
    expect(r.confirmed).toBe(0);
  });

  it('processes rows in order (serialises to respect operator seq numbers)', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ id: 'p-1' }),
      makeRow({ id: 'p-2' }),
      makeRow({ id: 'p-3' }),
    ]);
    const submittedIds: string[] = [];
    sdkMock.submitPayout.mockImplementation(async (args: unknown) => {
      submittedIds.push((args as { intent: { memoText: string } }).intent.memoText);
      return { txHash: `tx-${submittedIds.length}`, ledger: null };
    });
    await runPayoutTick(BASE_ARGS);
    // All 3 rows submitted in the same memo (mock row uses 'order-abc'),
    // but the key invariant is we called submit 3 times, not in
    // parallel.
    expect(sdkMock.submitPayout).toHaveBeenCalledTimes(3);
  });

  it('honours the limit + watchdog args (passes through to listClaimablePayouts)', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([]);
    await runPayoutTick({ ...BASE_ARGS, limit: 3, watchdogStaleSeconds: 120 });
    expect(repoMocks.listClaimablePayouts).toHaveBeenCalledWith({
      limit: 3,
      staleSeconds: 120,
      maxAttempts: 5,
    });
  });

  it('defaults limit to 5 and watchdog staleSeconds to 300 when not given', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([]);
    await runPayoutTick(BASE_ARGS);
    expect(repoMocks.listClaimablePayouts).toHaveBeenCalledWith({
      limit: 5,
      staleSeconds: 300,
      maxAttempts: 5,
    });
  });

  // ─── A2-602 watchdog coverage ──────────────────────────────────

  it('A2-602 watchdog: stuck submitted row, prior submit landed → converges to confirmed via reclaim', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ state: 'submitted', attempts: 1 }),
    ]);
    horizonMock.findOutboundPaymentByMemo.mockResolvedValue({
      txHash: 'landed-tx',
      amount: '5.0000000',
      assetCode: 'GBPLOOP',
    });
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.skippedAlreadyLanded).toBe(1);
    // No second submit — idempotency check short-circuited.
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
    // Row is already 'submitted' so markPayoutSubmitted must NOT be
    // called — the guard expects state='pending' and would fail the
    // CAS. We go straight to confirm.
    expect(repoMocks.markPayoutSubmitted).not.toHaveBeenCalled();
    expect(repoMocks.markPayoutConfirmed).toHaveBeenCalledWith({
      id: 'p-1',
      txHash: 'landed-tx',
    });
  });

  it('A2-602 watchdog: stuck submitted row, prior submit NOT landed → reclaim + fresh submit + confirm', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ state: 'submitted', attempts: 1 }),
    ]);
    horizonMock.findOutboundPaymentByMemo.mockResolvedValue(null);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.confirmed).toBe(1);
    expect(repoMocks.reclaimSubmittedPayout).toHaveBeenCalledWith({
      id: 'p-1',
      expectedAttempts: 1,
    });
    // markPayoutSubmitted reserved for the pending-row path only.
    expect(repoMocks.markPayoutSubmitted).not.toHaveBeenCalled();
    expect(sdkMock.submitPayout).toHaveBeenCalledTimes(1);
    expect(repoMocks.markPayoutConfirmed).toHaveBeenCalledWith({
      id: 'p-1',
      txHash: 'tx-hash',
    });
  });

  it('A2-602 watchdog: reclaim race (another worker claimed it) → skippedRace, no submit', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ state: 'submitted', attempts: 1 }),
    ]);
    repoMocks.reclaimSubmittedPayout.mockResolvedValue(null);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.skippedRace).toBe(1);
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
  });

  // ─── CF-21: auto-compensation on terminal withdrawal failure ────────

  it('CF-21: a failed WITHDRAWAL payout auto-compensates the user', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ kind: 'emission', orderId: null, attempts: 0 }),
    ]);
    sdkMock.submitPayout.mockRejectedValue(
      new PayoutSubmitErrorMock('terminal_no_trust', 'op_no_trust'),
    );
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.failed).toBe(1);
    expect(repoMocks.markPayoutFailed).toHaveBeenCalled();
    // The user is re-credited via the ADR-024 §5 primitive: currency
    // derived from assetCode (GBPLOOP→GBP), amount = stroops/100_000.
    expect(compensationMock.applyAdminPayoutCompensation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u-1',
        currency: 'GBP',
        amountMinor: 500n,
        payoutId: 'p-1',
      }),
    );
  });

  it('CF-21: a failed ORDER_CASHBACK payout is NOT compensated (no net-negative balance)', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ kind: 'order_cashback', attempts: 0 }),
    ]);
    sdkMock.submitPayout.mockRejectedValue(
      new PayoutSubmitErrorMock('terminal_no_trust', 'op_no_trust'),
    );
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.failed).toBe(1);
    expect(compensationMock.applyAdminPayoutCompensation).not.toHaveBeenCalled();
  });

  it('CF-21: compensation is idempotent — AlreadyCompensatedError is swallowed (no throw)', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ kind: 'emission', orderId: null }),
    ]);
    sdkMock.submitPayout.mockRejectedValue(new PayoutSubmitErrorMock('terminal_no_trust', 'fail'));
    compensationMock.applyAdminPayoutCompensation.mockRejectedValue(
      new AlreadyCompensatedErrorMock('p-1'),
    );
    const r = await runPayoutTick(BASE_ARGS);
    // Still counts as failed; the AlreadyCompensated path is a no-op.
    expect(r.failed).toBe(1);
  });

  it('CF-21: a compensation throw does not abort the tick or change the outcome', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ kind: 'emission', orderId: null }),
      makeRow({ id: 'p-2', kind: 'emission', orderId: null }),
    ]);
    sdkMock.submitPayout.mockRejectedValue(new PayoutSubmitErrorMock('terminal_no_trust', 'fail'));
    // First compensation throws (cap hit); the second row must still be
    // processed (no abort).
    compensationMock.applyAdminPayoutCompensation
      .mockRejectedValueOnce(new Error('daily cap hit'))
      .mockResolvedValueOnce({
        id: 'comp-2',
        payoutId: 'p-2',
        userId: 'u-1',
        currency: 'GBP',
        amountMinor: 500n,
        priorBalanceMinor: 0n,
        newBalanceMinor: 500n,
        createdAt: new Date(),
      });
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.failed).toBe(2);
    expect(compensationMock.applyAdminPayoutCompensation).toHaveBeenCalledTimes(2);
  });

  it('CF-21: PayoutNotCompensableError is swallowed (precondition moved under us)', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ kind: 'emission', orderId: null }),
    ]);
    sdkMock.submitPayout.mockRejectedValue(new Error('socket hang up'));
    compensationMock.applyAdminPayoutCompensation.mockRejectedValue(
      new PayoutNotCompensableErrorMock('state changed'),
    );
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.failed).toBe(1);
  });

  // ─── CF-15: LOOP_KILL_EMISSIONS gates the worker ──────────────────

  it('CF-15: withdrawals-kill engaged → withdrawal rows skipped, order_cashback still drains', async () => {
    killMock.isKilled.mockImplementation((s: string) => s === 'emissions');
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ id: 'w-1', kind: 'emission', orderId: null, memoText: 'withdrawal-memo' }),
      makeRow({ id: 'c-1', kind: 'order_cashback', memoText: 'cashback-memo' }),
    ]);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.skippedKilled).toBe(1);
    // The order_cashback row still submits + confirms.
    expect(r.confirmed).toBe(1);
    expect(sdkMock.submitPayout).toHaveBeenCalledTimes(1);
    // The single submit was the cashback row, never the withdrawal one.
    expect(sdkMock.submitPayout).toHaveBeenCalledWith(
      expect.objectContaining({ intent: expect.objectContaining({ memoText: 'cashback-memo' }) }),
    );
    expect(sdkMock.submitPayout).not.toHaveBeenCalledWith(
      expect.objectContaining({ intent: expect.objectContaining({ memoText: 'withdrawal-memo' }) }),
    );
  });

  it('CF-15: withdrawals-kill OFF → withdrawal rows process normally', async () => {
    killMock.isKilled.mockReturnValue(false);
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ id: 'w-1', kind: 'emission', orderId: null }),
    ]);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.skippedKilled).toBe(0);
    expect(r.confirmed).toBe(1);
    expect(sdkMock.submitPayout).toHaveBeenCalledTimes(1);
  });

  it('CF-15: the kill switch is read once per tick (live process.env)', async () => {
    killMock.isKilled.mockImplementation((s: string) => s === 'emissions');
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ id: 'w-1', kind: 'emission', orderId: null }),
      makeRow({ id: 'w-2', kind: 'emission', orderId: null }),
    ]);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.skippedKilled).toBe(2);
    // One read per tick, not per row.
    expect(killMock.isKilled).toHaveBeenCalledTimes(1);
    expect(killMock.isKilled).toHaveBeenCalledWith('emissions');
    // No on-chain submit at all while engaged + only withdrawals queued.
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
  });
});

describe('ADR 036 — issuer-return burn rows', () => {
  it('skips the trustline probe and submits to the issuer destination', async () => {
    // Burn rows target the asset's ISSUER account, which never holds
    // a trustline to its own asset — probing would park the burn in
    // pending forever. payOne must bypass the probe for
    // toAddress === assetIssuer and submit directly; Stellar accepts
    // (and natively burns) an asset returned to its issuer.
    trustlinesMock.getAccountTrustlines.mockClear();
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({
        id: 'p-burn',
        kind: 'burn',
        orderId: 'o-redeemed',
        toAddress: 'GISSUER',
        assetIssuer: 'GISSUER',
      }),
    ]);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.confirmed).toBe(1);
    expect(trustlinesMock.getAccountTrustlines).not.toHaveBeenCalled();
    expect(discordMock.notifyPayoutAwaitingTrustline).not.toHaveBeenCalled();
    expect(sdkMock.submitPayout).toHaveBeenCalledTimes(1);
    const submitArg = sdkMock.submitPayout.mock.calls[0]?.[0] as {
      intent: { to: string; assetCode: string; assetIssuer: string };
    };
    expect(submitArg.intent.to).toBe('GISSUER');
    expect(submitArg.intent.assetIssuer).toBe('GISSUER');
    expect(repoMocks.markPayoutConfirmed).toHaveBeenCalledWith({
      id: 'p-burn',
      txHash: 'tx-hash',
    });
  });

  it('still probes the trustline for user-addressed (non-issuer) destinations', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.confirmed).toBe(1);
    expect(trustlinesMock.getAccountTrustlines).toHaveBeenCalledWith('GDESTINATION');
  });
});

describe('ADR 044 / S4-1 — payout channel accounts (sharding)', () => {
  it('zero channels configured (default): channelSecret is never passed to submitPayout — the exact pre-ADR-044 path', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ id: 'p-1', memoText: 'm1' }),
      makeRow({ id: 'p-2', memoText: 'm2' }),
      makeRow({ id: 'p-3', memoText: 'm3' }),
    ]);
    const r = await runPayoutTick(BASE_ARGS); // BASE_ARGS carries no `channels`
    expect(r.confirmed).toBe(3);
    expect(sdkMock.submitPayout).toHaveBeenCalledTimes(3);
    for (const call of sdkMock.submitPayout.mock.calls) {
      expect((call[0] as { channelSecret?: string }).channelSecret).toBeUndefined();
    }
  });

  it('an explicit empty channels array behaves identically to omitting channels', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow({ id: 'p-1' })]);
    const r = await runPayoutTick({ ...BASE_ARGS, channels: [] });
    expect(r.confirmed).toBe(1);
    expect(
      (sdkMock.submitPayout.mock.calls[0]?.[0] as { channelSecret?: string }).channelSecret,
    ).toBeUndefined();
  });

  it('shards a claimed batch across N channels round-robin by claim order', async () => {
    const channels = [
      { secret: 'SCHAN1', account: 'GCHAN1' },
      { secret: 'SCHAN2', account: 'GCHAN2' },
    ];
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ id: 'p-1', memoText: 'm1' }),
      makeRow({ id: 'p-2', memoText: 'm2' }),
      makeRow({ id: 'p-3', memoText: 'm3' }),
      makeRow({ id: 'p-4', memoText: 'm4' }),
    ]);
    const channelByMemo = new Map<string, string | undefined>();
    sdkMock.submitPayout.mockImplementation(async (args: unknown) => {
      const a = args as {
        intent: { memoText: string };
        channelSecret?: string;
        onSigned?: (h: string) => Promise<void> | void;
      };
      channelByMemo.set(a.intent.memoText, a.channelSecret);
      await a.onSigned?.(`tx-${a.intent.memoText}`);
      return { txHash: `tx-${a.intent.memoText}`, ledger: 1 };
    });
    const r = await runPayoutTick({ ...BASE_ARGS, channels });
    expect(r.confirmed).toBe(4);
    // Round-robin by claim order: p-1/p-3 → channel 0, p-2/p-4 → channel 1.
    expect(channelByMemo.get('m1')).toBe('SCHAN1');
    expect(channelByMemo.get('m2')).toBe('SCHAN2');
    expect(channelByMemo.get('m3')).toBe('SCHAN1');
    expect(channelByMemo.get('m4')).toBe('SCHAN2');
  });

  it('runs channel shards CONCURRENTLY, while each shard stays strictly serial internally', async () => {
    const channels = [
      { secret: 'SCHAN1', account: 'GCHAN1' },
      { secret: 'SCHAN2', account: 'GCHAN2' },
    ];
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ id: 'p-1', memoText: 'm1' }),
      makeRow({ id: 'p-2', memoText: 'm2' }),
      makeRow({ id: 'p-3', memoText: 'm3' }),
      makeRow({ id: 'p-4', memoText: 'm4' }),
    ]);
    const started: string[] = [];
    const resolvers = new Map<string, () => void>();
    sdkMock.submitPayout.mockImplementation(async (args: unknown) => {
      const a = args as {
        intent: { memoText: string };
        onSigned?: (h: string) => Promise<void> | void;
      };
      started.push(a.intent.memoText);
      await new Promise<void>((resolve) => resolvers.set(a.intent.memoText, resolve));
      await a.onSigned?.(`tx-${a.intent.memoText}`);
      return { txHash: `tx-${a.intent.memoText}`, ledger: 1 };
    });

    const tickPromise = runPayoutTick({ ...BASE_ARGS, channels });

    // Both shards' FIRST row (m1 on channel 0, m2 on channel 1) start
    // without waiting on each other — proves cross-shard concurrency.
    await vi.waitFor(
      () => {
        if (!started.includes('m1') || !started.includes('m2')) {
          throw new Error('both shards have not started their first row yet');
        }
      },
      { timeout: 2000, interval: 5 },
    );
    // Neither shard's SECOND row may have started — a shard must
    // finish its in-flight submit before starting its next one
    // (per-channel sequence isolation: never two in-flight submits on
    // the same channel).
    expect(started).not.toContain('m3');
    expect(started).not.toContain('m4');

    resolvers.get('m1')?.();
    resolvers.get('m2')?.();

    await vi.waitFor(
      () => {
        if (!started.includes('m3') || !started.includes('m4')) {
          throw new Error('shards have not started their second row yet');
        }
      },
      { timeout: 2000, interval: 5 },
    );

    resolvers.get('m3')?.();
    resolvers.get('m4')?.();

    const r = await tickPromise;
    expect(r.confirmed).toBe(4);
  });

  it('the emissions kill switch is still honoured per-row inside each shard', async () => {
    const channels = [
      { secret: 'SCHAN1', account: 'GCHAN1' },
      { secret: 'SCHAN2', account: 'GCHAN2' },
    ];
    killMock.isKilled.mockImplementation((s: string) => s === 'emissions');
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ id: 'p-1', kind: 'emission', memoText: 'm1' }),
      makeRow({ id: 'p-2', memoText: 'm2' }),
    ]);
    const r = await runPayoutTick({ ...BASE_ARGS, channels });
    expect(r.skippedKilled).toBe(1);
    expect(r.confirmed).toBe(1);
  });

  it('a claimed-but-unsubmitted row from a crashed tick is reclaimed on a later tick regardless of channel config', async () => {
    // A2-602 watchdog path: a row stuck in `submitted` past staleSeconds
    // is re-picked. This must keep working unchanged when channels are
    // configured — the reclaim/idempotency logic lives above the
    // sharding split and doesn't know about channels at all.
    const channels = [{ secret: 'SCHAN1', account: 'GCHAN1' }];
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ state: 'submitted', attempts: 1 }),
    ]);
    horizonMock.findOutboundPaymentByMemo.mockResolvedValue(null);
    const r = await runPayoutTick({ ...BASE_ARGS, channels });
    expect(r.confirmed).toBe(1);
    expect(repoMocks.reclaimSubmittedPayout).toHaveBeenCalledWith({
      id: 'p-1',
      expectedAttempts: 1,
    });
    // The reclaimed submit still routes through the configured channel.
    expect(
      (sdkMock.submitPayout.mock.calls[0]?.[0] as { channelSecret?: string }).channelSecret,
    ).toBe('SCHAN1');
  });

  describe('S4-1 follow-up: a rejecting shard is isolated (Promise.allSettled, not Promise.all)', () => {
    it('one shard throwing mid-tick does not prevent sibling shards from completing + reporting normally, and the rejection is logged (not silently swallowed)', async () => {
      const channels = [
        { secret: 'SCHAN1', account: 'GCHAN1' },
        { secret: 'SCHAN2', account: 'GCHAN2' },
      ];
      // Round-robin by claim order: p-1/p-3 → shard 0 (channel 1),
      // p-2/p-4 → shard 1 (channel 2).
      repoMocks.listClaimablePayouts.mockResolvedValue([
        makeRow({ id: 'p-1', memoText: 'm1' }),
        makeRow({ id: 'p-2', memoText: 'm2' }),
        makeRow({ id: 'p-3', memoText: 'm3' }),
        makeRow({ id: 'p-4', memoText: 'm4' }),
      ]);
      // Simulate an unexpected DB-layer throw on the row-claim step for
      // p-1 — this is one of the few `payOne` call sites NOT fenced in
      // try/catch (unlike the idempotency pre-check and submit paths),
      // so it is a realistic way for a shard's `runShard` loop to
      // reject rather than resolve to a `PayOutcome`.
      repoMocks.markPayoutSubmitted.mockImplementation(async (id: string) => {
        if (id === 'p-1') {
          throw new Error('simulated DB connection drop during claim');
        }
        return { id };
      });

      const r = await runPayoutTick({ ...BASE_ARGS, channels });

      // Shard 0 died on its first row (p-1) and never reached p-3.
      // Shard 1 (p-2, p-4) ran to completion and is reflected in the
      // tick's reported counts — proving isolation, not just "the
      // process didn't crash."
      expect(r.confirmed).toBe(2);
      const submittedMemos = sdkMock.submitPayout.mock.calls.map(
        (call) => (call[0] as { intent: { memoText: string } }).intent.memoText,
      );
      expect(submittedMemos.sort()).toEqual(['m2', 'm4']);

      // The rejection is surfaced via a structured log.error, not
      // swallowed — with enough context (shard index, channel account,
      // the row IDs owned by the dead shard) to diagnose which rows
      // need re-picking.
      expect(logMock.error).toHaveBeenCalledWith(
        expect.objectContaining({
          shardIndex: 0,
          shardChannelAccount: 'GCHAN1',
          shardRowIds: ['p-1', 'p-3'],
          err: expect.any(Error),
        }),
        expect.stringContaining('Payout channel shard threw'),
      );

      // Health/reporting posture: the tick as a whole still "succeeds"
      // (sibling shards completed) — this is what `Promise.allSettled`
      // buys over `Promise.all`, which would have rejected the whole
      // tick and lost the successful shard's counts.
    });

    it('the A8 leader lock is not released until every shard — including the rejecting one — has settled', async () => {
      // Regression guard for the bug this follow-up closes: with
      // `Promise.all`, the tick body's promise would reject (and
      // `withAdvisoryLock` would release the lock) as soon as the
      // FIRST shard rejects, even while a sibling shard's submit is
      // still in flight. `runPayoutTick`'s return only resolves once
      // `withAdvisoryLock`'s callback has fully settled, so asserting
      // that `runPayoutTick` doesn't resolve until the slow sibling
      // shard's in-flight submit completes is an end-to-end proof that
      // the lock-holding window now covers the full tick.
      const channels = [
        { secret: 'SCHAN1', account: 'GCHAN1' },
        { secret: 'SCHAN2', account: 'GCHAN2' },
      ];
      repoMocks.listClaimablePayouts.mockResolvedValue([
        makeRow({ id: 'p-1', memoText: 'm1' }),
        makeRow({ id: 'p-2', memoText: 'm2' }),
      ]);
      repoMocks.markPayoutSubmitted.mockImplementation(async (id: string) => {
        if (id === 'p-1') {
          throw new Error('simulated claim failure');
        }
        return { id };
      });
      let resolveSlowSubmit: (() => void) | undefined;
      sdkMock.submitPayout.mockImplementation(async (args: unknown) => {
        const a = args as {
          intent: { memoText: string };
          onSigned?: (h: string) => Promise<void> | void;
        };
        if (a.intent.memoText === 'm2') {
          await new Promise<void>((resolve) => {
            resolveSlowSubmit = resolve;
          });
        }
        await a.onSigned?.(`tx-${a.intent.memoText}`);
        return { txHash: `tx-${a.intent.memoText}`, ledger: 1 };
      });

      const tickPromise = runPayoutTick({ ...BASE_ARGS, channels });

      // Give the rejecting shard (p-1) every opportunity to reject and
      // the tick promise every opportunity to resolve prematurely
      // before the still-in-flight sibling submit (m2) completes.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await vi.waitFor(() => {
        if (resolveSlowSubmit === undefined) {
          throw new Error('sibling shard has not reached its submit yet');
        }
      });
      let settled = false;
      void tickPromise.then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);

      resolveSlowSubmit?.();
      const r = await tickPromise;
      expect(r.confirmed).toBe(1);
    });
  });
});

describe('ADR 031 — interest_mint rows sign with the issuer keypair', () => {
  // Real ed25519 material: the assertion is cryptographic — the
  // secret handed to submitPayout must DERIVE the row's pinned
  // issuer account, not merely equal some configured string.
  const issuerKp = Keypair.random();
  const operatorKp = Keypair.random();
  const ISSUER_ARGS = {
    ...BASE_ARGS,
    operatorSecret: operatorKp.secret(),
    operatorAccount: operatorKp.publicKey(),
    issuerSigners: new Map([
      ['GBPLOOP', { secret: issuerKp.secret(), account: issuerKp.publicKey() }],
    ]),
  };

  function makeMintRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return makeRow({
      id: 'p-mint',
      kind: 'interest_mint',
      orderId: null,
      assetCode: 'GBPLOOP',
      assetIssuer: issuerKp.publicKey(),
      toAddress: 'GDESTINATION',
      ...overrides,
    });
  }

  function trustDestination(): void {
    // The default trustlines mock keys on `GBPLOOP::GISSUER`; mint
    // rows pin the real issuer pubkey, so give the destination the
    // matching trustline explicitly.
    trustlinesMock.getAccountTrustlines.mockImplementation(async (account: string) => ({
      account,
      accountExists: true,
      trustlines: new Map([
        [`GBPLOOP::${issuerKp.publicKey()}`, { code: 'GBPLOOP', issuer: issuerKp.publicKey() }],
      ]),
      asOfMs: Date.now(),
    }));
  }

  it('submits with the issuer secret (keypair derivation matches the pinned issuer)', async () => {
    trustDestination();
    repoMocks.listClaimablePayouts.mockResolvedValue([makeMintRow()]);
    const r = await runPayoutTick(ISSUER_ARGS);
    expect(r.confirmed).toBe(1);
    const submitArg = sdkMock.submitPayout.mock.calls[0]?.[0] as { secret: string };
    // Cryptographic check: the signing secret derives the issuer
    // account — an issuer payment is a mint; any other key would
    // transfer from an unrelated account.
    expect(Keypair.fromSecret(submitArg.secret).publicKey()).toBe(issuerKp.publicKey());
    expect(submitArg.secret).not.toBe(ISSUER_ARGS.operatorSecret);
  });

  it('runs the idempotency pre-check against the ISSUER account, not the operator', async () => {
    trustDestination();
    repoMocks.listClaimablePayouts.mockResolvedValue([makeMintRow()]);
    await runPayoutTick(ISSUER_ARGS);
    expect(horizonMock.findOutboundPaymentByMemo).toHaveBeenCalledWith(
      expect.objectContaining({ account: issuerKp.publicKey() }),
    );
  });

  it('operator-kind rows in the same tick keep the operator path byte-identical', async () => {
    trustDestination();
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ id: 'p-cash', assetIssuer: issuerKp.publicKey() }),
      makeMintRow(),
    ]);
    const r = await runPayoutTick(ISSUER_ARGS);
    expect(r.confirmed).toBe(2);
    const secrets = sdkMock.submitPayout.mock.calls.map((c) => (c[0] as { secret: string }).secret);
    expect(secrets[0]).toBe(operatorKp.secret()); // order_cashback → operator
    expect(secrets[1]).toBe(issuerKp.secret()); // interest_mint → issuer
    const precheckAccounts = horizonMock.findOutboundPaymentByMemo.mock.calls.map(
      (c) => (c[0] as { account: string }).account,
    );
    expect(precheckAccounts).toEqual([operatorKp.publicKey(), issuerKp.publicKey()]);
  });

  it('missing issuer signer → retriedLater: no claim, no submit, row stays pending', async () => {
    trustDestination();
    repoMocks.listClaimablePayouts.mockResolvedValue([makeMintRow()]);
    const r = await runPayoutTick({ ...ISSUER_ARGS, issuerSigners: new Map() });
    expect(r.retriedLater).toBe(1);
    expect(repoMocks.markPayoutSubmitted).not.toHaveBeenCalled();
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
    expect(repoMocks.markPayoutFailed).not.toHaveBeenCalled();
  });

  it('signer whose account mismatches the row-pinned issuer → retriedLater (never signs with the wrong key)', async () => {
    trustDestination();
    const otherKp = Keypair.random();
    repoMocks.listClaimablePayouts.mockResolvedValue([makeMintRow()]);
    const r = await runPayoutTick({
      ...ISSUER_ARGS,
      issuerSigners: new Map([
        ['GBPLOOP', { secret: otherKp.secret(), account: otherKp.publicKey() }],
      ]),
    });
    expect(r.retriedLater).toBe(1);
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
  });

  it('interest_mint destinations are user wallets — the trustline probe still applies', async () => {
    trustlinesMock.getAccountTrustlines.mockImplementationOnce(async (account: string) => ({
      account,
      accountExists: true,
      trustlines: new Map(), // no GBPLOOP trustline
      asOfMs: Date.now(),
    }));
    repoMocks.listClaimablePayouts.mockResolvedValue([makeMintRow()]);
    const r = await runPayoutTick(ISSUER_ARGS);
    expect(r.retriedLater).toBe(1);
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
    expect(discordMock.notifyPayoutAwaitingTrustline).toHaveBeenCalledOnce();
  });

  it('ADR 044 × ADR 031: an interest_mint routed through a channel signs with the ISSUER secret AND the channelSecret (orthogonal — the channel is the tx source, the issuer is the payment funder/minter)', async () => {
    trustDestination();
    repoMocks.listClaimablePayouts.mockResolvedValue([makeMintRow()]);
    const r = await runPayoutTick({
      ...ISSUER_ARGS,
      channels: [{ secret: 'SCHAN1', account: 'GCHAN1' }],
    });
    expect(r.confirmed).toBe(1);
    const submitArg = sdkMock.submitPayout.mock.calls[0]?.[0] as {
      secret: string;
      channelSecret?: string;
    };
    // `secret` (the payment funder = mint source) is still the ISSUER,
    // untouched by channel plumbing — signer resolution is independent
    // of channel assignment.
    expect(Keypair.fromSecret(submitArg.secret).publicKey()).toBe(issuerKp.publicKey());
    // The channel is the tx source that owns the sequence number + pays
    // the fee — threaded through orthogonally.
    expect(submitArg.channelSecret).toBe('SCHAN1');
    // Idempotency pre-check still scans the ISSUER account (the funder),
    // not the channel.
    expect(horizonMock.findOutboundPaymentByMemo).toHaveBeenCalledWith(
      expect.objectContaining({ account: issuerKp.publicKey() }),
    );
  });
});
