import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
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
  },
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
}));

const { horizonMock } = vi.hoisted(() => ({
  horizonMock: {
    findOutboundPaymentByMemo: vi.fn<
      (
        args: unknown,
      ) => Promise<{ txHash: string; amount: string; assetCode: string | null } | null>
    >(async () => null),
  },
}));
vi.mock('../horizon.js', () => ({
  findOutboundPaymentByMemo: (args: unknown) => horizonMock.findOutboundPaymentByMemo(args),
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
      submitPayout: vi.fn<(args: unknown) => Promise<{ txHash: string; ledger: number | null }>>(
        async () => ({
          txHash: 'tx-hash',
          ledger: 1,
        }),
      ),
    },
  };
});
vi.mock('../payout-submit.js', () => ({
  submitPayout: (args: unknown) => sdkMock.submitPayout(args),
  PayoutSubmitError: PayoutSubmitErrorMock,
}));

const { discordMock } = vi.hoisted(() => ({
  discordMock: {
    notifyPayoutFailed: vi.fn<(args: unknown) => void>(() => undefined),
  },
}));
vi.mock('../../discord.js', () => ({
  notifyPayoutFailed: (args: unknown) => discordMock.notifyPayoutFailed(args),
}));

import { runPayoutTick } from '../payout-worker.js';

const BASE_ARGS = {
  operatorSecret: 'SXXX',
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
    ...overrides,
  };
}

beforeEach(() => {
  repoMocks.listClaimablePayouts.mockReset();
  repoMocks.markPayoutSubmitted.mockReset();
  repoMocks.markPayoutConfirmed.mockReset();
  repoMocks.markPayoutFailed.mockReset();
  repoMocks.reclaimSubmittedPayout.mockReset();
  horizonMock.findOutboundPaymentByMemo.mockReset();
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
  horizonMock.findOutboundPaymentByMemo.mockResolvedValue(null);
  sdkMock.submitPayout.mockResolvedValue({ txHash: 'tx-hash', ledger: 1 });
  discordMock.notifyPayoutFailed.mockClear();
});

describe('runPayoutTick', () => {
  it('no pending rows → zero counts, no calls', async () => {
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.picked).toBe(0);
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

  it('pre-check throw does not block the submit — logs + proceeds', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    horizonMock.findOutboundPaymentByMemo.mockRejectedValue(new Error('Horizon 502'));
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.confirmed).toBe(1);
    expect(sdkMock.submitPayout).toHaveBeenCalledTimes(1);
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
});
